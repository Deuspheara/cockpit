import type { Sql, TransactionSql } from "postgres";
import { Decimal, money } from "../../shared/decimal.js";
import type { Coverage, ValuationIssue } from "./coverage.js";
import { chartInterval } from "./sampling.js";
import type { Range } from "./service.js";
import { manualAccountHistory } from "./manual-history.js";
export interface HistoricalValue {
  accountId: string;
  at: string;
  value: string | null;
  complete: boolean;
  coverage: Partial<Coverage>;
  source: string;
}
export function aggregateHistory(
  rows: HistoricalValue[],
  accounts: { id: string; name: string }[],
  range: Range,
) {
  const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
  const interval = chartInterval(
    range,
    sorted.map((r) => ({ ...r, value: r.value ?? "0" })),
  );
  const buckets = new Map<number, Map<string, HistoricalValue>>();
  for (const row of sorted) {
    const bucket = Math.floor(Date.parse(row.at) / interval) * interval;
    const values = buckets.get(bucket) ?? new Map<string, HistoricalValue>();
    const old = values.get(row.accountId);
    // Prefer the latest observation, then recorded observations over reconstructed history.
    if (
      !old ||
      row.at > old.at ||
      (row.at === old.at && row.source === "recorded_snapshot")
    )
      values.set(row.accountId, row);
    buckets.set(bucket, values);
  }
  let priorKey = "",
    priorAt = 0,
    segment = 0;
  return [...buckets.entries()]
    .filter(([, values]) => [...values.values()].some((v) => v.value !== null))
    .map(([at, values]) => {
      const missing: ValuationIssue[] = [];
      const keys: string[] = [];
      let complete = true;
      for (const account of accounts) {
        const row = values.get(account.id);
        if (!row) {
          complete = false;
          missing.push({
            code: "missing_history",
            accountId: account.id,
            name: account.name,
            message: "No recorded value in this time bucket",
            retryable: false,
          });
        } else {
          complete &&= row.complete;
          if (row.value !== null)
            keys.push(
              `${account.id}:${row.complete ? "*" : [...(row.coverage.valued ?? [])].sort().join(",")}`,
            );
          missing.push(
            ...(row.coverage.missing ?? []).map((issue) => ({
              ...issue,
              retryable:
                issue.retryable &&
                (issue.code === "missing_fx" ||
                  row.source === "alchemy_dated_balances"),
              retryAction:
                issue.code === "missing_fx"
                  ? ("fx" as const)
                  : ("history" as const),
            })),
          );
        }
      }
      const coverageKey = keys.sort().join("|");
      if (coverageKey !== priorKey || at - priorAt > interval * 1.5) segment++;
      priorKey = coverageKey;
      priorAt = at;
      return {
        at: new Date(at).toISOString(),
        sourceAt: [...values.values()]
          .map((v) => v.at)
          .sort()
          .at(-1)!,
        value: money(
          [...values.values()].reduce(
            (sum, v) => sum.plus(v.value ?? 0),
            new Decimal(0),
          ),
        ),
        complete,
        coverageKey,
        segmentId: String(segment),
        coverage: { valued: keys, missing },
        source: "dated_account_values",
      };
    });
}
export async function valuationHistory(
  sql: Sql | TransactionSql,
  accounts: { id: string; name: string; sourceType?: string }[],
  since: Date,
  currency: string,
  range: Range,
) {
  if (!accounts.length) return [];
  const ledgerAccounts = await sql<{ accountId: string }[]>`
    SELECT DISTINCT account_id FROM transactions
    WHERE account_id IN ${sql(accounts.map((account) => account.id))} AND NOT is_voided`;
  const ledgerIds = new Set(ledgerAccounts.map((row) => row.accountId));
  const manual = accounts.filter(
    (account) => account.sourceType === "manual" && ledgerIds.has(account.id),
  );
  const providerAccounts = accounts.filter(
    (account) =>
      !manual.some((manualAccount) => manualAccount.id === account.id),
  );
  const ids = providerAccounts.map((a) => a.id);
  const rows = ids.length
    ? await sql<
        {
          accountId: string;
          at: Date;
          value: string | null;
          complete: boolean;
          coverage: Partial<Coverage>;
          source: string;
        }[]
      >`
    SELECT v.account_id,b.captured_at AS at,v.total_value::text AS value,v.complete,v.coverage,'recorded_snapshot' AS source
    FROM account_valuations v JOIN valuation_batches b ON b.id=v.batch_id
    WHERE v.account_id IN ${sql(ids)} AND b.base_currency=${currency} AND b.captured_at>=${since}
    UNION ALL
    SELECT h.account_id,h.at,(h.value * CASE WHEN h.currency=${currency} THEN 1 ELSE fx.rate END)::text AS value,
      h.complete AND (h.currency=${currency} OR fx.rate IS NOT NULL) AS complete,
      CASE WHEN h.currency<>${currency} AND fx.rate IS NULL THEN jsonb_build_object('valued','[]'::jsonb,'missing',
        COALESCE(h.coverage->'missing','[]'::jsonb) || jsonb_build_array(jsonb_build_object('code','missing_fx','accountId',h.account_id,'name','Currency conversion','message','Historical conversion unavailable','retryable',true))) ELSE h.coverage END AS coverage,h.source
    FROM (
      SELECT account_id,at,equity AS value,currency,true AS complete,'{}'::jsonb AS coverage,'provider_equity_with_dated_fx' AS source FROM provider_account_history
      UNION ALL SELECT account_id,at,value,currency,complete,coverage,source FROM evm_account_history
    ) h
    LEFT JOIN LATERAL (SELECT rate FROM fx_quotes q WHERE q.base_currency=h.currency AND q.quote_currency=${currency}
      AND q.quoted_at<=h.at AND q.quoted_at>h.at-interval '7 days' ORDER BY q.quoted_at DESC LIMIT 1) fx ON true
    WHERE h.account_id IN ${sql(ids)} AND h.at>=${since}
    ORDER BY at`
    : [];
  const manualRows = await manualAccountHistory(sql, manual, since, currency);
  return aggregateHistory(
    [...rows.map((r) => ({ ...r, at: r.at.toISOString() })), ...manualRows],
    accounts,
    range,
  );
}

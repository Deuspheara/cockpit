import { sampleChart } from "./sampling.js";
import type { Range } from "./service.js";
import type { Sql, TransactionSql } from "postgres";
import { Decimal, money } from "../../shared/decimal.js";
// Provider equity is an observed account value, not quantity today multiplied by old prices.
export async function providerHistory(
  sql: Sql | TransactionSql,
  accountIds: string[],
  since: Date,
  currency: string,
) {
  if (!accountIds.length) return [];
  const rows = await sql<
    {
      at: Date;
      accountId: string;
      equity: string;
      rate: string | null;
      source: string;
      resolution: string;
    }[]
  >`
 SELECT h.account_id,h.at,h.equity,h.source,h.resolution,
   CASE WHEN h.currency=${currency} THEN '1' ELSE fx.rate::text END AS rate
 FROM provider_account_history h
 LEFT JOIN LATERAL (SELECT rate FROM fx_quotes q WHERE q.base_currency=h.currency AND q.quote_currency=${currency}
   AND q.quoted_at<=h.at AND q.quoted_at>h.at-interval '7 days' ORDER BY q.quoted_at DESC LIMIT 1) fx ON true
 WHERE h.account_id IN ${sql(accountIds)} AND h.at>=${since} ORDER BY h.at`;
  const buckets = new Map<
    string,
    Map<string, { value: Decimal; source: string }>
  >();
  for (const row of rows) {
    if (row.rate === null) continue;
    const at = row.at.toISOString();
    const bucket = buckets.get(at) ?? new Map();
    bucket.set(row.accountId, {
      value: new Decimal(row.equity).mul(row.rate),
      source: row.source,
    });
    buckets.set(at, bucket);
  }
  return [...buckets.entries()]
    .filter(([, accounts]) => accounts.size === accountIds.length)
    .map(([at, accounts]) => ({
      at,
      value: money(
        [...accounts.values()].reduce(
          (sum, a) => sum.plus(a.value),
          new Decimal(0),
        ),
      ),
      source: "provider_equity_with_dated_fx",
    }));
}

export async function tradingPerformance(
  sql: Sql | TransactionSql,
  accountId: string,
  since: Date,
  range: Range,
) {
  const rows = await sql<
    {
      at: Date;
      equity: string;
      totalPnl: string;
      netTransfers: string;
      currency: string;
      source: string;
    }[]
  >`SELECT DISTINCT ON(at) at,equity,total_pnl,net_transfers,currency,source FROM provider_account_history WHERE account_id=${accountId} AND at>=${since} ORDER BY at,resolution DESC`;
  const latest = rows.at(-1);
  if (!latest) return null;
  return {
    currency: latest.currency,
    source: latest.source,
    asOf: latest.at.toISOString(),
    equity: money(latest.equity),
    totalPnl: money(latest.totalPnl),
    netTransfers: money(latest.netTransfers),
    chart: sampleChart(
      rows.map((p) => ({
        at: p.at.toISOString(),
        value: money(p.totalPnl),
      })),
      range,
    ),
  };
}

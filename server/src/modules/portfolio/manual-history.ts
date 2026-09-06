import type { Sql, TransactionSql } from "postgres";
import { Decimal, money } from "../../shared/decimal.js";
import type { HistoricalValue } from "./valuation-history.js";

interface LedgerRow {
  accountId: string;
  assetId: string;
  securityId: string | null;
  assetName: string;
  assetType: string;
  quoteCurrency: string;
  type: string;
  occurredAt: Date;
  quantity: string;
  netCashAmount: string | null;
  transactionCurrency: string;
}
interface PriceRow {
  securityId: string;
  marketDate: string;
  close: string;
  currency: string;
  unitMultiplier: string;
}
interface FxRow {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  quotedAt: Date;
}

const decreases = new Set(["SELL", "WITHDRAWAL", "TRANSFER_OUT", "FEE"]);
const dayMs = 86400000;

export async function manualAccountHistory(
  sql: Sql | TransactionSql,
  accounts: { id: string; name: string }[],
  since: Date,
  currency: string,
): Promise<HistoricalValue[]> {
  if (!accounts.length) return [];
  const ids = accounts.map((account) => account.id);
  const [ledger, prices, fx, corporateStates] = await Promise.all([
    sql<LedgerRow[]>`
      SELECT t.account_id,t.asset_id,a.security_id,a.name AS asset_name,a.asset_type,
        a.quote_currency,t.type,t.occurred_at,t.quantity,t.net_cash_amount,
        t.currency AS transaction_currency
      FROM transactions t JOIN assets a ON a.id=t.asset_id
      WHERE t.account_id IN ${sql(ids)} AND NOT t.is_voided
      ORDER BY t.occurred_at,t.id`,
    sql<PriceRow[]>`
      SELECT l.security_id,p.market_date::text,p.close,p.currency,p.unit_multiplier
      FROM market_prices p JOIN provider_mappings m ON m.id=p.mapping_id
      JOIN security_listings l ON l.id=m.listing_id
      JOIN securities s ON s.id=l.security_id AND s.preferred_mapping_id=m.id
      WHERE p.market_date>=${since.toISOString().slice(0, 10)}::date
        OR p.market_date>=(
          SELECT coalesce(min(t.occurred_at)::date,${since.toISOString().slice(0, 10)}::date)
          FROM transactions t JOIN assets a ON a.id=t.asset_id
          WHERE a.security_id=l.security_id AND NOT t.is_voided
        )
      ORDER BY l.security_id,p.market_date`,
    sql<FxRow[]>`
      SELECT base_currency,quote_currency,rate,quoted_at FROM fx_quotes
      WHERE quoted_at>=${new Date(since.getTime() - 7 * dayMs)}
      ORDER BY quoted_at`,
    sql<{ securityId: string; actionDate: string | null }[]>`
      SELECT security_id,metadata->>'corporateActionDate' AS action_date
      FROM market_data_state
      WHERE stage='history' AND error_class='corporate_action_review'`,
  ]);
  const actionDates = new Map(
    corporateStates.flatMap((row) =>
      row.actionDate ? [[row.securityId, row.actionDate] as const] : [],
    ),
  );
  const fxRate = (from: string, day: string) => {
    if (from === currency) return new Decimal(1);
    const at = Date.parse(`${day}T23:59:59Z`);
    const latest = (base: string, quoteCurrency: string) =>
      fx
        .filter(
          (row) =>
            row.baseCurrency === base &&
            row.quoteCurrency === quoteCurrency &&
            row.quotedAt.getTime() <= at &&
            at - row.quotedAt.getTime() <= 7 * dayMs,
        )
        .at(-1);
    const direct = latest(from, currency);
    if (direct) return new Decimal(direct.rate);
    const throughEur = latest(from, "EUR");
    const fromEur = latest("EUR", currency);
    return throughEur && fromEur
      ? new Decimal(throughEur.rate).mul(fromEur.rate)
      : null;
  };
  const start = Math.max(
    since.getTime(),
    Math.min(
      ...ledger.map((row) => row.occurredAt.getTime()),
      new Date().getTime(),
    ),
  );
  const end = Date.now();
  const result: HistoricalValue[] = [];
  for (
    let at = Date.UTC(
      new Date(start).getUTCFullYear(),
      new Date(start).getUTCMonth(),
      new Date(start).getUTCDate(),
    );
    at <= end;
    at += dayMs
  ) {
    const day = new Date(at).toISOString().slice(0, 10);
    const endOfDay = at + dayMs;
    for (const account of accounts) {
      const transactions = ledger.filter(
        (row) =>
          row.accountId === account.id && row.occurredAt.getTime() < endOfDay,
      );
      if (!transactions.length) continue;
      let total = new Decimal(0);
      let complete = true;
      const valued: string[] = [];
      const missing: HistoricalValue["coverage"]["missing"] = [];
      const securityIds: string[] = [
        ...new Set(
          transactions.flatMap((row) =>
            row.assetType !== "cash" && row.securityId ? [row.securityId] : [],
          ),
        ),
      ];
      for (const securityId of securityIds) {
        const rows = transactions.filter(
          (row) => row.securityId === securityId,
        );
        const quantity = rows.reduce(
          (sum, row) =>
            decreases.has(row.type)
              ? sum.minus(row.quantity)
              : sum.plus(row.quantity),
          new Decimal(0),
        );
        if (quantity.isZero()) continue;
        const actionDate = actionDates.get(securityId);
        const price = prices
          .filter(
            (row) =>
              row.securityId === securityId &&
              row.marketDate <= day &&
              Date.parse(`${day}T00:00:00Z`) -
                Date.parse(`${row.marketDate}T00:00:00Z`) <=
                7 * dayMs,
          )
          .at(-1);
        const name = rows[0]!.assetName;
        if (!price || (actionDate && day >= actionDate)) {
          complete = false;
          missing?.push({
            code:
              actionDate && day >= actionDate
                ? "corporate_action_review"
                : "missing_price",
            accountId: account.id,
            assetId: rows[0]!.assetId,
            name,
            message:
              actionDate && day >= actionDate
                ? "A possible quantity-changing corporate action needs review"
                : "No usable EOD price is available for this date",
            retryable: !actionDate,
          });
          continue;
        }
        const rate = fxRate(price.currency, day);
        if (!rate) {
          complete = false;
          missing?.push({
            code: "missing_fx",
            accountId: account.id,
            assetId: rows[0]!.assetId,
            name,
            message: `No dated ${price.currency}/${currency} conversion is available`,
            retryable: true,
          });
          continue;
        }
        total = total.plus(
          quantity.mul(price.close).mul(price.unitMultiplier).mul(rate),
        );
        valued.push(securityId);
      }
      const legacy = transactions.filter(
        (row) => row.assetType !== "cash" && !row.securityId,
      );
      for (const row of legacy) {
        complete = false;
        missing?.push({
          code: "missing_price",
          accountId: account.id,
          assetId: row.assetId,
          name: row.assetName,
          message: "This asset has no shared ISIN market-data identity",
          retryable: false,
        });
      }
      const cashRows = transactions.filter((row) => row.assetType === "cash");
      const currencies = new Set([
        ...cashRows.map((row) => row.quoteCurrency),
        ...transactions.flatMap((row) =>
          row.netCashAmount !== null ? [row.transactionCurrency] : [],
        ),
      ]);
      for (const cashCurrency of currencies) {
        let cash = cashRows
          .filter((row) => row.quoteCurrency === cashCurrency)
          .reduce(
            (sum, row) =>
              decreases.has(row.type)
                ? sum.minus(row.quantity)
                : sum.plus(row.quantity),
            new Decimal(0),
          );
        for (const row of transactions)
          if (
            row.assetType !== "cash" &&
            row.transactionCurrency === cashCurrency &&
            row.netCashAmount !== null
          )
            cash = cash.plus(row.netCashAmount);
        if (cash.isZero()) continue;
        const rate = fxRate(cashCurrency, day);
        if (!rate) {
          complete = false;
          missing?.push({
            code: "missing_fx",
            accountId: account.id,
            name: `${cashCurrency} cash`,
            message: `No dated ${cashCurrency}/${currency} conversion is available`,
            retryable: true,
          });
        } else total = total.plus(cash.mul(rate));
      }
      result.push({
        accountId: account.id,
        at: `${day}T00:00:00.000Z`,
        value: money(total),
        complete,
        coverage: { valued, missing: missing ?? [] },
        source: "manual_ledger_eod",
      });
    }
  }
  return result;
}

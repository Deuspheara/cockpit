import { sampleChart } from "./sampling.js";
import { providerHistory } from "./history.js";
import { visibleAccounts } from "../accounts/visibility.js";
import type { Sql, TransactionSql } from "postgres";
import { Decimal, money } from "../../shared/decimal.js";
import { ledgerQuantity, ledgerCost, type PositionView } from "./projection.js";
import type { Account } from "../accounts/schemas.js";
import type { Asset } from "../assets/service.js";
import type { Transaction } from "../ledger/schemas.js";
import { z } from "zod";
export const rangeSchema = z.enum(["1d", "1w", "3w", "1m", "3m", "1y", "all"]);
export const scopeSchema = z.enum(["global", "crypto", "equities", "other"]);
export type Range = z.infer<typeof rangeSchema>;
export type Scope = z.infer<typeof scopeSchema>;
const rangeDays: Record<Range, number> = {
  "1d": 1,
  "1w": 7,
  "3w": 21,
  "1m": 30,
  "3m": 90,
  "1y": 365,
  all: 36500,
};
interface Observation {
  accountId: string;
  assetId: string;
  observedAt: Date;
  quantity: string;
  unitPrice: string | null;
  marketValue: string | null;
  currency: string;
  costBasis: string | null;
  source: string;
  unrealizedPnl: string | null;
  realizedPnl: string | null;
  metadata: Record<string, unknown>;
  side: "long" | "short" | null;
  entryPrice: string | null;
  leverage: string | null;
  liquidationPrice: string | null;
}
interface Quote {
  assetId: string;
  price: string;
  currency: string;
  quotedAt: Date;
  source: string;
}
export class PortfolioService {
  constructor(private database: { sql: Sql | TransactionSql }) {}
  async positions(accountId?: string): Promise<Map<string, PositionView[]>> {
    const [accounts, assets, transactions, observations, quotes] =
      await Promise.all([
        this.database.sql<
          Account[]
        >`SELECT * FROM accounts WHERE NOT is_archived`,
        this.database.sql<Asset[]>`SELECT * FROM assets`,
        this.database.sql<
          Transaction[]
        >`SELECT * FROM transactions WHERE NOT is_voided ORDER BY occurred_at,id`,
        this.database.sql<
          Observation[]
        >`SELECT DISTINCT ON(account_id,asset_id) * FROM holding_observations ORDER BY account_id,asset_id,observed_at DESC,created_at DESC,id DESC`,
        this.database.sql<
          Quote[]
        >`SELECT DISTINCT ON(asset_id) * FROM price_quotes ORDER BY asset_id,quoted_at DESC,id DESC`,
      ]);
    const result = new Map<string, PositionView[]>();
    for (const a of accounts.filter((a) => !accountId || a.id === accountId)) {
      const positions: PositionView[] = [];
      for (const asset of assets) {
        const ledger = transactions.filter(
          (t) => t.accountId === a.id && t.assetId === asset.id,
        );
        const observed = observations.find(
          (o) => o.accountId === a.id && o.assetId === asset.id,
        );
        const useLedger = a.sourceType === "manual" && ledger.length > 0;
        if (!useLedger && !observed) continue;
        let quantity = useLedger
          ? ledgerQuantity(ledger)
          : money(observed!.quantity);
        // Cash ledger quantities also include trade settlement, when an explicit cash line exists.
        if (useLedger && asset.assetType === "cash") {
          const trades = transactions.filter(
            (t) =>
              t.accountId === a.id &&
              t.assetId !== asset.id &&
              t.currency === asset.quoteCurrency &&
              ["BUY", "SELL"].includes(t.type),
          );
          let cash = new Decimal(quantity);
          let incomplete = false;
          for (const trade of trades) {
            const gross =
              trade.grossAmount ??
              (trade.unitPrice != null
                ? new Decimal(trade.quantity).mul(trade.unitPrice).toString()
                : null);
            if (gross === null) {
              incomplete = true;
              break;
            }
            cash =
              trade.type === "BUY"
                ? cash.minus(gross).minus(trade.feeAmount ?? 0)
                : cash.plus(gross).minus(trade.feeAmount ?? 0);
          }
          if (incomplete) {
            positions.push({
              assetId: asset.id,
              symbol: asset.symbol,
              name: asset.name,
              assetType: asset.assetType,
              quantity,
              currency: asset.quoteCurrency,
              source: "ledger_incomplete_settlement",
              stale: true,
            });
            continue;
          }
          quantity = money(cash);
        }
        if (new Decimal(quantity).isZero()) continue;
        const quote = quotes.find((q) => q.assetId === asset.id);
        let price =
          asset.assetType === "cash"
            ? money(1)
            : quote
              ? money(quote.price)
              : observed?.unitPrice != null
                ? money(observed.unitPrice)
                : undefined;
        let currency =
          asset.assetType === "cash"
            ? asset.quoteCurrency
            : (quote?.currency ?? observed?.currency ?? asset.quoteCurrency);
        // A provider's equity/position marketValue may differ from notional quantity × price for perpetuals.
        let marketValue =
          !useLedger && observed?.marketValue != null
            ? money(observed.marketValue)
            : price
              ? money(new Decimal(quantity).mul(price))
              : undefined;
        if (!useLedger && observed?.marketValue != null)
          currency = observed.currency;
        const costBasis = useLedger
          ? ledgerCost(ledger)
          : observed?.costBasis != null
            ? money(observed.costBasis)
            : undefined;
        const timestamp = !useLedger
          ? observed?.observedAt
          : (quote?.quotedAt ?? observed?.observedAt);
        const observedAt = timestamp
          ? new Date(timestamp).toISOString()
          : undefined;
        const stale =
          !observedAt ||
          Date.now() - new Date(observedAt).getTime() >
            (a.sourceType === "manual" ? 86400000 : 300000) ||
          (typeof observed?.metadata.priceQuotedAt === "string" &&
            Date.now() - new Date(observed.metadata.priceQuotedAt).getTime() >
              86400000);
        positions.push({
          assetId: asset.id,
          symbol: asset.symbol,
          name: asset.name,
          assetType: asset.assetType,
          quantity,
          price,
          marketValue,
          currency,
          costBasis,
          unrealizedPnl:
            !useLedger && observed?.unrealizedPnl != null
              ? money(observed.unrealizedPnl)
              : costBasis && marketValue && currency === asset.quoteCurrency
                ? money(new Decimal(marketValue).minus(costBasis))
                : undefined,
          realizedPnl:
            !useLedger && observed?.realizedPnl != null
              ? money(observed.realizedPnl)
              : undefined,
          source: useLedger ? "ledger" : observed!.source,
          observedAt,
          stale,
          side: observed?.side ?? undefined,
          entryPrice: observed?.entryPrice
            ? money(observed.entryPrice)
            : undefined,
          leverage: observed?.leverage ? money(observed.leverage) : undefined,
          liquidationPrice: observed?.liquidationPrice
            ? money(observed.liquidationPrice)
            : undefined,
        });
      }
      result.set(a.id, positions);
    }
    return result;
  }
  async dashboard(
    scope: Scope,
    range: Range,
    currency = "EUR",
    accountId?: string,
  ) {
    const [all, positions, fx, syncs] = await Promise.all([
      this.database.sql<
        Account[]
      >`SELECT * FROM accounts WHERE NOT is_archived ORDER BY sort_order,name`,
      this.positions(accountId),
      this.database.sql<
        {
          baseCurrency: string;
          quoteCurrency: string;
          rate: string;
          quotedAt: Date;
          source: string;
        }[]
      >`SELECT DISTINCT ON(base_currency,quote_currency) * FROM fx_quotes ORDER BY base_currency,quote_currency,quoted_at DESC`,
      this.database.sql<
        { accountId: string; status: string; errorMessage: string | null }[]
      >`SELECT DISTINCT ON(account_id) account_id,status,error_message FROM sync_runs ORDER BY account_id,started_at DESC`,
    ]);
    const convert = (p: PositionView): string | undefined => {
      if (p.marketValue === undefined) return undefined;
      if (p.currency === currency) return p.marketValue;
      const quote = fx.find(
        (q) =>
          q.baseCurrency === p.currency &&
          q.quoteCurrency === currency &&
          Date.now() - q.quotedAt.getTime() < 7 * 86400000,
      );
      return quote
        ? money(new Decimal(p.marketValue).mul(quote.rate))
        : undefined;
    };
    const accounts = (accountId ? all : visibleAccounts(all)).filter(
      (a) =>
        (!accountId || a.id === accountId) &&
        (scope === "global" ||
          (scope === "other"
            ? !["crypto", "equities"].includes(a.assetClass)
            : a.assetClass === scope)),
    );
    const rows = accounts.map((a) => {
      const lines = positions.get(a.id) ?? [];
      const sync = syncs.find((s) => s.accountId === a.id);
      const hasObservation =
        a.sourceType === "manual" ||
        lines.length > 0 ||
        sync?.status === "success" ||
        a.metadata.demo === true;
      const complete =
        hasObservation &&
        lines.every((p) => convert(p) !== undefined) &&
        !(sync?.status === "partial" && lines.length === 0);
      const value = money(
        lines.reduce((sum, p) => sum.plus(convert(p) ?? 0), new Decimal(0)),
      );
      const times = lines
        .map((p) => p.observedAt)
        .filter((x): x is string => !!x)
        .sort();
      return {
        id: a.id,
        name: a.name,
        assetClass: a.assetClass,
        sourceType: a.sourceType,
        isDemo: a.metadata.demo === true,
        value,
        complete,
        asOf: times[0],
        stale:
          !hasObservation ||
          lines.some((p) => p.stale) ||
          sync?.status === "failed" ||
          sync?.status === "partial",
        syncStatus: sync?.status,
        syncError: sync?.errorMessage,
        unvaluedPositions: lines.filter((p) => convert(p) === undefined).length,
      };
    });
    const since = new Date(Date.now() - rangeDays[range] * 86400000);
    const ids = accounts.map((a) => a.id);
    const history = ids.length
      ? await this.database.sql<
          { at: Date; value: string; count: number }[]
        >`SELECT b.captured_at AS at,sum(v.total_value)::text AS value,count(*)::integer AS count FROM valuation_batches b JOIN account_valuations v ON v.batch_id=b.id WHERE v.account_id IN ${this.database.sql(ids)} AND b.base_currency=${currency} AND b.captured_at>=${since} GROUP BY b.id ORDER BY b.captured_at`
      : [];
    const snapshots = history
      .filter((p) => p.count === ids.length)
      .map((p) => ({ at: p.at.toISOString(), value: money(p.value) }));
    const observedHistory = await providerHistory(
      this.database.sql,
      ids,
      since,
      currency,
    );
    // Actual provider history takes precedence when both sources share a timestamp.
    const rawChart = [
      ...new Map(
        [
          ...snapshots.map((p) => ({ ...p, source: "recorded_snapshot" })),
          ...observedHistory,
        ].map((p) => [p.at, p]),
      ).values(),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const chart = sampleChart(rawChart, range);
    const value = money(
      rows.reduce((sum, a) => sum.plus(a.value), new Decimal(0)),
    );
    const complete = rows.every((a) => a.complete);
    const first = chart[0];
    const absoluteChange =
      complete && first
        ? money(new Decimal(value).minus(first.value))
        : undefined;
    const percentChange =
      absoluteChange && first && !new Decimal(first.value).isZero()
        ? money(new Decimal(absoluteChange).div(first.value).mul(100))
        : undefined;
    const allocation = [...new Set(rows.map((a) => a.assetClass))].map(
      (key) => {
        const amount = money(
          rows
            .filter((a) => a.assetClass === key)
            .reduce((s, a) => s.plus(a.value), new Decimal(0)),
        );
        return {
          key,
          label:
            key === "equities"
              ? "Actions"
              : key[0]!.toUpperCase() + key.slice(1),
          value: amount,
          percentage: new Decimal(value).isZero()
            ? money(0)
            : money(new Decimal(amount).div(value).mul(100)),
        };
      },
    );
    return {
      scope,
      range,
      currency,
      value,
      complete,
      absoluteChange,
      percentChange,
      changeKind: "value_change_not_investment_return",
      asOf:
        rows
          .map((a) => a.asOf)
          .filter((at): at is string => !!at)
          .sort()[0] ?? new Date().toISOString(),
      fx: fx
        .filter((q) => q.quoteCurrency === currency)
        .map((q) => ({
          from: q.baseCurrency,
          to: currency,
          rate: money(q.rate),
          quotedAt: q.quotedAt.toISOString(),
          source: q.source,
        })),
      chart,
      allocation,
      accounts: rows,
    };
  }
}

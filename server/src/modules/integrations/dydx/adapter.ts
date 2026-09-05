import { z } from "zod";
import { Decimal, money } from "../../../shared/decimal.js";
import type { Account } from "../../accounts/schemas.js";
import { providerJSON, type Fetch } from "../http.js";
import {
  providerDecimal as d,
  emptySync,
  signedBalance,
  type ProviderAsset,
  type ProviderSyncResult,
  type ProviderPosition,
} from "../types.js";
const positionSchema = z.object({
  market: z.string(),
  side: z.enum(["LONG", "SHORT"]),
  size: d,
  entryPrice: d,
  unrealizedPnl: d,
  realizedPnl: d,
  netFunding: d.optional(),
});
const accountSchema = z.object({
  subaccount: z.object({
    equity: d,
    freeCollateral: d.optional(),
    openPerpetualPositions: z.record(z.string(), positionSchema),
    assetPositions: z.record(
      z.string(),
      z.object({
        symbol: z.string(),
        size: d,
        side: z.enum(["LONG", "SHORT"]),
      }),
    ),
  }),
});
const fillsSchema = z.object({
  fills: z.array(
    z.object({
      id: z.string(),
      market: z.string(),
      side: z.enum(["BUY", "SELL"]),
      size: d,
      price: d,
      fee: d,
      createdAt: z.iso.datetime({ offset: true }),
    }),
  ),
});
const pnlSchema = z.object({
  pnl: z.array(
    z.object({
      equity: d,
      totalPnl: d,
      netTransfers: d,
      createdAt: z.iso.datetime({ offset: true }),
    }),
  ),
});
export class DydxAdapter {
  readonly kind = "dydx";
  constructor(private transport: Fetch = fetch) {}
  async syncAccount(
    account: Account,
    cursor: Record<string, unknown>,
  ): Promise<ProviderSyncResult> {
    const result = emptySync(),
      address = encodeURIComponent(account.externalAddress!),
      sub = account.externalSubaccount ?? 0;
    const base = "https://indexer.dydx.trade/v4";
    const perp = (market: string): ProviderAsset => ({
      key: `dydx:perp:${market}`,
      symbol: market,
      name: `${market} perpetual`,
      assetType: "perp",
    });
    const responses = await Promise.allSettled([
      providerJSON(
        `${base}/addresses/${address}/subaccountNumber/${sub}`,
        undefined,
        this.transport,
      ),
      providerJSON(
        `${base}/fills?address=${address}&subaccountNumber=${sub}&limit=100`,
        undefined,
        this.transport,
      ),
    ]);
    try {
      const { subaccount: s } = accountSchema.parse(
        responses[0]!.status === "fulfilled" ? responses[0]!.value : null,
      );
      const positions: ProviderPosition[] = Object.values(
        s.openPerpetualPositions,
      ).map((p) => {
        const quantity = new Decimal(p.size).abs(),
          signedEntry = quantity
            .mul(p.entryPrice)
            .mul(p.side === "SHORT" ? -1 : 1);
        const value = signedEntry.plus(p.unrealizedPnl);
        return {
          asset: perp(p.market),
          scope: "account",
          quantity: money(quantity),
          currency: "USD",
          marketValue: money(value),
          unitPrice: quantity.isZero()
            ? undefined
            : money(value.abs().div(quantity)),
          side: (p.side === "SHORT" ? "short" : "long") as "short" | "long",
          entryPrice: p.entryPrice,
          leverage: new Decimal(s.equity).gt(0)
            ? money(value.abs().div(s.equity))
            : undefined,
          unrealizedPnl: p.unrealizedPnl,
          realizedPnl: p.realizedPnl,
          metadata: {
            valuationMethod: "signed_entry_notional_plus_pnl",
            ...(p.netFunding ? { netFunding: p.netFunding } : {}),
            leverageMethod:
              "absolute_position_notional_divided_by_account_equity",
          },
        };
      });
      for (const cash of Object.values(s.assetPositions)) {
        if (cash.symbol !== "USDC") throw new Error("Unsupported collateral");
        positions.push({
          ...signedBalance(
            {
              key: "dydx:cash:USDC",
              symbol: "USDC",
              name: "USDC margin ledger balance",
              assetType: "cash",
            },
            "account",
            money(
              new Decimal(cash.size).abs().mul(cash.side === "SHORT" ? -1 : 1),
            ),
          ),
          entryPrice: money(1),
          unrealizedPnl: money(0),
          realizedPnl: money(0),
          metadata: { valuationMethod: "reported_collateral" },
        });
      }
      const total = positions.reduce(
        (s, p) => s.plus(p.marketValue ?? 0),
        new Decimal(0),
      );
      if (total.minus(s.equity).abs().gt("0.01"))
        throw new Error("State does not reconcile");
      const exposure = positions
        .filter((p) => p.asset.assetType === "perp")
        .reduce(
          (sum, p) => sum.plus(new Decimal(p.marketValue ?? 0).abs()),
          new Decimal(0),
        );
      result.metadata = {
        derivatives: {
          equity: s.equity,
          freeCollateral: s.freeCollateral ?? null,
          grossExposure: money(exposure),
          effectiveLeverage: new Decimal(s.equity).gt(0)
            ? money(exposure.div(s.equity))
            : null,
          marginMode: "subaccount",
          currency: "USD",
          source: "dydx",
          asOf: new Date().toISOString(),
          leverageMethod: "gross_notional_divided_by_equity",
        },
      };
      result.positions.push(...positions);
      result.coveredScopes.push("account");
    } catch {
      result.warnings.push(
        "Subaccount valuation unavailable or does not reconcile; last known positions retained",
      );
    }
    try {
      const latest = fillsSchema.parse(
        responses[1]!.status === "fulfilled" ? responses[1]!.value : null,
      ).fills;
      let history: typeof latest = [];
      result.cursor = {};
      if (typeof cursor.historyBefore === "string")
        result.cursor.historyBefore = cursor.historyBefore;
      if (cursor.historyComplete === "yes")
        result.cursor.historyComplete = "yes";
      if (
        typeof cursor.historyBefore === "string" &&
        cursor.historyComplete !== "yes"
      ) {
        history = fillsSchema.parse(
          await providerJSON(
            `${base}/fills?address=${address}&subaccountNumber=${sub}&limit=100&createdBeforeOrAt=${encodeURIComponent(cursor.historyBefore)}`,
            undefined,
            this.transport,
          ),
        ).fills;
        const oldest = history.at(-1)?.createdAt;
        if (history.length < 100) result.cursor.historyComplete = "yes";
        else if (oldest && oldest < cursor.historyBefore)
          result.cursor.historyBefore = oldest;
        else
          result.warnings.push(
            "History pagination reached the provider timestamp boundary; older fills may be incomplete",
          );
      } else if (!cursor.historyBefore && latest.length === 100)
        result.cursor.historyBefore = latest.at(-1)!.createdAt;
      if (
        result.cursor.historyBefore &&
        result.cursor.historyComplete !== "yes"
      )
        result.warnings.push("Backfilling older fills");
      const fills = [
        ...new Map([...latest, ...history].map((f) => [f.id, f])).values(),
      ];
      result.transactions = fills.map((f) => ({
        asset: perp(f.market),
        externalId: f.id,
        type: f.side,
        quantity: money(new Decimal(f.size).abs()),
        unitPrice: f.price,
        feeAmount: new Decimal(f.fee).gte(0) ? f.fee : undefined,
        currency: "USD",
        occurredAt: f.createdAt,
      }));
    } catch {
      result.warnings.push("Fill history unavailable");
    }
    // Equity history is independent of live positions. Failure must not mark current balances stale.
    result.history = [];
    const historyErrors: string[] = [];
    for (const resolution of ["daily", "hourly"] as const) {
      try {
        const suffix = resolution === "daily" ? "true" : "false";
        let before: string | undefined;
        for (let page = 0; page < (resolution === "hourly" ? 3 : 4); page++) {
          const response = pnlSchema.parse(
            await providerJSON(
              `${base}/pnl?address=${address}&subaccountNumber=${sub}&daily=${suffix}&limit=100${before ? `&createdBeforeOrAt=${encodeURIComponent(before)}` : ""}`,
              undefined,
              this.transport,
            ),
          );
          for (const point of response.pnl) {
            if (
              new Decimal(point.equity)
                .minus(point.totalPnl)
                .minus(point.netTransfers)
                .abs()
                .gt("0.01")
            )
              throw new Error("History does not reconcile");
            result.history.push({
              at: point.createdAt,
              resolution,
              equity: point.equity,
              totalPnl: point.totalPnl,
              netTransfers: point.netTransfers,
              currency: "USD",
            });
          }
          const oldest = response.pnl.map((p) => p.createdAt).sort()[0];
          if (response.pnl.length < 100 || !oldest) break;
          const next = new Date(new Date(oldest).getTime() - 1).toISOString();
          if (before && next >= before) break;
          before = next;
        }
      } catch {
        historyErrors.push(`${resolution} equity history unavailable`);
      }
    }
    result.metadata = {
      ...result.metadata,
      historyStatus: historyErrors.length ? "partial" : "success",
      historyError: historyErrors.join("; ") || null,
    };
    return result;
  }
}

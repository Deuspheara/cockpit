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
} from "../types.js";
const stateSchema = z.object({
  marginSummary: z.object({ accountValue: d, totalRawUsd: d }),
  assetPositions: z.array(
    z.object({
      position: z.object({
        coin: z.string(),
        szi: d,
        positionValue: d,
        entryPx: d.nullable(),
        unrealizedPnl: d,
        liquidationPx: d.nullable(),
        leverage: z.object({ value: z.number().int().min(1).max(1000) }),
      }),
    }),
  ),
});
const spotSchema = z.object({
  balances: z.array(
    z.object({
      coin: z.string(),
      token: z.number().int().nonnegative(),
      total: d,
    }),
  ),
});
const spotMetaSchema = z.tuple([
  z.object({
    tokens: z.array(z.object({ name: z.string(), index: z.number().int() })),
    universe: z.array(
      z.object({
        name: z.string(),
        tokens: z.array(z.number().int()),
        index: z.number().int(),
      }),
    ),
  }),
  z.array(z.object({ markPx: d.nullable() })),
]);
const fillSchema = z.array(
  z.object({
    coin: z.string(),
    side: z.enum(["A", "B"]),
    sz: d,
    px: d,
    fee: d,
    time: z.number().int().nonnegative(),
    tid: z.number().int().safe(),
  }),
);
export class HyperliquidAdapter {
  readonly kind = "hyperliquid";
  constructor(private transport: Fetch = fetch) {}
  // This fixed endpoint is the sole Hyperliquid HTTP destination. No exchange/signing API exists here.
  private info(body: Record<string, unknown>) {
    return providerJSON(
      "https://api.hyperliquid.xyz/info",
      body,
      this.transport,
    );
  }
  async syncAccount(
    account: Account,
    cursor: Record<string, unknown>,
  ): Promise<ProviderSyncResult> {
    const result = emptySync(),
      user = account.externalAddress;
    const settled = await Promise.allSettled([
      this.info({ type: "clearinghouseState", user }),
      this.info({ type: "spotClearinghouseState", user }),
      this.info({ type: "spotMetaAndAssetCtxs" }),
      this.info({
        type: "userFillsByTime",
        user,
        startTime: typeof cursor.fillTime === "number" ? cursor.fillTime : 0,
        aggregateByTime: false,
      }),
      this.info({ type: "subAccounts", user }),
    ]);
    const spotMetadata =
      settled[2]!.status === "fulfilled"
        ? spotMetaSchema.safeParse(settled[2]!.value)
        : null;
    const perp = (coin: string): ProviderAsset => ({
      key: `hyperliquid:perp:${coin}`,
      symbol: `${coin}-PERP`,
      name: `${coin} perpetual`,
      assetType: "perp",
    });
    try {
      const state = stateSchema.parse(
        settled[0]!.status === "fulfilled" ? settled[0]!.value : null,
      );
      const positions = state.assetPositions.map(({ position: p }) => {
        const size = new Decimal(p.szi),
          signedValue = new Decimal(p.positionValue).mul(size.lt(0) ? -1 : 1);
        return {
          asset: perp(p.coin),
          scope: "perps",
          quantity: money(size.abs()),
          currency: "USD",
          marketValue: money(signedValue),
          unitPrice: size.isZero()
            ? undefined
            : money(new Decimal(p.positionValue).div(size.abs())),
          side: (size.lt(0) ? "short" : "long") as "short" | "long",
          entryPrice: p.entryPx ?? undefined,
          unrealizedPnl: p.unrealizedPnl,
          leverage: money(p.leverage.value),
          liquidationPrice: p.liquidationPx ?? undefined,
          metadata: { valuationMethod: "signed_notional_plus_raw_usd" },
        };
      });
      const sum = positions.reduce(
        (s, p) => s.plus(p.marketValue),
        new Decimal(state.marginSummary.totalRawUsd),
      );
      if (sum.minus(state.marginSummary.accountValue).abs().gt("0.01"))
        throw new Error("Unreconciled margin state");
      result.positions.push(
        signedBalance(
          {
            key: "hyperliquid:cash:margin-usd",
            symbol: "USD",
            name: "USD margin ledger balance",
            assetType: "cash",
          },
          "perps",
          state.marginSummary.totalRawUsd,
        ),
        ...positions,
      );
      result.coveredScopes.push("perps");
    } catch {
      result.warnings.push(
        "Perpetual state unavailable or did not reconcile; last known positions retained",
      );
    }
    try {
      const spot = spotSchema.parse(
        settled[1]!.status === "fulfilled" ? settled[1]!.value : null,
      );
      const metadata = spotMetadata;
      for (const b of spot.balances) {
        let price: string | undefined = b.token === 0 ? money(1) : undefined;
        if (metadata?.success) {
          const pairIndex = metadata.data[0].universe.findIndex(
            (pair) => pair.tokens[0] === b.token && pair.tokens[1] === 0,
          );
          price =
            price ??
            (pairIndex >= 0
              ? (metadata.data[1][pairIndex]?.markPx ?? undefined)
              : undefined);
        }
        result.positions.push({
          asset: {
            key: `hyperliquid:spot:${b.token}`,
            symbol: b.coin,
            name: b.coin,
            assetType: "crypto",
          },
          scope: "spot",
          quantity: b.total,
          currency: "USD",
          unitPrice: price,
          marketValue: price
            ? money(new Decimal(b.total).mul(price))
            : undefined,
        });
      }
      result.coveredScopes.push("spot");
      if (!metadata?.success && spot.balances.some((b) => b.token !== 0))
        result.warnings.push("Spot prices unavailable");
    } catch {
      result.warnings.push(
        "Spot balances unavailable; last known positions retained",
      );
    }
    try {
      const fills = fillSchema.parse(
        settled[3]!.status === "fulfilled" ? settled[3]!.value : null,
      );
      for (const f of fills) {
        let asset = perp(f.coin);
        if (f.coin.startsWith("@")) {
          const index = Number(f.coin.slice(1));
          const pair = spotMetadata?.success
            ? spotMetadata.data[0].universe.find((p) => p.index === index)
            : undefined;
          const token =
            pair && spotMetadata?.success
              ? spotMetadata.data[0].tokens.find(
                  (t) => t.index === pair.tokens[0],
                )
              : undefined;
          if (!token) {
            result.warnings.push(
              "Spot fill metadata unavailable; activity partial",
            );
            continue;
          }
          asset = {
            key: `hyperliquid:spot:${token.index}`,
            symbol: token.name,
            name: token.name,
            assetType: "crypto",
          };
        }
        result.transactions.push({
          asset,
          externalId: String(f.tid),
          type: f.side === "B" ? "BUY" : "SELL",
          quantity: f.sz,
          unitPrice: f.px,
          feeAmount: new Decimal(f.fee).gte(0) ? f.fee : undefined,
          currency: "USD",
          occurredAt: new Date(f.time).toISOString(),
        });
      }
      result.cursor.fillTime = fills.reduce(
        (time, f) => Math.max(time, f.time),
        typeof cursor.fillTime === "number" ? cursor.fillTime : 0,
      );
      if (fills.length >= 2000)
        result.warnings.push(
          "Fill history reached provider page limit; next sync continues from timestamp",
        );
    } catch {
      result.warnings.push("Fill history unavailable");
    }
    if (settled[4]!.status === "fulfilled") {
      const subs = z
        .array(z.object({ name: z.string(), subAccountUser: z.string() }))
        .nullable()
        .safeParse(settled[4]!.value);
      if (subs.success) result.metadata = { subaccounts: subs.data ?? [] };
    }
    result.warnings = [...new Set(result.warnings)];
    return result;
  }
}

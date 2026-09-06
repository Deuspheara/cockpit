import { AppError } from "../../../shared/errors.js";
import { z } from "zod";
import { Decimal, money } from "../../../shared/decimal.js";
import { providerDecimal, type ProviderPosition } from "../types.js";
import { providerJSON, type Fetch } from "../http.js";
export const usdQuoteSchema = z.object({
  currency: z.string(),
  value: providerDecimal.refine((v) => new Decimal(v).gte(0)),
  lastUpdatedAt: z.iso.datetime({ offset: true }),
});
export function usdQuote(raw: unknown, now = Date.now()) {
  return (Array.isArray(raw) ? raw : [])
    .flatMap((v) => {
      const p = usdQuoteSchema.safeParse(v);
      return p.success &&
        p.data.currency.toLowerCase() === "usd" &&
        Date.parse(p.data.lastUpdatedAt) <= now + 60000 &&
        now - Date.parse(p.data.lastUpdatedAt) <= 86400000
        ? [p.data]
        : [];
    })
    .sort(
      (a, b) => Date.parse(b.lastUpdatedAt) - Date.parse(a.lastUpdatedAt),
    )[0];
}
// Bounded, short-lived positive and negative cache. Contract identity, never symbol matching.
export class AlchemyPrices {
  private cache = new Map<
    string,
    { until: number; quote: ReturnType<typeof usdQuote>; failure?: string }
  >();
  constructor(
    private key: string,
    private transport: Fetch = fetch,
  ) {}
  async enrich(positions: ProviderPosition[]) {
    const missing = positions.filter((p) => p.unitPrice === undefined);
    const pending = [
      ...new Map(missing.map((p) => [p.asset.key, p])).values(),
    ].filter((p) => (this.cache.get(p.asset.key)?.until ?? 0) <= Date.now());
    const native = pending.filter((p) => !p.asset.contractAddress);
    const tokens = pending.filter((p) => p.asset.contractAddress);
    const remember = (
      p: ProviderPosition,
      quote: ReturnType<typeof usdQuote>,
      failure?: string,
    ) => {
      if (this.cache.size >= 2000)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(p.asset.key, {
        until: Date.now() + (quote ? 300000 : 900000),
        quote,
        failure,
      });
    };
    const envelope = z.object({
      data: z.array(
        z.object({
          network: z.string().optional(),
          address: z.string().optional(),
          symbol: z.string().optional(),
          prices: z.unknown().optional(),
        }),
      ),
    });
    for (let offset = 0; offset < tokens.length; offset += 25) {
      const batch = tokens.slice(offset, offset + 25);
      try {
        const response = envelope.parse(
          await providerJSON(
            `https://api.g.alchemy.com/prices/v1/${encodeURIComponent(this.key)}/tokens/by-address`,
            {
              addresses: batch.map((p) => ({
                network: p.asset.chain,
                address: p.asset.contractAddress,
              })),
            },
            this.transport,
          ),
        );
        for (const p of batch)
          remember(
            p,
            usdQuote(
              response.data.find(
                (r) =>
                  r.network === p.asset.chain &&
                  r.address?.toLowerCase() === p.asset.contractAddress,
              )?.prices,
            ),
          );
      } catch (error) {
        for (const p of batch) remember(p, undefined, priceFailure(error));
      }
    }
    if (native.length) {
      try {
        const response = envelope.parse(
          await providerJSON(
            `https://api.g.alchemy.com/prices/v1/${encodeURIComponent(this.key)}/tokens/by-symbol?symbols=ETH`,
            undefined,
            this.transport,
          ),
        );
        const quote = usdQuote(
          response.data.find((r) => r.symbol === "ETH")?.prices,
        );
        for (const p of native) remember(p, quote);
      } catch (error) {
        for (const p of native) remember(p, undefined, priceFailure(error));
      }
    }
    for (const p of missing) {
      const cached = this.cache.get(p.asset.key);
      const quote = cached && usdQuote(cached.quote ? [cached.quote] : []);
      if (!quote)
        p.metadata = {
          ...p.metadata,
          priceIssue:
            cached?.failure ??
            "No USD price is available for this token on this network",
        };
      if (quote) {
        p.unitPrice = quote.value;
        p.marketValue = money(new Decimal(p.quantity).mul(quote.value));
        p.metadata = {
          ...p.metadata,
          priceQuotedAt: quote.lastUpdatedAt,
          priceSource: "alchemy_prices",
        };
      }
    }
  }
}

function priceFailure(error: unknown) {
  const message = error instanceof AppError ? error.message : "";
  if (/HTTP 40[13]/.test(message))
    return "Alchemy denied price access; check server key permissions";
  if (/HTTP 429/.test(message))
    return "Alchemy price rate limit reached; retry later";
  return "Alchemy price lookup unavailable; balance retained";
}

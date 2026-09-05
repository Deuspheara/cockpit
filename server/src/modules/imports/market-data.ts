import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Cache } from "../../shared/cache.js";
import { Decimal } from "../../shared/decimal.js";

const resultSchema = z.array(
  z
    .object({
      Code: z.string(),
      Exchange: z.string(),
      Name: z.string(),
      Type: z.string(),
      Country: z.string().optional(),
      Currency: z.string(),
      ISIN: z.string().nullable().optional(),
      previousClose: z.union([z.string(), z.number()]).nullable().optional(),
      previousCloseDate: z.string().nullable().optional(),
      isPrimary: z.boolean().optional(),
    })
    .passthrough(),
);

export interface MarketCandidate {
  providerKey: string;
  symbol: string;
  exchange: string;
  name: string;
  type: string;
  currency: string;
  isin: string | null;
  price: string | null;
  quotedAt: string | null;
  isPrimary: boolean;
}

export interface MarketDataProvider {
  search(query: string): Promise<MarketCandidate[]>;
}

export function isEligiblePreviousClose(
  observedAt: string,
  quotedAt: string,
  maximumCalendarDays = 3,
) {
  const observedDay = Date.parse(`${observedAt.slice(0, 10)}T00:00:00.000Z`);
  const quotedDay = Date.parse(`${quotedAt.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(observedDay) || !Number.isFinite(quotedDay))
    return false;
  const days = (observedDay - quotedDay) / 86400000;
  return days >= 0 && days <= maximumCalendarDays;
}

export function estimateQuantity(
  marketValue: string,
  unitPrice: string,
  quoteToValueRate: string,
) {
  const denominator = new Decimal(unitPrice).mul(quoteToValueRate);
  if (!new Decimal(marketValue).isFinite() || denominator.lte(0)) return null;
  return new Decimal(marketValue).div(denominator).toDecimalPlaces(8).toFixed();
}

export class EODHDMarketData implements MarketDataProvider {
  constructor(
    private cache: Cache,
    private config: Pick<Config, "EODHD_API_TOKEN" | "EODHD_DAILY_LIMIT">,
    private transport: typeof fetch = fetch,
  ) {}

  async search(query: string): Promise<MarketCandidate[]> {
    if (!this.config.EODHD_API_TOKEN) return [];
    const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized) return [];
    const digest = createHash("sha256").update(normalized).digest("hex");
    const cacheKey = `market-data:eodhd:search:${digest}`;
    try {
      const saved = await this.cache.get(cacheKey);
      if (saved) return JSON.parse(saved) as MarketCandidate[];
    } catch {
      return [];
    }
    const day = new Date().toISOString().slice(0, 10);
    const budgetKey = `market-data:eodhd:budget:${day}`;
    try {
      const used = await this.cache.incr(budgetKey);
      if (used === 1) await this.cache.expire(budgetKey, 172800);
      if (used > this.config.EODHD_DAILY_LIMIT) return [];
    } catch {
      return [];
    }
    const url = new URL(
      `https://eodhd.com/api/search/${encodeURIComponent(normalized)}`,
    );
    url.searchParams.set("api_token", this.config.EODHD_API_TOKEN);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "8");
    let candidates: MarketCandidate[];
    try {
      const response = await this.transport(url, {
        signal: AbortSignal.timeout(10000),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return [];
      candidates = resultSchema.parse(await response.json()).map((row) => ({
        providerKey: `${row.Code}.${row.Exchange}`,
        symbol: row.Code,
        exchange: row.Exchange,
        name: row.Name,
        type: row.Type,
        currency: row.Currency.toUpperCase(),
        isin: row.ISIN ?? null,
        price:
          row.previousClose === null || row.previousClose === undefined
            ? null
            : String(row.previousClose),
        quotedAt: row.previousCloseDate
          ? `${row.previousCloseDate}T00:00:00.000Z`
          : null,
        isPrimary: row.isPrimary ?? false,
      }));
    } catch {
      return [];
    }
    try {
      await this.cache.setEx(cacheKey, 30 * 86400, JSON.stringify(candidates));
    } catch {}
    return candidates;
  }
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "../../config.js";
import type { Cache } from "../../shared/cache.js";
import { Decimal } from "../../shared/decimal.js";
import {
  MarketProviderError,
  type EODHDRequestGate,
} from "../market-data/providers.js";

const resultSchema = z.array(
  z
    .object({
      Code: z.string(),
      Exchange: z.string(),
      Name: z.string(),
      Type: z.string(),
      Country: z.string().nullish(),
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
  search(
    query: string,
    signal?: AbortSignal,
    onWarning?: (message: string) => void,
  ): Promise<MarketCandidate[]>;
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
    private gate: EODHDRequestGate,
    private transport: typeof fetch = fetch,
  ) {}

  async search(
    query: string,
    signal?: AbortSignal,
    onWarning?: (message: string) => void,
  ): Promise<MarketCandidate[]> {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized) return [];
    const digest = createHash("sha256").update(normalized).digest("hex");
    const cacheKey = `market-data:eodhd:search:v3:${digest}`;
    const identityKey = `market-data:eodhd:identities:${digest}`;
    let identities: MarketCandidate[] = [];
    const fallback = (message: string) => {
      onWarning?.(message);
      return identities;
    };
    try {
      const savedIdentities = await this.cache.get(identityKey);
      if (savedIdentities)
        identities = (JSON.parse(savedIdentities) as MarketCandidate[]).map(
          (c) => ({ ...c, price: null, quotedAt: null }),
        );
      const saved = await this.cache.get(cacheKey);
      if (saved) return JSON.parse(saved) as MarketCandidate[];
    } catch {
      /* Cache reads must not erase valid provider results. */
    }
    if (!this.config.EODHD_API_TOKEN)
      return fallback(
        "Investment search is not configured on the server (EODHD_API_TOKEN). Previously saved matches remain available.",
      );
    const url = new URL(
      `https://eodhd.com/api/search/${encodeURIComponent(normalized)}`,
    );
    url.searchParams.set("api_token", this.config.EODHD_API_TOKEN);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "20");
    let candidates: MarketCandidate[];
    try {
      const payload = await this.gate.run(async () => {
        const response = await this.transport(url, {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
          headers: { Accept: "application/json" },
        });
        if (!response.ok)
          throw new MarketProviderError(
            response.status === 429
              ? "quota_exhausted"
              : response.status === 401
                ? "authentication_error"
                : response.status === 403
                  ? "not_entitled"
                  : response.status >= 500
                    ? "provider_unavailable"
                    : "invalid_provider_data",
            "EODHD investment search failed.",
            String(response.status),
          );
        return response.json();
      });
      if (!Array.isArray(payload))
        return fallback("EODHD returned an unreadable search response.");
      const rows = payload.flatMap((row) => {
        const parsed = resultSchema.element.safeParse(row);
        return parsed.success ? [parsed.data] : [];
      });
      if (payload.length && !rows.length)
        return fallback(
          "EODHD returned incomplete investment details. Previously saved matches remain available.",
        );
      candidates = rows.map((row) => ({
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
          ? `${row.previousCloseDate.slice(0, 10)}T00:00:00.000Z`
          : null,
        isPrimary: row.isPrimary ?? false,
      }));
    } catch (error) {
      if (error instanceof MarketProviderError)
        return fallback(
          error.failure === "quota_exhausted"
            ? "EODHD search quota reached. Previously saved matches remain available."
            : ["authentication_error", "not_entitled"].includes(error.failure)
              ? "EODHD rejected investment search. Check the server token and its Search API access."
              : "EODHD investment search is temporarily unavailable. Previously saved matches remain available.",
        );
      return fallback(
        "EODHD investment search could not be reached. Previously saved matches remain available.",
      );
    }
    try {
      if (candidates.length) {
        await this.cache.setEx(cacheKey, 300, JSON.stringify(candidates));
        await this.cache.setEx(
          identityKey,
          604800,
          JSON.stringify(
            candidates.map((c) => ({ ...c, price: null, quotedAt: null })),
          ),
        );
      }
    } catch {}
    return candidates;
  }
}

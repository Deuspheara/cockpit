import { z } from "zod";
import type { Config } from "../../config.js";
import type { Database } from "../../db/index.js";
import type { Cache } from "../../shared/cache.js";
import { Decimal, money } from "../../shared/decimal.js";

export type ProviderFailure =
  | "configuration_error"
  | "authentication_error"
  | "not_entitled"
  | "rate_limited"
  | "quota_exhausted"
  | "provider_unavailable"
  | "invalid_provider_data";

export class MarketProviderError extends Error {
  constructor(
    public failure: ProviderFailure,
    message: string,
    public providerCode?: string,
    public retryAt?: Date,
  ) {
    super(message);
  }
}

export interface EODHDRequestGate {
  run<T>(request: () => Promise<T>): Promise<T>;
  blockedUntil(): Promise<Date | null>;
  claimDiscoveryLease?(owner: string): Promise<boolean>;
  releaseDiscoveryLease?(owner: string): Promise<void>;
}

export class EODHDQuotaCoordinator implements EODHDRequestGate {
  constructor(
    private database: Database,
    private cache: Cache,
    private config: Pick<
      Config,
      "EODHD_API_TOKEN" | "EODHD_DAILY_LIMIT" | "EODHD_PER_MINUTE_LIMIT"
    >,
  ) {}

  private resetAfter(now = new Date()) {
    const reset = new Date(now);
    reset.setUTCDate(reset.getUTCDate() + 1);
    reset.setUTCHours(0, 0, 5, 0);
    return reset;
  }

  private async reserve() {
    if (!this.config.EODHD_API_TOKEN)
      throw new MarketProviderError(
        "configuration_error",
        "EODHD_API_TOKEN is not configured.",
      );
    const now = new Date();
    const existingBlock = await this.blockedUntil();
    if (existingBlock)
      throw new MarketProviderError(
        "quota_exhausted",
        "The configured EODHD daily call budget was reached.",
        undefined,
        existingBlock,
      );
    const minute = now.toISOString().slice(0, 16);
    try {
      const used = await this.cache.incr(`market-data:eodhd:minute:${minute}`);
      await this.cache.expire(`market-data:eodhd:minute:${minute}`, 120);
      if (used > this.config.EODHD_PER_MINUTE_LIMIT)
        throw new MarketProviderError(
          "rate_limited",
          "The configured EODHD per-minute limit was reached.",
          undefined,
          new Date(Date.now() + 60000),
        );
    } catch (error) {
      if (error instanceof MarketProviderError) throw error;
      throw new MarketProviderError(
        "provider_unavailable",
        "Market-data throttling is unavailable because Redis cannot be reached.",
      );
    }
    const day = now.toISOString().slice(0, 10);
    const rows = await this.database.sql<{ usedCalls: number }[]>`
      INSERT INTO provider_call_budgets(provider,budget_day,used_calls)
      VALUES('eodhd',${day}::date,1)
      ON CONFLICT(provider,budget_day) DO UPDATE SET
        used_calls=provider_call_budgets.used_calls+1,updated_at=now()
      WHERE (provider_call_budgets.blocked_until IS NULL OR provider_call_budgets.blocked_until<=now())
        AND provider_call_budgets.used_calls<${this.config.EODHD_DAILY_LIMIT}
      RETURNING used_calls`;
    if (rows.length) return;
    const retryAt = this.resetAfter(now);
    await this.database.sql`
      INSERT INTO provider_call_budgets(provider,budget_day,used_calls,blocked_until,block_reason)
      VALUES('eodhd',${day}::date,${this.config.EODHD_DAILY_LIMIT},${retryAt},'configured_limit')
      ON CONFLICT(provider,budget_day) DO UPDATE SET
        blocked_until=greatest(coalesce(provider_call_budgets.blocked_until,excluded.blocked_until),excluded.blocked_until),
        block_reason='configured_limit',updated_at=now()`;
    throw new MarketProviderError(
      "quota_exhausted",
      "The configured EODHD daily call budget was reached.",
      undefined,
      retryAt,
    );
  }

  private async observe(error: unknown) {
    if (
      !(error instanceof MarketProviderError) ||
      error.failure !== "quota_exhausted"
    )
      return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const resetAt = this.resetAfter(now);
    const retryAt =
      error.retryAt && error.retryAt > resetAt ? error.retryAt : resetAt;
    error.retryAt = retryAt;
    await this.database.sql`
      INSERT INTO provider_call_budgets(provider,budget_day,used_calls,blocked_until,block_reason)
      VALUES('eodhd',${day}::date,${this.config.EODHD_DAILY_LIMIT},${retryAt},'upstream_quota')
      ON CONFLICT(provider,budget_day) DO UPDATE SET
        used_calls=greatest(provider_call_budgets.used_calls,excluded.used_calls),
        blocked_until=greatest(coalesce(provider_call_budgets.blocked_until,excluded.blocked_until),excluded.blocked_until),
        block_reason='upstream_quota',updated_at=now()`;
  }

  async blockedUntil() {
    const day = new Date().toISOString().slice(0, 10);
    const [row] = await this.database.sql<{ blockedUntil: Date | null }[]>`
      SELECT blocked_until FROM provider_call_budgets
      WHERE provider='eodhd' AND budget_day=${day}::date AND blocked_until>now()`;
    return row?.blockedUntil ?? null;
  }

  async claimDiscoveryLease(owner: string) {
    const rows = await this.database.sql`
      INSERT INTO provider_work_leases(provider,work_type,owner,lease_until)
      VALUES('eodhd','discovery',${owner},now()+interval '2 minutes')
      ON CONFLICT(provider,work_type) DO UPDATE SET
        owner=excluded.owner,lease_until=excluded.lease_until,updated_at=now()
      WHERE provider_work_leases.lease_until<now() OR provider_work_leases.owner=${owner}
      RETURNING owner`;
    return rows.length > 0;
  }

  async releaseDiscoveryLease(owner: string) {
    await this.database.sql`
      DELETE FROM provider_work_leases
      WHERE provider='eodhd' AND work_type='discovery' AND owner=${owner}`;
  }

  async run<T>(request: () => Promise<T>) {
    await this.reserve();
    try {
      return await request();
    } catch (error) {
      await this.observe(error);
      throw error;
    }
  }
}

export interface EodhdListing {
  providerSymbol: string;
  ticker: string;
  exchange: string;
  name: string;
  type: string;
  currency: string;
  isin: string;
  isPrimary: boolean;
}

export interface EodBar {
  date: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string;
  adjustedClose: string | null;
  volume: string | null;
}

const listingRow = z
  .object({
    Code: z.string().trim().min(1),
    Exchange: z.string().trim().min(1),
    Name: z.string().trim().min(1),
    Type: z.string().trim().min(1),
    Currency: z.string().trim().min(1),
    ISIN: z.string().nullish(),
    isPrimary: z.boolean().optional(),
  })
  .passthrough();

const barRow = z
  .object({
    date: z.string(),
    open: z.union([z.string(), z.number()]).nullish(),
    high: z.union([z.string(), z.number()]).nullish(),
    low: z.union([z.string(), z.number()]).nullish(),
    close: z.union([z.string(), z.number()]),
    adjusted_close: z.union([z.string(), z.number()]).nullish(),
    volume: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

const idMappingPayload = z.object({
  meta: z.object({
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  }),
  data: z.array(
    z.object({ symbol: z.string(), isin: z.string().nullish() }).passthrough(),
  ),
});

function retryDate(response: Response) {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return new Date(Date.now() + seconds * 1000);
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function validDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

async function providerFailure(provider: string, response: Response) {
  const body = (await response.text()).slice(0, 500).toLowerCase();
  const code = String(response.status);
  if (response.status === 401)
    return new MarketProviderError(
      "authentication_error",
      `${provider} rejected its credentials.`,
      code,
    );
  if (response.status === 429) {
    const quota =
      body.includes("daily") ||
      body.includes("quota") ||
      body.includes("limit for the day");
    let retryAt = retryDate(response);
    if (quota && !retryAt) {
      retryAt = new Date();
      retryAt.setUTCDate(retryAt.getUTCDate() + 1);
      retryAt.setUTCHours(0, 0, 5, 0);
    }
    return new MarketProviderError(
      quota ? "quota_exhausted" : "rate_limited",
      `${provider} request capacity was reached.`,
      code,
      retryAt,
    );
  }
  if (response.status === 403)
    return new MarketProviderError(
      body.includes("token") || body.includes("invalid")
        ? "authentication_error"
        : "not_entitled",
      `${provider} denied access to this dataset.`,
      code,
    );
  return new MarketProviderError(
    response.status >= 500 ? "provider_unavailable" : "invalid_provider_data",
    response.status >= 500
      ? `${provider} is temporarily unavailable.`
      : `${provider} rejected the request.`,
    code,
  );
}

export class EODHDClient {
  constructor(
    private gate: EODHDRequestGate,
    private config: Pick<
      Config,
      "EODHD_API_TOKEN" | "EODHD_DAILY_LIMIT" | "EODHD_PER_MINUTE_LIMIT"
    >,
    private transport: typeof fetch = fetch,
  ) {}

  private async json(url: URL) {
    return this.gate.run(async () => {
      let response: Response;
      try {
        response = await this.transport(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
      } catch {
        throw new MarketProviderError(
          "provider_unavailable",
          "EODHD could not be reached.",
        );
      }
      if (!response.ok) throw await providerFailure("EODHD", response);
      try {
        return await response.json();
      } catch {
        throw new MarketProviderError(
          "invalid_provider_data",
          "EODHD returned unreadable JSON.",
        );
      }
    });
  }

  async searchExact(
    query: string,
    expectedIsin: string,
  ): Promise<EodhdListing[]> {
    const normalized = expectedIsin.trim().toUpperCase();
    const url = new URL(
      `https://eodhd.com/api/search/${encodeURIComponent(query.trim())}`,
    );
    url.searchParams.set("api_token", this.config.EODHD_API_TOKEN);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "500");
    const payload = await this.json(url);
    if (!Array.isArray(payload))
      throw new MarketProviderError(
        "invalid_provider_data",
        "EODHD search returned an unexpected payload.",
      );
    return payload.flatMap((value) => {
      const parsed = listingRow.safeParse(value);
      if (!parsed.success) return [];
      const row = parsed.data;
      if (row.ISIN?.trim().toUpperCase() !== normalized) return [];
      const currency = row.Currency.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return [];
      return [
        {
          providerSymbol: `${row.Code}.${row.Exchange}`,
          ticker: row.Code,
          exchange: row.Exchange,
          name: row.Name,
          type: row.Type,
          currency,
          isin: normalized,
          isPrimary: row.isPrimary ?? false,
        },
      ];
    });
  }

  async searchIsin(isin: string): Promise<EodhdListing[]> {
    return this.searchExact(isin, isin);
  }

  async mapIsin(isin: string): Promise<string[]> {
    const normalized = isin.trim().toUpperCase();
    const symbols = new Set<string>();
    const url = new URL("https://eodhd.com/api/id-mapping");
    url.searchParams.set("api_token", this.config.EODHD_API_TOKEN);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("filter[isin]", normalized);
    url.searchParams.set("page[limit]", "1000");
    url.searchParams.set("page[offset]", "0");
    const parsed = idMappingPayload.safeParse(await this.json(url));
    if (!parsed.success)
      throw new MarketProviderError(
        "invalid_provider_data",
        "EODHD identifier mapping returned an unexpected payload.",
      );
    for (const row of parsed.data.data)
      if (
        row.isin?.trim().toUpperCase() === normalized &&
        /^[^\s.]+\.[^\s.]+$/.test(row.symbol.trim())
      )
        symbols.add(row.symbol.trim());
    return [...symbols];
  }

  async daily(symbol: string, from: string, to: string): Promise<EodBar[]> {
    const url = new URL(
      `https://eodhd.com/api/eod/${encodeURIComponent(symbol)}`,
    );
    url.searchParams.set("api_token", this.config.EODHD_API_TOKEN);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("period", "d");
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("order", "a");
    const payload = await this.json(url);
    if (!Array.isArray(payload))
      throw new MarketProviderError(
        "invalid_provider_data",
        "EODHD daily history returned an unexpected payload.",
      );
    const bars = payload.flatMap((value) => {
      const parsed = barRow.safeParse(value);
      if (!parsed.success) return [];
      const row = parsed.data;
      if (!validDateOnly(row.date)) return [];
      const decimal = (value: string | number | null | undefined) => {
        if (value === null || value === undefined) return null;
        try {
          const number = new Decimal(value);
          return number.isFinite() && number.gte(0) ? money(number) : null;
        } catch {
          return null;
        }
      };
      const close = decimal(row.close);
      if (!close || new Decimal(close).lte(0)) return [];
      return [
        {
          date: row.date,
          open: decimal(row.open),
          high: decimal(row.high),
          low: decimal(row.low),
          close,
          adjustedClose: decimal(row.adjusted_close),
          volume: decimal(row.volume),
        },
      ];
    });
    if (payload.length && !bars.length)
      throw new MarketProviderError(
        "invalid_provider_data",
        "EODHD returned no valid daily bars.",
      );
    return bars;
  }
}

const figiRecord = z
  .object({
    figi: z.string().optional(),
    compositeFIGI: z.string().optional(),
    shareClassFIGI: z.string().optional(),
    ticker: z.string().optional(),
    name: z.string().optional(),
    exchCode: z.string().optional(),
    securityType: z.string().optional(),
  })
  .passthrough();

export interface OpenFigiEvidence {
  figi?: string;
  compositeFigi?: string;
  shareClassFigi?: string;
  ticker?: string;
  name?: string;
  exchangeCode?: string;
  securityType?: string;
}

export class OpenFigiClient {
  constructor(
    private cache: Cache,
    private apiKey = "",
    private transport: typeof fetch = fetch,
  ) {}

  private async consume() {
    const now = new Date();
    const window = this.apiKey
      ? Math.floor(now.getTime() / 6000)
      : now.toISOString().slice(0, 16);
    const key = `market-data:openfigi:mapping:${this.apiKey ? "keyed" : "anonymous"}:${window}`;
    try {
      const count = await this.cache.incr(key);
      await this.cache.expire(key, this.apiKey ? 12 : 120);
      if (count > 25)
        throw new MarketProviderError(
          "rate_limited",
          "The OpenFIGI mapping request limit was reached.",
          undefined,
          new Date(
            this.apiKey
              ? (Math.floor(now.getTime() / 6000) + 1) * 6000
              : Date.now() + 60000,
          ),
        );
    } catch (error) {
      if (error instanceof MarketProviderError) throw error;
      throw new MarketProviderError(
        "provider_unavailable",
        "Identity throttling is unavailable because Redis cannot be reached.",
      );
    }
  }

  async mapIsins(isins: string[]): Promise<Map<string, OpenFigiEvidence[]>> {
    const normalized = isins.map((isin) => isin.trim().toUpperCase());
    const batchSize = this.apiKey ? 100 : 10;
    const results = new Map<string, OpenFigiEvidence[]>();
    for (const isin of normalized) results.set(isin, []);
    for (let offset = 0; offset < normalized.length; offset += batchSize) {
      const batch = normalized.slice(offset, offset + batchSize);
      await this.consume();
      const jobs = await this.request(batch);
      for (let index = 0; index < batch.length; index++) {
        const isin = batch[index]!;
        const job = jobs[index];
        if (!job || job.error) continue;
        results.set(isin, this.parseEvidence(job.data ?? []));
      }
    }
    return results;
  }

  async mapIsin(isin: string): Promise<OpenFigiEvidence[]> {
    const normalized = isin.trim().toUpperCase();
    return (await this.mapIsins([normalized])).get(normalized) ?? [];
  }

  private async request(isins: string[]) {
    let response: Response;
    try {
      response = await this.transport("https://api.openfigi.com/v3/mapping", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.apiKey ? { "X-OPENFIGI-APIKEY": this.apiKey } : {}),
        },
        body: JSON.stringify(
          isins.map((isin) => ({ idType: "ID_ISIN", idValue: isin })),
        ),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
    } catch {
      throw new MarketProviderError(
        "provider_unavailable",
        "OpenFIGI could not be reached.",
      );
    }
    if (!response.ok) throw await providerFailure("OpenFIGI", response);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MarketProviderError(
        "invalid_provider_data",
        "OpenFIGI returned unreadable JSON.",
      );
    }
    if (!Array.isArray(payload) || payload.length !== isins.length)
      throw new MarketProviderError(
        "invalid_provider_data",
        "OpenFIGI returned an unexpected mapping payload.",
      );
    return payload.map((value) => {
      if (!value || typeof value !== "object")
        throw new MarketProviderError(
          "invalid_provider_data",
          "OpenFIGI returned an invalid mapping job.",
        );
      return value as {
        data?: unknown[];
        error?: string;
        warning?: string;
      };
    });
  }

  private parseEvidence(data: unknown[]) {
    return data.flatMap((value) => {
      const parsed = figiRecord.safeParse(value);
      if (!parsed.success) return [];
      const row = parsed.data;
      return [
        {
          figi: row.figi,
          compositeFigi: row.compositeFIGI,
          shareClassFigi: row.shareClassFIGI,
          ticker: row.ticker,
          name: row.name,
          exchangeCode: row.exchCode,
          securityType: row.securityType,
        },
      ];
    });
  }
}

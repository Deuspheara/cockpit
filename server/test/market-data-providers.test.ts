import { describe, expect, it } from "vitest";
import type { Cache } from "../src/shared/cache.js";
import {
  EODHDClient,
  MarketProviderError,
  OpenFigiClient,
} from "../src/modules/market-data/providers.js";

function cache() {
  const values = new Map<string, number>();
  return {
    async incr(key: string) {
      const value = (values.get(key) ?? 0) + 1;
      values.set(key, value);
      return value;
    },
    async expire() {
      return true;
    },
  } as unknown as Cache;
}

const response = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("shared market-data providers", () => {
  it("keeps only exact-ISIN EODHD listings and ignores malformed rows", async () => {
    const transport: typeof fetch = async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/search/US0378331005");
      expect(url.searchParams.get("limit")).toBe("100");
      return response([
        {
          Code: "AAPL",
          Exchange: "US",
          Name: "Apple Inc",
          Type: "Common Stock",
          Currency: "USD",
          ISIN: "us0378331005",
          isPrimary: true,
        },
        {
          Code: "WRONG",
          Exchange: "US",
          Name: "Different security",
          Type: "Common Stock",
          Currency: "USD",
          ISIN: "US5949181045",
        },
        { Code: "BROKEN" },
      ]);
    };
    const client = new EODHDClient(
      cache(),
      {
        EODHD_API_TOKEN: "test",
        EODHD_DAILY_LIMIT: 20,
        EODHD_PER_MINUTE_LIMIT: 20,
      },
      transport,
    );
    await expect(client.searchIsin("US0378331005")).resolves.toEqual([
      expect.objectContaining({
        providerSymbol: "AAPL.US",
        isin: "US0378331005",
        isPrimary: true,
      }),
    ]);
  });

  it("preserves date-only raw and adjusted EOD values while rejecting invalid bars", async () => {
    const client = new EODHDClient(
      cache(),
      {
        EODHD_API_TOKEN: "test",
        EODHD_DAILY_LIMIT: 20,
        EODHD_PER_MINUTE_LIMIT: 20,
      },
      async () =>
        response([
          {
            date: "2026-09-04",
            open: "229.10",
            high: "231.00",
            low: "228.50",
            close: "230.25",
            adjusted_close: "229.75",
            volume: 1234,
          },
          { date: "not-a-date", close: 12 },
          { date: "2026-02-30", close: 12 },
          { date: "2026-09-05", close: -1 },
        ]),
    );
    await expect(
      client.daily("AAPL.US", "2026-09-01", "2026-09-05"),
    ).resolves.toEqual([
      {
        date: "2026-09-04",
        open: "229.100000000000000000",
        high: "231.000000000000000000",
        low: "228.500000000000000000",
        close: "230.250000000000000000",
        adjustedClose: "229.750000000000000000",
        volume: "1234.000000000000000000",
      },
    ]);
  });

  it("paginates EODHD identifier mapping and accepts only the requested ISIN", async () => {
    const offsets: string[] = [];
    const client = new EODHDClient(
      cache(),
      {
        EODHD_API_TOKEN: "test",
        EODHD_DAILY_LIMIT: 20,
        EODHD_PER_MINUTE_LIMIT: 20,
      },
      async (input) => {
        const url = new URL(String(input));
        const offset = url.searchParams.get("page[offset]")!;
        offsets.push(offset);
        expect(url.searchParams.get("filter[isin]")).toBe("US0378331005");
        return offset === "0"
          ? response({
              meta: { total: 1001, limit: 1000, offset: 0 },
              data: [
                { symbol: "AAPL.US", isin: "US0378331005" },
                { symbol: "WRONG.US", isin: "US5949181045" },
              ],
            })
          : response({
              meta: { total: 1001, limit: 1000, offset: 1000 },
              data: [{ symbol: "APC.XETRA", isin: "US0378331005" }],
            });
      },
    );
    await expect(client.mapIsin("us0378331005")).resolves.toEqual([
      "AAPL.US",
      "APC.XETRA",
    ]);
    expect(offsets).toEqual(["0", "1000"]);
  });

  it("classifies provider quota responses and honors Retry-After", async () => {
    const client = new EODHDClient(
      cache(),
      {
        EODHD_API_TOKEN: "test",
        EODHD_DAILY_LIMIT: 20,
        EODHD_PER_MINUTE_LIMIT: 20,
      },
      async () =>
        response({ error: "daily quota exceeded" }, 429, {
          "retry-after": "60",
        }),
    );
    const error = await client
      .searchIsin("US0378331005")
      .catch((value) => value);
    expect(error).toBeInstanceOf(MarketProviderError);
    expect(error).toMatchObject({
      failure: "quota_exhausted",
      providerCode: "429",
    });
    expect(error.retryAt).toBeInstanceOf(Date);
  });

  it("batches OpenFIGI at the unkeyed limit and handles errors per job", async () => {
    const sizes: number[] = [];
    const client = new OpenFigiClient(cache(), "", async (_input, init) => {
      const jobs = JSON.parse(String(init?.body)) as { idValue: string }[];
      sizes.push(jobs.length);
      return response(
        jobs.map((job, index) =>
          index === 0
            ? { error: "No identifier found." }
            : {
                data: [
                  {
                    figi: `FIGI-${job.idValue}`,
                    ticker: "TEST",
                    exchCode: "US",
                  },
                ],
              },
        ),
      );
    });
    const isins = Array.from(
      { length: 11 },
      (_, index) => `US${String(index).padStart(9, "0")}0`,
    );
    const mapped = await client.mapIsins(isins);
    expect(sizes).toEqual([10, 1]);
    expect(mapped.get(isins[0]!)).toEqual([]);
    expect(mapped.get(isins[1]!)?.[0]).toMatchObject({
      ticker: "TEST",
      exchangeCode: "US",
    });
    expect(mapped.get(isins[10]!)).toEqual([]);
  });
});

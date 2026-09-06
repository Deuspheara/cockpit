import { describe, it, expect } from "vitest";
import { AlchemyPortfolioAdapter } from "../src/modules/integrations/alchemy/adapter.js";
import { aggregateHistory } from "../src/modules/portfolio/valuation-history.js";
import type { Account } from "../src/modules/accounts/schemas.js";
const account = { externalAddress: "0x" + "a".repeat(40) } as Account;
const contract = "0x" + "b".repeat(40);
describe("EVM valuation recovery", () => {
  it("uses exact network/contract fallback, preserves quote dates and caches repeated misses", async () => {
    let lookups = 0;
    const at = new Date().toISOString();
    const adapter = new AlchemyPortfolioAdapter(
      "fixture",
      ["base-mainnet"],
      async (url, init) => {
        if (String(url).includes("/prices/")) {
          lookups++;
          expect(JSON.parse(String(init?.body)).addresses).toEqual([
            { network: "base-mainnet", address: contract },
          ]);
          return Response.json({
            data: [
              {
                network: "eth-mainnet",
                address: contract,
                prices: [{ currency: "usd", value: "999", lastUpdatedAt: at }],
              },
              {
                network: "base-mainnet",
                address: contract,
                prices: [{ currency: "usd", value: "2", lastUpdatedAt: at }],
              },
            ],
          });
        }
        return Response.json({
          data: {
            tokens: [
              {
                network: "base-mainnet",
                tokenAddress: contract,
                tokenBalance: "0xf4240",
                tokenMetadata: { decimals: 6, symbol: "USDC", name: "Token" },
                tokenPrices: [],
              },
            ],
          },
        });
      },
    );
    for (let i = 0; i < 2; i++) {
      const result = await adapter.syncAccount(account);
      expect(result.positions[0]).toMatchObject({
        quantity: "1.000000000000000000",
        marketValue: "2.000000000000000000",
        metadata: { priceQuotedAt: at },
      });
      expect(result.warnings).toEqual([]);
    }
    expect(lookups).toBe(1);
  });
  it("never guesses a peg or accepts future and stale quotes", async () => {
    let lookups = 0;
    const adapter = new AlchemyPortfolioAdapter(
      "fixture",
      ["base-mainnet"],
      async (url) => {
        if (String(url).includes("/prices/")) {
          lookups++;
          return Response.json({ data: [] });
        }
        return Response.json({
          data: {
            tokens: [
              {
                network: "base-mainnet",
                tokenAddress: contract,
                tokenBalance: "0x1",
                tokenMetadata: {
                  decimals: 0,
                  symbol: "USDC",
                  name: "Unknown stablecoin",
                },
                tokenPrices: [
                  {
                    currency: "usd",
                    value: "1",
                    lastUpdatedAt: "2000-01-01T00:00:00Z",
                  },
                ],
              },
            ],
          },
        });
      },
    );
    const result = await adapter.syncAccount(account);
    await adapter.syncAccount(account);
    expect(result.positions[0]?.marketValue).toBeUndefined();
    expect(result.coveredScopes).toEqual(["base-mainnet"]);
    expect(lookups).toBe(1);
  });
});
describe("coverage-aware historical aggregation", () => {
  const accounts = [
    { id: "a", name: "Base" },
    { id: "b", name: "Broker" },
  ];
  it("shows known values, names absent accounts, and separates coverage changes", () => {
    const chart = aggregateHistory(
      [
        {
          accountId: "a",
          at: "2026-01-01T10:00:00Z",
          value: "12",
          complete: false,
          coverage: { valued: ["ETH"], missing: [] },
          source: "recorded_snapshot",
        },
        {
          accountId: "a",
          at: "2026-01-02T10:00:00Z",
          value: "13",
          complete: true,
          coverage: {},
          source: "recorded_snapshot",
        },
        {
          accountId: "b",
          at: "2026-01-02T11:00:00Z",
          value: "20",
          complete: true,
          coverage: {},
          source: "provider",
        },
        {
          accountId: "a",
          at: "2026-01-03T10:00:00Z",
          value: "14",
          complete: false,
          coverage: { valued: ["ETH"], missing: [] },
          source: "recorded_snapshot",
        },
      ],
      accounts,
      "1m",
    );
    expect(chart.map((p) => p.value)).toEqual([
      "12.000000000000000000",
      "33.000000000000000000",
      "14.000000000000000000",
    ]);
    expect(chart[0]?.coverage.missing[0]?.name).toBe("Broker");
    expect(chart.map((p) => p.complete)).toEqual([false, true, false]);
    expect(new Set(chart.map((p) => p.segmentId)).size).toBe(3);
  });
  it("deduplicates multiple sources and breaks lines across missing buckets", () => {
    const chart = aggregateHistory(
      [
        {
          accountId: "a",
          at: "2026-01-01T10:00:00Z",
          value: "12",
          complete: true,
          coverage: {},
          source: "recorded_snapshot",
        },
        {
          accountId: "a",
          at: "2026-01-01T10:00:00Z",
          value: "999",
          complete: true,
          coverage: {},
          source: "provider",
        },
        {
          accountId: "a",
          at: "2026-01-03T10:00:00Z",
          value: "14",
          complete: true,
          coverage: {},
          source: "provider",
        },
      ],
      accounts.slice(0, 1),
      "1m",
    );
    expect(chart[0]?.value).toBe("12.000000000000000000");
    expect(chart[0]?.segmentId).not.toBe(chart[1]?.segmentId);
  });
});

describe("historical FX gaps", () => {
  it("does not turn an entirely unconvertible bucket into a zero point", () => {
    const rows = [
      {
        accountId: "a",
        at: "2026-01-01T00:00:00Z",
        value: null,
        complete: false,
        coverage: {
          valued: [],
          missing: [
            {
              code: "missing_fx",
              name: "USD/EUR",
              message: "Missing rate",
              retryable: true,
            },
          ],
        },
        source: "provider",
      },
    ];
    expect(aggregateHistory(rows, [{ id: "a", name: "Base" }], "1m")).toEqual(
      [],
    );
    const chart = aggregateHistory(
      [
        ...rows,
        {
          accountId: "b",
          at: rows[0]!.at,
          value: "20",
          complete: true,
          coverage: {},
          source: "recorded_snapshot",
        },
      ],
      [
        { id: "a", name: "Base" },
        { id: "b", name: "Broker" },
      ],
      "1m",
    );
    expect(chart[0]?.value).toBe("20.000000000000000000");
    expect(chart[0]?.coverage.missing[0]).toMatchObject({
      code: "missing_fx",
      retryAction: "fx",
    });
  });
});

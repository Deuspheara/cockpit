import { describe, it, expect } from "vitest";
import {
  extractionBlockers,
  extractionSchema,
  extractionWarnings,
  mergeExtractions,
  normalizeExtraction,
  validateExtraction,
} from "../src/modules/imports/schemas.js";
import { validateImage } from "../src/modules/imports/images.js";
import {
  EODHDMarketData,
  estimateQuantity,
  isEligiblePreviousClose,
} from "../src/modules/imports/market-data.js";
const position = {
  symbol: "CW8",
  quantity: "18.23",
  marketValue: "9483",
  currency: "EUR",
  confidence: 0.98,
};
describe("screenshot evidence validation", () => {
  it("keeps missing dates and value-only quantities as warnings, not a questionnaire", () => {
    const extraction = extractionSchema.parse({
      capturedAt: "2026-09-05T10:00:00Z",
      capturedAtInferred: true,
      positions: [{ ...position, quantity: null }],
    });
    expect(validateExtraction(extraction)).toEqual([]);
    expect(extractionWarnings(extraction)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("upload date"),
        expect.stringContaining("unknown quantity"),
      ]),
    );
    expect(extraction.transactions).toEqual([]);
    expect(extraction.positions[0]?.averageCost).toBeNull();
  });
  it("assigns stable candidate provenance and blocks incomplete option identity", () => {
    const extraction = normalizeExtraction(
      extractionSchema.parse({
        capturedAt: "2026-09-05T10:00:00Z",
        derivatives: [
          {
            name: "Put 195 USD",
            optionType: "put",
            strike: "195",
            expiration: "2026-12-18",
            marketValue: "14.57",
            currency: "USD",
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(extraction.derivatives[0]?.candidateId).toBeTruthy();
    expect(extractionBlockers(extraction)).toContain(
      "Put 195 USD needs its underlying, type, strike, and expiration.",
    );
  });
  it("deduplicates repeated screenshots but flags conflicting quantities and dates", () => {
    const first = extractionSchema.parse({
      capturedAt: "2026-08-31T00:00:00Z",
      positions: [position],
    });
    const repeated = mergeExtractions(first, first);
    expect(repeated.positions).toHaveLength(1);
    const conflicting = mergeExtractions(
      first,
      extractionSchema.parse({
        capturedAt: "2026-09-01T00:00:00Z",
        positions: [{ ...position, quantity: "16.23" }],
      }),
    );
    expect(
      validateExtraction(conflicting).some((q) =>
        q.includes("conflicting observations"),
      ),
    ).toBe(true);
    expect(
      extractionWarnings(conflicting).some((q) =>
        q.includes("possible conflict"),
      ),
    ).toBe(true);
  });
  it("rejects mismatched magic bytes, remote text and oversized image bodies", () => {
    expect(() =>
      validateImage(
        Buffer.from("https://example.com/image.png"),
        "image/png",
        1000,
      ),
    ).toThrow("matching image bytes");
    expect(() => validateImage(Buffer.alloc(100), "image/png", 10)).toThrow(
      "allowed size",
    );
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1200, 16);
    png.writeUInt32BE(2600, 20);
    expect(() => validateImage(png, "image/png", 1000)).not.toThrow();
    expect(() => validateImage(png, "image/jpeg", 1000)).toThrow();
  });
});

describe("EODHD enrichment safeguards", () => {
  function cache(initialBudget = 0) {
    const values = new Map<string, string>();
    let used = initialBudget;
    return {
      values,
      get: async (key: string) => values.get(key) ?? null,
      incr: async () => ++used,
      expire: async () => true,
      setEx: async (key: string, _seconds: number, value: string) => {
        values.set(key, value);
        return "OK";
      },
    };
  }
  it("uses exact decimal FX math and calendar-day quote eligibility", () => {
    expect(estimateQuantity("1783.70", "95.125", "1.02")).toBe("18.38344799");
    expect(
      isEligiblePreviousClose("2026-09-05T23:59:59Z", "2026-09-02T00:00:00Z"),
    ).toBe(true);
    expect(
      isEligiblePreviousClose("2026-09-05T00:00:00Z", "2026-09-01T23:59:59Z"),
    ).toBe(false);
    expect(
      isEligiblePreviousClose("2026-09-05T00:00:00Z", "2026-09-06T00:00:00Z"),
    ).toBe(false);
  });
  it("caches normalized searches so a unique instrument costs one call", async () => {
    const redis = cache();
    let requests = 0;
    const market = new EODHDMarketData(
      redis as never,
      { EODHD_API_TOKEN: "fixture", EODHD_DAILY_LIMIT: 20 },
      async () => {
        requests++;
        return Response.json([
          {
            Code: "IWDA",
            Exchange: "AS",
            Name: "iShares Core MSCI World UCITS ETF",
            Type: "ETF",
            Currency: "EUR",
            ISIN: "IE00B4L5Y983",
            previousClose: 101.25,
            previousCloseDate: "2026-09-04",
          },
        ]);
      },
    );
    const first = await market.search("  Core   MSCI World ");
    const second = await market.search("core msci world");
    expect(requests).toBe(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({
      providerKey: "IWDA.AS",
      price: "101.25",
      quotedAt: "2026-09-04T00:00:00.000Z",
    });
  });
  it("falls back without network access after the Redis daily budget", async () => {
    let requested = false;
    const market = new EODHDMarketData(
      cache(20) as never,
      { EODHD_API_TOKEN: "fixture", EODHD_DAILY_LIMIT: 20 },
      async () => {
        requested = true;
        return Response.json([]);
      },
    );
    expect(await market.search("IWDA")).toEqual([]);
    expect(requested).toBe(false);
  });
  it("falls back safely when the provider fails or returns invalid data", async () => {
    const failed = new EODHDMarketData(
      cache() as never,
      { EODHD_API_TOKEN: "fixture", EODHD_DAILY_LIMIT: 20 },
      async () => {
        throw new Error("offline");
      },
    );
    expect(await failed.search("IWDA")).toEqual([]);
  });
});

describe("explicit derivative label recovery", () => {
  it("moves a misclassified put into derivatives without inventing contract quantity", () => {
    const extraction = normalizeExtraction(
      extractionSchema.parse({
        positions: [
          {
            symbol: "AAPL",
            name: "Apple Put 195 USD 2026-12-18",
            unitPrice: "250",
            marketValue: "35",
            currency: "USD",
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(extraction.positions).toHaveLength(0);
    expect(extraction.derivatives[0]).toMatchObject({
      optionType: "put",
      underlyingSymbol: "AAPL",
      strike: "195",
      expiration: "2026-12-18",
      quantity: null,
      marketValue: "35",
    });
  });
  it("retains incomplete puts for review and leaves put strategy funds as funds", () => {
    const extraction = normalizeExtraction(
      extractionSchema.parse({
        positions: [
          { name: "Put 195 USD", marketValue: "35", confidence: 0.9 },
          {
            name: "Put Strategy ETF",
            symbol: "ETF",
            marketValue: "100",
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(extraction.derivatives[0]).toMatchObject({
      optionType: "put",
      underlyingSymbol: null,
      expiration: null,
    });
    expect(extraction.positions).toHaveLength(1);
  });
});

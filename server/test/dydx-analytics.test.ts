import { describe, it, expect } from "vitest";
import { DydxAdapter } from "../src/modules/integrations/dydx/adapter.js";
import { marketHistory } from "../src/modules/integrations/dydx/market-history.js";
import { parseECBHistory } from "../src/modules/integrations/fx.js";
import type { Account } from "../src/modules/accounts/schemas.js";
const account: Account = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test",
  assetClass: "crypto",
  sourceType: "dydx",
  baseCurrency: "EUR",
  externalAddress: "dydx1" + "q".repeat(38),
  externalSubaccount: 0,
  institution: null,
  metadata: {},
  isArchived: false,
  updatedAt: new Date(),
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
describe("dYdX equity, leverage and market history", () => {
  it("preserves reported equity/PnL and derives effective leverage without counting exposure as equity", async () => {
    const transport: typeof fetch = async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = new URL(String(input));
      expect(url.origin).toBe("https://indexer.dydx.trade");
      if (url.pathname === "/v4/pnl")
        return response({
          pnl: [
            {
              equity: "100",
              totalPnl: "20",
              netTransfers: "80",
              createdAt: "2026-08-01T00:00:00Z",
            },
          ],
        });
      if (url.pathname === "/v4/fills") return response({ fills: [] });
      return response({
        subaccount: {
          equity: "100",
          freeCollateral: "90",
          openPerpetualPositions: {
            BTC: {
              market: "BTC-USD",
              side: "LONG",
              size: "1",
              entryPrice: "230",
              unrealizedPnl: "20",
              realizedPnl: "0",
            },
          },
          assetPositions: {
            USDC: { symbol: "USDC", size: "150", side: "SHORT" },
          },
        },
      });
    };
    const result = await new DydxAdapter(transport).syncAccount(account, {});
    expect(result.positions[0]?.leverage).toBe("2.500000000000000000");
    expect(result.metadata?.derivatives).toMatchObject({
      equity: "100.000000000000000000",
      grossExposure: "250.000000000000000000",
      freeCollateral: "90.000000000000000000",
    });
    expect(result.history).toHaveLength(2);
    expect(result.history?.[0]?.netTransfers).toBe("80.000000000000000000");
    expect(result.warnings).toEqual([]);
  });
  it("retains dated USD references independently instead of assigning every rate the latest date", () => {
    const days = parseECBHistory(
      "<Cube><Cube time='2026-08-01'><Cube currency='USD' rate='1.2'/></Cube><Cube time='2026-07-31'><Cube currency='USD' rate='1.1'/></Cube></Cube>",
    );
    expect(days.map((d) => [d.date, d.quotes[0]?.rate])).toEqual([
      ["2026-08-01", "1.2"],
      ["2026-07-31", "1.1"],
    ]);
  });
  it("uses actual candle closes and sorts timestamps without projecting current holdings backwards", async () => {
    const now = Date.now();
    const times = [
      new Date(now - 3600000).toISOString(),
      new Date(now - 7200000).toISOString(),
    ];
    const result = await marketHistory("BTC-USD", "1d", async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v4/candles/perpetualMarkets/BTC-USD");
      expect(url.searchParams.get("resolution")).toBe("1HOUR");
      return response({
        candles: [
          { startedAt: times[0], close: "250" },
          { startedAt: times[1], close: "240" },
        ],
      });
    });
    expect(result.chart.map((p) => p.value)).toEqual([
      "240.000000000000000000",
      "250.000000000000000000",
    ]);
  });
  it("backfills hourly equity past the first 100 records so the week has uniform coverage", async () => {
    const records = Array.from({ length: 300 }, (_, i) => ({
      createdAt: new Date(Date.UTC(2026, 8, 5) - i * 3600000).toISOString(),
      equity: "100",
      totalPnl: "20",
      netTransfers: "80",
    }));
    const result = await new DydxAdapter(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v4/pnl") {
        if (url.searchParams.get("daily") === "true")
          return response({ pnl: [] });
        const before = url.searchParams.get("createdBeforeOrAt");
        return response({
          pnl: records
            .filter((p) => !before || p.createdAt <= before)
            .slice(0, 100),
        });
      }
      if (url.pathname === "/v4/fills") return response({ fills: [] });
      return response({
        subaccount: {
          equity: "0",
          openPerpetualPositions: {},
          assetPositions: {},
        },
      });
    }).syncAccount(account, {});
    expect(result.history).toHaveLength(300);
    expect(new Set(result.history?.map((p) => p.at)).size).toBe(300);
  });
});

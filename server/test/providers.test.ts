import { describe, it, expect } from "vitest";
import { HyperliquidAdapter } from "../src/modules/integrations/hyperliquid/adapter.js";
import { DydxAdapter } from "../src/modules/integrations/dydx/adapter.js";
import { AlchemyPortfolioAdapter } from "../src/modules/integrations/alchemy/adapter.js";
import { parseECB } from "../src/modules/integrations/fx.js";
import { Decimal, money } from "../src/shared/decimal.js";
import type { Account } from "../src/modules/accounts/schemas.js";
const account: Account = {
  id: "00000000-0000-4000-8000-000000000003",
  name: "Public account",
  assetClass: "crypto",
  sourceType: "hyperliquid",
  institution: null,
  baseCurrency: "EUR",
  externalAddress: "0x" + "1".repeat(40),
  externalSubaccount: 0,
  metadata: {},
  isArchived: false,
  updatedAt: new Date(),
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
describe("read-only provider HTTP boundaries", () => {
  it("values Hyperliquid margin using raw quote balance plus signed exposure, not equity plus notional", async () => {
    const transport: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://api.hyperliquid.xyz/info");
      const request = JSON.parse(String(init?.body)) as { type: string };
      switch (request.type) {
        case "clearinghouseState":
          return json({
            marginSummary: { accountValue: "110", totalRawUsd: "10" },
            assetPositions: [
              {
                position: {
                  coin: "ETH",
                  szi: "1",
                  positionValue: "100",
                  entryPx: "90",
                  unrealizedPnl: "10",
                  liquidationPx: null,
                  leverage: { value: 10 },
                },
              },
            ],
          });
        case "spotClearinghouseState":
          return json({ balances: [{ coin: "USDC", token: 0, total: "20" }] });
        case "spotMetaAndAssetCtxs":
          return json([{ tokens: [], universe: [] }, []]);
        case "userFillsByTime":
          return json([
            {
              coin: "ETH",
              side: "B",
              sz: "1",
              px: "90",
              fee: "0.01",
              time: 1700000000000,
              tid: 123,
            },
          ]);
        case "subAccounts":
          return json(null);
        default:
          throw new Error("Non-allowlisted request");
      }
    };
    const result = await new HyperliquidAdapter(transport).syncAccount(
      account,
      {},
    );
    expect(result.coveredScopes).toEqual(["perps", "spot"]);
    expect(
      money(
        result.positions.reduce(
          (s, p) => s.plus(p.marketValue ?? 0),
          new Decimal(0),
        ),
      ),
    ).toBe("130.000000000000000000");
    expect(result.transactions[0]?.externalId).toBe("123");
    expect(result.warnings).toEqual([]);
  });
  it("marks unavailable provider sections partial rather than claiming a zero balance", async () => {
    const transport: typeof fetch = async (_input, init) => {
      const { type } = JSON.parse(String(init?.body)) as { type: string };
      if (type === "spotClearinghouseState")
        return json({ balances: [{ coin: "USDC", token: 0, total: "5" }] });
      if (type === "spotMetaAndAssetCtxs")
        return json([{ tokens: [], universe: [] }, []]);
      if (type === "userFillsByTime") return json([]);
      if (type === "subAccounts") return json(null);
      return json({ unexpected: true });
    };
    const result = await new HyperliquidAdapter(transport).syncAccount(
      account,
      {},
    );
    expect(result.coveredScopes).toEqual(["spot"]);
    expect(result.warnings[0]).toContain("last known");
    expect(result.positions.some((p) => p.scope === "perps")).toBe(false);
  });
  it("dYdX short notional offsets the quote collateral and keeps public account calls GET-only", async () => {
    const transport: typeof fetch = async (input, init) => {
      expect(init?.method).toBe("GET");
      expect(String(input)).toMatch(
        /^https:\/\/indexer\.dydx\.trade\/v4\/(addresses|fills)/,
      );
      return String(input).includes("/fills?")
        ? json({
            fills: [
              {
                id: "fill-1",
                market: "ETH-USD",
                side: "SELL",
                size: "1",
                price: "100",
                fee: "0",
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
          })
        : json({
            subaccount: {
              equity: "110",
              assetPositions: {
                USDC: { symbol: "USDC", size: "200", side: "LONG" },
              },
              openPerpetualPositions: {
                ETH: {
                  market: "ETH-USD",
                  side: "SHORT",
                  size: "-1",
                  entryPrice: "100",
                  unrealizedPnl: "10",
                  realizedPnl: "0",
                },
              },
            },
          });
    };
    const result = await new DydxAdapter(transport).syncAccount(
      {
        ...account,
        sourceType: "dydx",
        externalAddress: "dydx1" + "q".repeat(38),
      },
      {},
    );
    expect(result.warnings).toEqual([]);
    expect(result.transactions[0]?.externalId).toBe("fill-1");
    expect(
      money(
        result.positions.reduce(
          (s, p) => s.plus(p.marketValue ?? 0),
          new Decimal(0),
        ),
      ),
    ).toBe("110.000000000000000000");
  });
  it("checks Alchemy HTTP-200 partial errors and retains full token precision", async () => {
    const transport: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(
        "https://api.g.alchemy.com/data/v1/test-key/assets/tokens/by-address",
      );
      const body = JSON.parse(String(init?.body)) as {
        addresses: { networks: string[] }[];
      };
      const network = body.addresses[0]!.networks[0]!;
      if (network === "base-mainnet")
        return json({
          data: { tokens: [] },
          error: { partialErrors: [{ network }] },
        });
      return json({
        data: {
          tokens: [
            {
              network,
              tokenAddress: null,
              tokenBalance: "0xde0b6b3a7640001",
              tokenMetadata: { decimals: 18, name: "Ethereum", symbol: "ETH" },
              tokenPrices: [
                {
                  currency: "usd",
                  value: "2000",
                  lastUpdatedAt: "2026-01-01T00:00:00Z",
                },
              ],
            },
          ],
        },
      });
    };
    const result = await new AlchemyPortfolioAdapter(
      "test-key",
      ["eth-mainnet", "base-mainnet"],
      transport,
    ).syncAccount(account);
    expect(result.coveredScopes).toEqual(["eth-mainnet"]);
    expect(result.positions[0]?.quantity).toBe("1.000000000000000001");
    expect(result.warnings[0]).toContain("base-mainnet");
  });
  it("rejects missing Alchemy configuration and validates dated ECB decimal quotes", async () => {
    await expect(
      new AlchemyPortfolioAdapter("", [], fetch).syncAccount(account),
    ).rejects.toThrow("ALCHEMY_API_KEY");
    expect(
      parseECB(
        "<Cube time='2026-09-04'><Cube currency='USD' rate='1.1622'/></Cube>",
      ).quotes[0],
    ).toEqual({ currency: "USD", rate: "1.1622" });
    expect(() => parseECB("<Cube/>")).toThrow("Invalid ECB");
  });
  it("dYdX backfills beyond two pages while still fetching latest fills each sync", async () => {
    const fills = Array.from({ length: 350 }, (_, i) => ({
      id: `fill-${i}`,
      market: "ETH-USD",
      side: "BUY",
      size: "1",
      price: "10",
      fee: "0",
      createdAt: new Date(Date.UTC(2026, 0, 1) - i * 60000).toISOString(),
    }));
    let latestRequests = 0;
    const transport: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/fills"))
        return json({
          subaccount: {
            equity: "0",
            openPerpetualPositions: {},
            assetPositions: {},
          },
        });
      const before = url.searchParams.get("createdBeforeOrAt");
      if (!before) latestRequests++;
      return json({
        fills: fills
          .filter((f) => !before || f.createdAt <= before)
          .slice(0, 100),
      });
    };
    const adapter = new DydxAdapter(transport);
    let cursor: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await adapter.syncAccount(
        {
          ...account,
          sourceType: "dydx",
          externalAddress: "dydx1" + "q".repeat(38),
        },
        cursor,
      );
      cursor = result.cursor;
      for (const fill of result.transactions) seen.add(fill.externalId);
    }
    expect(seen.size).toBe(350);
    expect(latestRequests).toBe(5);
    expect(cursor.historyComplete).toBe("yes");
  });
});

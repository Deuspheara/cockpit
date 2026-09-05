import { describe, it, expect } from "vitest";
import { AlchemyPortfolioAdapter } from "../src/modules/integrations/alchemy/adapter.js";
import type { Account } from "../src/modules/accounts/schemas.js";
const account = { externalAddress: "0x" + "a".repeat(40) } as Account;
describe("Alchemy-specific network failures", () => {
  it("reports missing configuration before making a request", async () => {
    const adapter = new AlchemyPortfolioAdapter(
      "",
      ["eth-mainnet"],
      async () => {
        throw new Error("must not call");
      },
    );
    await expect(adapter.syncAccount(account)).rejects.toMatchObject({
      code: "ALCHEMY_NOT_CONFIGURED",
    });
  });
  it("identifies rejected credentials per network", async () => {
    const adapter = new AlchemyPortfolioAdapter(
      "invalid",
      ["eth-mainnet", "base-mainnet"],
      async () => new Response("unauthorized", { status: 401 }),
    );
    const result = await adapter.syncAccount(account);
    expect(result.coveredScopes).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(
      result.warnings.every((warning) =>
        warning.includes("Alchemy rejected the API key"),
      ),
    ).toBe(true);
  });
  it("retains successful network coverage while reporting unavailable networks", async () => {
    const adapter = new AlchemyPortfolioAdapter(
      "fixture",
      ["eth-mainnet", "base-mainnet"],
      async (_url, init) => {
        if (
          JSON.parse(String(init?.body)).addresses[0].networks[0] ===
          "base-mainnet"
        )
          throw new DOMException("timeout", "TimeoutError");
        return new Response(JSON.stringify({ data: { tokens: [] } }));
      },
    );
    const result = await adapter.syncAccount(account);
    expect(result.coveredScopes).toEqual(["eth-mainnet"]);
    expect(result.warnings).toEqual([
      "base-mainnet: Alchemy unavailable; last known positions retained",
    ]);
  });
  it("does not claim coverage for a completely unavailable provider", async () => {
    const adapter = new AlchemyPortfolioAdapter(
      "fixture",
      ["eth-mainnet", "base-mainnet", "arb-mainnet"],
      async () => {
        throw new Error("offline");
      },
    );
    const result = await adapter.syncAccount(account);
    expect(result.coveredScopes).toEqual([]);
    expect(result.warnings).toHaveLength(3);
    expect(result.positions).toEqual([]);
  });
});

describe("Alchemy HTTP 200 optional enrichment", () => {
  const native = {
    network: "base-mainnet",
    tokenAddress: null,
    tokenBalance: "0xde0b6b3a7640000",
    tokenMetadata: { decimals: null, name: null, symbol: null },
    tokenPrices: null,
  };
  function adapter(tokens: unknown[], extra = {}) {
    return new AlchemyPortfolioAdapter("fixture", ["base-mainnet"], async () =>
      Response.json({ data: { tokens }, ...extra }),
    );
  }
  it("accepts the dashboard's zero native balance with null metadata fields", async () => {
    const result = await adapter([
      { ...native, tokenBalance: "0x0000" },
    ]).syncAccount(account);
    expect(result.coveredScopes).toEqual(["base-mainnet"]);
    expect(result.positions).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
  it("uses native ETH decimals and keeps quantities when price enrichment fails", async () => {
    const result = await adapter([
      { ...native, error: { message: "price missing" } },
    ]).syncAccount(account);
    expect(result.coveredScopes).toEqual(["base-mainnet"]);
    expect(result.positions[0]).toMatchObject({
      quantity: "1.000000000000000000",
      asset: { symbol: "ETH" },
    });
    expect(result.positions[0]!.marketValue).toBeUndefined();
    expect(result.warnings.join(" ")).not.toContain("Alchemy unavailable");
  });
  it("isolates a malformed token and unknown ERC20 decimals without dropping usable balances", async () => {
    const result = await adapter([
      native,
      { broken: true },
      {
        ...native,
        tokenAddress: "0x" + "b".repeat(40),
      },
    ]).syncAccount(account);
    expect(result.positions).toHaveLength(1);
    expect(result.coveredScopes).toEqual([]);
    expect(result.warnings.join(" ")).toContain("decimals");
  });
  it("retains data from HTTP 200 partial errors without claiming full network coverage", async () => {
    const result = await adapter([native], {
      error: { partialErrors: [{ network: "base-mainnet" }] },
    }).syncAccount(account);
    expect(result.positions).toHaveLength(1);
    expect(result.coveredScopes).toEqual([]);
    const empty = await adapter([], {
      error: { partialErrors: [{ network: "base-mainnet" }] },
    }).syncAccount(account);
    expect(empty.failure?.code).toBe("ALCHEMY_INCOMPLETE_DATA");
  });
  it("keeps earlier pages when a later page fails", async () => {
    let calls = 0;
    const result = await new AlchemyPortfolioAdapter(
      "fixture",
      ["base-mainnet"],
      async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(request.addresses[0].networks).toEqual(["base-mainnet"]);
        expect(request.withMetadata).toBe(true);
        if (calls++ === 0)
          return Response.json({ data: { tokens: [native], pageKey: "next" } });
        expect(request.pageKey).toBe("next");
        return new Response("forbidden", { status: 403 });
      },
    ).syncAccount(account);
    expect(result.positions).toHaveLength(1);
    expect(result.coveredScopes).toEqual([]);
    expect(result.failure?.code).toBe("ALCHEMY_AUTH_FAILED");
  });
});

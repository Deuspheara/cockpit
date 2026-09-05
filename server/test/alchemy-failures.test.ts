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

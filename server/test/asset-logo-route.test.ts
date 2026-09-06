import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFinanceRoutes } from "../src/modules/routes.js";
import { AccountService } from "../src/modules/accounts/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
import { AssetLogoService } from "../src/modules/assets/logos.js";
import { readConfig } from "../src/config.js";
import type { Database } from "../src/db/index.js";
import type { Cache } from "../src/shared/cache.js";

const accountId = "00000000-0000-4000-8000-000000000001";
const assetId = "00000000-0000-0000-0000-000000000002";
const row = {
  assetId,
  symbol: "BTC",
  name: "Bitcoin",
  assetType: "crypto",
  quantity: "1",
  marketValue: "100",
  currency: "USD",
  source: "manual",
};
afterEach(() => vi.restoreAllMocks());

describe("portfolio assets logo enrichment", () => {
  it.each([false, true])(
    "keeps holdings and navigation identifiers when enrichment fails: %s",
    async (fails) => {
      vi.spyOn(AccountService.prototype, "list").mockResolvedValue([
        { id: accountId, name: "Trading", assetClass: "crypto" },
      ] as Awaited<ReturnType<AccountService["list"]>>);
      vi.spyOn(PortfolioService.prototype, "positions").mockResolvedValue(
        new Map([[accountId, [row]]]),
      );
      const resolver = vi.spyOn(AssetLogoService.prototype, "resolveAll");
      if (fails) resolver.mockRejectedValue(new Error("provider failure"));
      else
        resolver.mockResolvedValue(
          new Map([
            [
              assetId,
              "https://static.coinpaprika.com/coin/btc-bitcoin/logo.png",
            ],
          ]),
        );
      const sql = vi.fn(async () => [{ id: assetId, assetType: "crypto" }]);
      const app = Fastify();
      try {
        await registerFinanceRoutes(
          app,
          { sql } as unknown as Database,
          {} as Cache,
          readConfig({
            DATABASE_URL: "postgres://localhost/test",
            REDIS_URL: "redis://localhost",
          }),
        );
        const response = await app.inject(
          "/api/v1/portfolio/assets?scope=crypto",
        );
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual([
          {
            ...row,
            accountId,
            accountName: "Trading",
            ...(fails
              ? {}
              : {
                  logoUrl:
                    "https://static.coinpaprika.com/coin/btc-bitcoin/logo.png",
                }),
          },
        ]);
        const filtered = await app.inject(
          "/api/v1/portfolio/assets?scope=equities",
        );
        expect(filtered.json()).toEqual([]);
        expect(sql).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );
});

it("archives through DELETE and invalidates cached portfolio responses", async () => {
  const archive = vi
    .spyOn(AccountService.prototype, "archive")
    .mockResolvedValue({ id: accountId, isArchived: true } as Awaited<
      ReturnType<AccountService["archive"]>
    >);
  const incr = vi.fn(async () => 2);
  const app = Fastify();
  try {
    await registerFinanceRoutes(
      app,
      {} as Database,
      { incr } as unknown as Cache,
      readConfig({
        DATABASE_URL: "postgres://localhost/test",
        REDIS_URL: "redis://localhost",
      }),
    );
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/accounts/${accountId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().isArchived).toBe(true);
    expect(archive).toHaveBeenCalledWith(accountId);
    expect(incr).toHaveBeenCalledWith("portfolio:revision");
  } finally {
    await app.close();
  }
});

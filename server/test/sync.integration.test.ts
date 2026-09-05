import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { AlchemyPortfolioAdapter } from "../src/modules/integrations/alchemy/adapter.js";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { connectCache } from "../src/shared/cache.js";
import { readConfig } from "../src/config.js";
import { AccountService } from "../src/modules/accounts/service.js";
import { SyncService } from "../src/modules/integrations/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
import type { ReadOnlyAccountProvider } from "../src/modules/integrations/types.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("provider persistence and failures", () => {
  let db: ReturnType<typeof connectDatabase>,
    cache: ReturnType<typeof connectCache>,
    sync: SyncService,
    accountId: string;
  let failure = false,
    closed = false;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    cache = connectCache(process.env.REDIS_URL!);
    accountId = (
      await new AccountService(db).create({
        name: "Sync test",
        assetClass: "crypto",
        sourceType: "dydx",
        externalAddress: "dydx1" + "q".repeat(38),
      })
    ).id;
    const provider: ReadOnlyAccountProvider = {
      kind: "dydx",
      async syncAccount() {
        if (failure) throw new Error("Network outage");
        const asset = {
          key: "dydx:test:cash",
          symbol: "USDC",
          name: "Test collateral",
          assetType: "cash" as const,
        };
        return {
          positions: closed
            ? []
            : [
                {
                  asset,
                  scope: "account",
                  quantity: "100",
                  currency: "USD",
                  marketValue: "100",
                },
              ],
          transactions: [
            {
              asset,
              externalId: "fill-unique-1",
              type: "DEPOSIT",
              quantity: "100",
              currency: "USD",
              occurredAt: "2026-01-01T00:00:00Z",
            },
          ],
          coveredScopes: ["account"],
          warnings: [],
          cursor: {},
        };
      },
    };
    sync = new SyncService(
      db,
      cache,
      readConfig({ ...process.env, DATABASE_URL: url }),
      { dydx: provider },
    );
    await db.sql`INSERT INTO fx_quotes(base_currency,quote_currency,rate,quoted_at,source) VALUES('USD','EUR','0.9',now(),'system')`;
  });
  afterAll(async () => {
    if (cache.isOpen) cache.destroy();
    await db.sql`TRUNCATE accounts,assets CASCADE`;
    await db.close();
  });
  const resetRateLimit = async () => {
    await db.sql`UPDATE sync_runs SET started_at=now()-interval '1 minute' WHERE account_id=${accountId}`;
  };
  it("imports duplicate provider events only once", async () => {
    await sync.sync(accountId);
    expect(
      (
        await new PortfolioService(db).dashboard(
          "crypto",
          "1m",
          "EUR",
          accountId,
        )
      ).chart.length,
    ).toBeGreaterThan(0);
    await resetRateLimit();
    await sync.sync(accountId);
    expect(
      await db.sql`SELECT id FROM transactions WHERE account_id=${accountId}`,
    ).toHaveLength(1);
    expect(
      (
        await new PortfolioService(db).dashboard(
          "crypto",
          "1m",
          "EUR",
          accountId,
        )
      ).value,
    ).toBe("90.000000000000000000");
  });
  it("preserves known value during a failed sync and marks stale", async () => {
    failure = true;
    await resetRateLimit();
    await expect(sync.sync(accountId)).rejects.toThrow("Provider");
    const view = await new PortfolioService(db).dashboard(
      "crypto",
      "1m",
      "EUR",
      accountId,
    );
    expect(view.value).toBe("90.000000000000000000");
    expect(view.accounts[0]?.stale).toBe(true);
  });
  it("closes a disappeared position only after a complete successful snapshot", async () => {
    failure = false;
    closed = true;
    await resetRateLimit();
    await sync.sync(accountId);
    expect(
      (
        await new PortfolioService(db).dashboard(
          "crypto",
          "1m",
          "EUR",
          accountId,
        )
      ).value,
    ).toBe("0.000000000000000000");
  });
  it("saves HTTP 200 native balances, exposes partial prices, and retries rejected Alchemy credentials", async () => {
    const wallet = await new AccountService(db).create({
      name: "Alchemy response fixture",
      assetClass: "crypto",
      sourceType: "evm_wallet",
      externalAddress: "0x" + "a".repeat(40),
    });
    let rejected = false;
    const provider = new AlchemyPortfolioAdapter(
      "fixture",
      ["base-mainnet"],
      async () =>
        rejected
          ? new Response("secret upstream text", { status: 401 })
          : Response.json({
              data: {
                tokens: [
                  {
                    network: "base-mainnet",
                    tokenAddress: null,
                    tokenBalance: "0xde0b6b3a7640000",
                    tokenMetadata: { symbol: null, name: null, decimals: null },
                    tokenPrices: null,
                  },
                ],
              },
            }),
    );
    const service = new SyncService(
      db,
      cache,
      readConfig({ ...process.env, DATABASE_URL: url }),
      { evm_wallet: provider },
    );
    const run = await service.enqueue(wallet.id);
    await service.runQueued();
    expect(await service.getRun(wallet.id, String(run!.id))).toMatchObject({
      status: "partial",
      provider: "alchemy",
    });
    const observations =
      await db.sql`SELECT quantity FROM holding_observations WHERE account_id=${wallet.id}`;
    expect(observations[0]!.quantity).toBe("1.000000000000000000");
    rejected = true;
    const failed = await service.enqueue(wallet.id);
    await service.runQueued();
    expect(await service.getRun(wallet.id, String(failed!.id))).toMatchObject({
      status: "failed",
      failure: { code: "ALCHEMY_AUTH_FAILED", retryable: false },
    });
    expect(await new AccountService(db).get(wallet.id)).toBeDefined();
    expect(
      await db.sql`SELECT quantity FROM holding_observations WHERE account_id=${wallet.id}`,
    ).toHaveLength(1);
    rejected = false;
    const retry = await service.enqueue(wallet.id);
    await service.runQueued();
    expect(await service.getRun(wallet.id, String(retry!.id))).toMatchObject({
      status: "partial",
    });
  });
  it("does not blame Alchemy when successful provider data cannot be saved", async () => {
    const wallet = await new AccountService(db).create({
      name: "Invalid persistence fixture",
      assetClass: "crypto",
      sourceType: "evm_wallet",
      externalAddress: "0x" + "b".repeat(40),
    });
    const provider = new AlchemyPortfolioAdapter(
      "fixture",
      ["base-mainnet"],
      async () => Response.json({ data: { tokens: [] } }),
    );
    const original = provider.syncAccount.bind(provider);
    provider.syncAccount = async (account) => {
      const result = await original(account);
      result.positions.push({
        asset: {
          key: "invalid",
          name: "Bad",
          symbol: "BAD",
          assetType: "crypto",
        },
        scope: "base-mainnet",
        quantity: "invalid",
        currency: "USD",
      });
      return result;
    };
    const service = new SyncService(
      db,
      cache,
      readConfig({ ...process.env, DATABASE_URL: url }),
      { evm_wallet: provider },
    );
    const run = await service.enqueue(wallet.id);
    await service.runQueued();
    expect(await service.getRun(wallet.id, String(run!.id))).toMatchObject({
      status: "failed",
      failure: { code: "SYNC_SAVE_FAILED" },
    });
  });
});

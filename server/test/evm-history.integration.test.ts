import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { EVMHistoryService } from "../src/modules/integrations/alchemy/history.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
import { SnapshotService } from "../src/modules/snapshots/service.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("resumable Base history with a real database", () => {
  let db: ReturnType<typeof connectDatabase>, id: string;
  const token = "0x" + "b".repeat(40),
    wallet = "0x" + "a".repeat(40);
  beforeAll(async () => {
    if (!url || new URL(url).pathname != "/finance_test")
      throw new Error("Test DB required");
    await migrate(url);
    db = connectDatabase(url);
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE accounts,assets,evm_history_cache CASCADE`;
    const [a] =
      await db.sql`INSERT INTO accounts(name,asset_class,source_type,base_currency,external_address,metadata) VALUES('Base','crypto','evm_wallet','EUR',${wallet},'{"configuredNetworks":["base-mainnet"],"balanceCoverage":["base-mainnet"]}') RETURNING id`;
    id = String(a!.id);
  });
  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets,evm_history_cache CASCADE`;
    await db.close();
  });
  const transport: typeof fetch = async (url, init) => {
    const req = JSON.parse(String(init?.body));
    if (String(url).includes("/tokens/historical"))
      return Response.json({
        currency: "usd",
        ...(req.symbol
          ? { symbol: "ETH" }
          : { network: "base-mainnet", address: token }),
        data: [{ timestamp: req.endTime, value: req.symbol ? "2000" : "3" }],
      });
    if (req.method === "eth_getBlockByNumber")
      return Response.json({
        result: {
          number: "0x100",
          timestamp: "0x" + Math.floor(Date.now() / 1000 + 100).toString(16),
        },
      });
    if (req.method === "alchemy_getAssetTransfers")
      return Response.json({
        result: {
          transfers: [{ category: "erc20", rawContract: { address: token } }],
        },
      });
    if (req.method === "eth_getBalance")
      return Response.json({ result: "0xde0b6b3a7640000" });
    if (req.method === "eth_call")
      return Response.json({
        result: req.params[0].data === "0x313ce567" ? "0x6" : "0x1e8480",
      });
    throw new Error("Unexpected RPC");
  };
  async function ready(service: EVMHistoryService) {
    await service.enqueue(id);
    await db.sql`UPDATE evm_history_jobs SET phase='balances',cursor=${db.sql.json({ tokens: ["native", token], nextDay: 0 })} WHERE account_id=${id}`;
  }
  it("reconstructs dated quantities and prices, deduplicates jobs, resumes without refetching completed balances", async () => {
    let calls = 0;
    const service = new EVMHistoryService(db, "fixture", async (...args) => {
      calls++;
      return transport(...args);
    });
    await ready(service);
    const first = await service.enqueue(id);
    const second = await service.enqueue(id);
    expect(second?.id).toBe(first?.id);
    await service.runDue();
    const [day] =
      await db.sql`SELECT * FROM evm_account_history WHERE account_id=${id}`;
    expect(day).toMatchObject({
      value: "2006.000000000000000000",
      complete: true,
    });
    const used = calls;
    await db.sql`UPDATE evm_history_jobs SET cursor=cursor || '{"nextDay":0}'::jsonb WHERE account_id=${id}`;
    await service.runDue();
    expect(calls).toBe(used);
    expect((await service.status(id))?.daysDone).toBe(1);
  });
  it("charges failed requests, pauses at quota, and cannot bypass quota with retry", async () => {
    const service = new EVMHistoryService(db, "fixture", async () =>
      Response.json({}, { status: 429 }),
    );
    await service.enqueue(id);
    await service.runDue();
    expect(await service.status(id)).toMatchObject({
      status: "paused",
      requestsUsed: 1,
    });
    await db.sql`UPDATE evm_history_jobs SET status='queued',requests_used=1000,next_attempt_at=now() WHERE account_id=${id}`;
    await service.runDue();
    expect(await service.status(id)).toMatchObject({
      status: "paused",
      requestsUsed: 1000,
    });
    await service.enqueue(id, true);
    expect(await service.status(id)).toMatchObject({
      status: "paused",
      requestsUsed: 1000,
    });
    await db.sql`UPDATE evm_history_jobs SET request_day=CURRENT_DATE-1,next_attempt_at=now() WHERE account_id=${id}`;
    await service.runDue();
    expect((await service.status(id))?.requestsUsed).toBe(1);
  });
  it("reports unavailable archive balances and token prices without fabricating a full value", async () => {
    const service = new EVMHistoryService(db, "fixture", async (url, init) => {
      const req = JSON.parse(String(init?.body));
      if (req.method === "eth_call")
        return Response.json({ error: { code: -32000 } });
      return transport(url, init);
    });
    await ready(service);
    await service.runDue();
    const [day] =
      await db.sql`SELECT * FROM evm_account_history WHERE account_id=${id}`;
    expect(day).toMatchObject({
      value: "2000.000000000000000000",
      complete: false,
    });
    expect(day!.coverage.missing[0]).toMatchObject({
      code: "missing_balance",
      contractAddress: token,
    });
  });
  it("retains incoming and outgoing token discovery across pages before publishing history", async () => {
    let pages = 0;
    const service = new EVMHistoryService(db, "fixture", async (url, init) => {
      const req = JSON.parse(String(init?.body));
      if (req.method === "alchemy_getAssetTransfers") {
        pages++;
        return Response.json({
          result: {
            transfers: [{ category: "erc20", rawContract: { address: token } }],
            ...(pages === 1 ? { pageKey: "next" } : {}),
          },
        });
      }
      return transport(url, init);
    });
    await service.enqueue(id);
    await service.runDue();
    expect((await service.status(id))?.phase).toBe("discovery");
    expect(await db.sql`SELECT * FROM evm_account_history`).toHaveLength(0);
    await service.runDue();
    await service.runDue();
    expect((await service.status(id))?.phase).toBe("balances");
    const [job] =
      await db.sql`SELECT cursor FROM evm_history_jobs WHERE account_id=${id}`;
    expect(job!.cursor.tokens).toEqual([token, "native"]);
  });
  it("uses past quantities for a sold token and native ETH after gas", async () => {
    const service = new EVMHistoryService(db, "fixture", async (url, init) => {
      const req = JSON.parse(String(init?.body));
      if (req.method === "eth_getBalance")
        return Response.json({
          result:
            req.params[1] === "0x2" ? "0xb1a2bc2ec500000" : "0xc7d713b49da0000",
        });
      if (req.method === "eth_call")
        return Response.json({
          result:
            req.params[0].data === "0x313ce567"
              ? "0x6"
              : req.params[1] === "0x2"
                ? "0x0"
                : "0x1e8480",
        });
      return transport(url, init);
    });
    await ready(service);
    const [job] =
      await db.sql`SELECT end_at FROM evm_history_jobs WHERE account_id=${id}`;
    const end = job!.endAt as Date;
    for (const [offset, block] of [
      [0, "0x2"],
      [1, "0x1"],
    ] as const) {
      const at = new Date(end.getTime() - offset * 86400000);
      await db.sql`INSERT INTO evm_history_cache(key,value,expires_at) VALUES(${"date-block:base-mainnet:" + at.toISOString()},${db.sql.json(block)},now()+interval '1 day')`;
    }
    await service.runDue();
    await service.runDue();
    const days =
      await db.sql`SELECT value FROM evm_account_history WHERE account_id=${id} ORDER BY at DESC`;
    expect(days.map((d) => d.value)).toEqual([
      "1600.000000000000000000",
      "1806.000000000000000000",
    ]);
  });
  it("reclaims an interrupted job but does not run an active lease", async () => {
    let calls = 0;
    const service = new EVMHistoryService(db, "fixture", async (...args) => {
      calls++;
      return transport(...args);
    });
    await ready(service);
    await db.sql`UPDATE evm_history_jobs SET status='running',updated_at=now() WHERE account_id=${id}`;
    expect(await service.runDue()).toBe(false);
    expect(calls).toBe(0);
    await db.sql`UPDATE evm_history_jobs SET updated_at=now()-interval '16 minutes' WHERE account_id=${id}`;
    expect(await service.runDue()).toBe(true);
    expect((await service.status(id))?.daysDone).toBe(1);
  });
  it("captures a partial current wallet without marking good balances stale", async () => {
    const [a] =
      await db.sql`INSERT INTO assets(asset_type,symbol,name,quote_currency,chain) VALUES('crypto','ETH','Ethereum','USD','base-mainnet') RETURNING id`;
    const [b] =
      await db.sql`INSERT INTO assets(asset_type,symbol,name,quote_currency,chain,contract_address) VALUES('crypto','X','Unpriced','USD','base-mainnet',${token}) RETURNING id`;
    await db.sql`INSERT INTO holding_observations(account_id,asset_id,quantity,unit_price,market_value,currency,source,observed_at) VALUES(${id},${a!.id},'1','2000','2000','USD','evm_wallet',now()),(${id},${b!.id},'2',NULL,NULL,'USD','evm_wallet',now())`;
    await db.sql`INSERT INTO sync_runs(account_id,provider,status,started_at) VALUES(${id},'evm_wallet','partial',now())`;
    const portfolio = new PortfolioService(db);
    const dash = await portfolio.dashboard("global", "1m", "USD");
    expect(dash.accounts[0]).toMatchObject({
      stale: false,
      complete: false,
      unvaluedPositions: 1,
    });
    await new SnapshotService(db, portfolio).capture("USD");
    const result = await portfolio.dashboard("global", "1m", "USD");
    expect(result.chart[0]).toMatchObject({
      complete: false,
      value: "2000.000000000000000000",
    });
    expect(result.absoluteChange).toBeUndefined();
  });
});

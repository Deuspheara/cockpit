import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { AccountService } from "../src/modules/accounts/service.js";
import { AssetService } from "../src/modules/assets/service.js";
import { ChangeSetService } from "../src/modules/changes/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
import { SnapshotService } from "../src/modules/snapshots/service.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("real-account history and demo isolation", () => {
  let db: ReturnType<typeof connectDatabase>, realId: string, demoId: string;
  beforeAll(async () => {
    if (!url || new URL(url).pathname != "/finance_test")
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    const accounts = new AccountService(db),
      changes = new ChangeSetService(db);
    const asset = await new AssetService(db).create({
      symbol: "EUR",
      name: "Euro",
      assetType: "cash",
      quoteCurrency: "EUR",
    });
    demoId = (
      await accounts.create({
        name: "Demo",
        sourceType: "manual",
        assetClass: "cash",
      })
    ).id;
    await db.sql`UPDATE accounts SET metadata='{"demo":true}' WHERE id=${demoId}`;
    realId = (
      await accounts.create({
        name: "Real",
        sourceType: "manual",
        assetClass: "cash",
      })
    ).id;
    for (const [accountId, quantity] of [
      [demoId, "10000"],
      [realId, "100"],
    ]) {
      const proposal = await changes.proposeObservation({
        accountId,
        assetId: asset.id,
        quantity,
        currency: "EUR",
        observedAt: new Date().toISOString(),
      });
      await changes.apply(proposal.id);
    }
  });
  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets CASCADE`;
    await db.close();
  });
  it("excludes seed accounts from real totals without deleting seed records", async () => {
    const dashboard = await new PortfolioService(db).dashboard("global", "1m");
    expect(dashboard.value).toBe("100.000000000000000000");
    expect(dashboard.accounts.map((a) => a.id)).toEqual([realId]);
    expect((await new AccountService(db).get(demoId)).metadata.demo).toBe(true);
    expect((await new AccountService(db).list()).map((a) => a.id)).toEqual([
      realId,
    ]);
  });
  it("records healthy account history even when another connection has no valuation", async () => {
    await new AccountService(db).create({
      name: "Unavailable",
      sourceType: "dydx",
      assetClass: "crypto",
      externalAddress: "dydx1" + "q".repeat(38),
    });
    const portfolio = new PortfolioService(db);
    expect((await portfolio.dashboard("global", "1m")).complete).toBe(false);
    expect((await new SnapshotService(db, portfolio).capture()).captured).toBe(
      true,
    );
    expect(
      (await portfolio.dashboard("global", "1m", "EUR", realId)).chart,
    ).toHaveLength(1);
    // A missing account is explicit coverage, not a silently assumed zero.
    const global = await portfolio.dashboard("global", "1m");
    expect(global.chart).toHaveLength(1);
    expect(global.chart[0]?.complete).toBe(false);
    expect(global.chart[0]?.coverage.missing[0]?.code).toBe("missing_history");
  });
  it("converts provider history using only a dated prior FX rate", async () => {
    const at = new Date(Date.now() - 2 * 86400000);
    await db.sql`INSERT INTO provider_account_history(account_id,at,resolution,equity,total_pnl,net_transfers,currency,source) VALUES(${realId},${at},'daily','100','20','80','USD','dydx')`;
    await db.sql`INSERT INTO fx_quotes(base_currency,quote_currency,rate,quoted_at,source) VALUES('USD','EUR','0.5',${new Date(at.getTime() - 86400000)},'ecb'),('USD','EUR','1.2',now(),'ecb')`;
    const chart = (
      await new PortfolioService(db).dashboard("global", "1m", "EUR", realId)
    ).chart;
    expect(chart.find((p) => p.sourceAt === at.toISOString())?.value).toBe(
      "50.000000000000000000",
    );
  });
});

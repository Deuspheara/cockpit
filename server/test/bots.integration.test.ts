import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { connectDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { BotService, botInput } from "../src/modules/bots/service.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("paper-only worker", () => {
  let db: ReturnType<typeof connectDatabase>, bots: BotService;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    bots = new BotService(db);
  });
  afterAll(async () => {
    await db.sql`TRUNCATE bots CASCADE`;
    await db.close();
  });
  it("creates disabled bots, executes once when enabled, and never places an order", async () => {
    const bot = await bots.create({
      name: "Heartbeat",
      allocatedPaperCapital: "10000",
    });
    expect(bot.enabled).toBe(false);
    expect((await bots.runDue()).evaluated).toBe(0);
    await bots.enable(String(bot.id), true);
    const now = new Date(Date.now() + 1000);
    await Promise.all([bots.runDue(now), bots.runDue(now)]);
    expect(await bots.runs(String(bot.id))).toHaveLength(1);
    expect(await db.sql`SELECT id FROM paper_orders`).toHaveLength(0);
    expect((await bots.runs(String(bot.id)))[0]?.paperPnl).toBe(
      "0.000000000000000000",
    );
  });
  it("does not accept strategies, private keys, or live flags", () => {
    expect(
      botInput.safeParse({
        name: "Trade",
        strategy: "live",
        privateKey: "secret",
      }).success,
    ).toBe(false);
  });
});

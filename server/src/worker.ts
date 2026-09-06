import { EVMHistoryService } from "./modules/integrations/alchemy/history.js";
import { BotService } from "./modules/bots/service.js";
import { SyncService } from "./modules/integrations/service.js";
import { FXService } from "./modules/integrations/fx.js";
import { readConfig } from "./config.js";
import { connectDatabase } from "./db/index.js";
import { connectCache } from "./shared/cache.js";
import { RecurringService } from "./modules/recurring/service.js";
import { PortfolioService } from "./modules/portfolio/service.js";
import { SnapshotService } from "./modules/snapshots/service.js";
const config = readConfig();
const database = connectDatabase(config.DATABASE_URL),
  cache = connectCache(config.REDIS_URL);
const recurring = new RecurringService(database),
  snapshots = new SnapshotService(database, new PortfolioService(database));
const sync = new SyncService(database, cache, config),
  fx = new FXService(database),
  bots = new BotService(database);
const evmHistory = new EVMHistoryService(
  database,
  config.ALCHEMY_API_KEY,
  fetch,
  config.ALCHEMY_NETWORKS.split(",").map((n) => n.trim()),
);
let historyTask: Promise<void> | undefined;
let stopping = false,
  lastRecurringDay = "",
  lastValuationSlot = -1,
  lastSync = 0,
  lastFXDay = "",
  nextFXAttempt = 0;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
while (!stopping) {
  try {
    await database.sql`INSERT INTO worker_heartbeat(id,seen_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at`;
    if (!historyTask)
      historyTask = evmHistory
        .runDue()
        .then(async (changed) => {
          if (changed) {
            try {
              await cache.incr("portfolio:revision");
            } catch {}
          }
        })
        .catch(() => {
          console.error("Historical reconstruction worker failed; will retry");
        })
        .finally(() => {
          historyTask = undefined;
        });
    await sync.runQueued();
    await bots.runDue();
    const day = new Date().toISOString().slice(0, 10);
    if (lastFXDay !== day && Date.now() >= nextFXAttempt) {
      try {
        await fx.refresh();
        lastFXDay = day;
      } catch {
        nextFXAttempt = Date.now() + 300000;
      }
    }
    if (Date.now() - lastSync >= config.PROVIDER_SYNC_SECONDS * 1000) {
      await sync.syncAll();
      lastSync = Date.now();
    }
    if (day !== lastRecurringDay) {
      await recurring.materialize(
        new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
      );
      lastRecurringDay = day;
      try {
        await cache.incr("portfolio:revision");
      } catch {}
    }
    const interval = config.VALUATION_INTERVAL_MINUTES * 60000,
      slot = Math.floor(Date.now() / interval);
    if (slot !== lastValuationSlot) {
      const result = await snapshots.capture("EUR");
      if (result.captured) {
        lastValuationSlot = slot;
        try {
          await cache.incr("portfolio:revision");
        } catch {}
      }
    }
  } catch {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Scheduled finance job failed; will retry",
      }),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
await historyTask;
if (cache.isOpen) cache.destroy();
await database.close();

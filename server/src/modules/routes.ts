import { EVMHistoryService } from "./integrations/alchemy/history.js";
import { marketHistory } from "./integrations/dydx/market-history.js";
import { AppError } from "../shared/errors.js";
import { tradingPerformance } from "./portfolio/history.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/index.js";
import type { Cache } from "../shared/cache.js";
import type { Config } from "../config.js";
import { ActivityService } from "./activity/service.js";
import { AccountService } from "./accounts/service.js";
import { AssetLogoService } from "./assets/logos.js";
import type { Asset } from "./assets/service.js";
import { AssetService } from "./assets/service.js";
import { ChangeSetService } from "./changes/service.js";
import { LedgerService } from "./ledger/service.js";
import {
  PortfolioService,
  scopeSchema,
  rangeSchema,
} from "./portfolio/service.js";
import { RecurringService } from "./recurring/service.js";
import { ReconciliationService } from "./reconciliation/service.js";
import { SyncService } from "./integrations/service.js";
import { FXService } from "./integrations/fx.js";
import { SnapshotService } from "./snapshots/service.js";
const params = z.object({ id: z.uuid().toLowerCase() });
const id = (value: unknown) => params.parse(value).id;
export async function registerFinanceRoutes(
  app: FastifyInstance,
  database: Database,
  cache: Cache,
  config: Config,
) {
  const accounts = new AccountService(database),
    assets = new AssetService(database),
    changes = new ChangeSetService(database),
    ledger = new LedgerService(database);
  const logos = new AssetLogoService(config.LOGO_DEV_PUBLISHABLE_KEY);
  const portfolio = new PortfolioService(database),
    recurring = new RecurringService(database),
    reconciliation = new ReconciliationService(database);
  const snapshots = new SnapshotService(database, portfolio),
    sync = new SyncService(database, cache, config),
    fx = new FXService(database);
  app.addHook("onSend", async (request, _reply, payload) => {
    if (["POST", "PATCH", "DELETE"].includes(request.method)) {
      try {
        await cache.incr("portfolio:revision");
      } catch {}
    }
    return payload;
  });
  app.get("/api/v1/activity", (request) =>
    new ActivityService(database).list(
      z
        .object({
          accountId: z.uuid().toLowerCase().optional(),
          assetClass: z
            .enum(["crypto", "equities", "cash", "other"])
            .optional(),
          source: z.string().max(40).optional(),
        })
        .strict()
        .parse(request.query),
    ),
  );
  app.get("/api/v1/accounts", () => accounts.list());
  app.post("/api/v1/accounts", (request) => accounts.create(request.body));
  app.get("/api/v1/accounts/:id", (request) =>
    accounts.get(id(request.params)),
  );
  app.patch("/api/v1/accounts/:id", (request) =>
    accounts.rename(
      id(request.params),
      z.object({ name: z.string() }).strict().parse(request.body).name,
    ),
  );
  const evmHistory = new EVMHistoryService(
    database,
    config.ALCHEMY_API_KEY,
    fetch,
    config.ALCHEMY_NETWORKS.split(",").map((n) => n.trim()),
  );
  app.post("/api/v1/accounts/:id/history-jobs", async (request, reply) =>
    reply.code(202).send(await evmHistory.enqueue(id(request.params), true)),
  );
  app.get("/api/v1/accounts/:id/history-jobs", async (request) => {
    await accounts.get(id(request.params));
    return evmHistory.status(id(request.params));
  });
  app.post("/api/v1/accounts/:id/sync-runs", async (request, reply) =>
    reply.code(202).send(await sync.enqueue(id(request.params))),
  );
  app.get("/api/v1/accounts/:id/sync-runs/:runId", (request) => {
    const params = z
      .object({ id: z.uuid(), runId: z.uuid() })
      .parse(request.params);
    return sync.getRun(params.id, params.runId);
  });
  app.get("/api/v1/accounts/:id/sync-runs", (request) =>
    sync.getRun(id(request.params)),
  );
  app.post("/api/v1/accounts/:id/sync", (request) =>
    sync.sync(id(request.params)),
  );
  app.post("/api/v1/fx/refresh", () => fx.refresh());
  app.get("/api/v1/assets", () => assets.list());
  app.post("/api/v1/assets", (request) => assets.create(request.body));
  app.get("/api/v1/assets/:id/market-history", async (request) => {
    const assetId = id(request.params);
    const { range } = z
      .object({ range: rangeSchema.default("1m") })
      .parse(request.query);
    const [asset] =
      await database.sql`SELECT external_ids FROM assets WHERE id=${assetId}`;
    const key = (asset?.externalIds as Record<string, unknown> | undefined)
      ?.providerKey;
    if (typeof key !== "string" || !key.startsWith("dydx:perp:"))
      throw new AppError(
        "NOT_AVAILABLE",
        "Price history is available for dYdX perpetual markets",
      );
    const cacheKey = `market-history:${assetId}:${range}`;
    try {
      const saved = await cache.get(cacheKey);
      if (saved) return JSON.parse(saved) as unknown;
    } catch {}
    const result = await marketHistory(key.slice("dydx:perp:".length), range);
    try {
      await cache.setEx(cacheKey, 120, JSON.stringify(result));
    } catch {}
    return result;
  });
  app.get("/api/v1/transactions", (request) =>
    ledger.list(
      z
        .object({ accountId: z.uuid().toLowerCase().optional() })
        .parse(request.query).accountId,
    ),
  );
  app.get("/api/v1/transactions/:id", (request) =>
    ledger.get(id(request.params)),
  );
  app.post("/api/v1/transactions", (request) =>
    changes.proposeTransaction(request.body),
  );
  app.patch("/api/v1/transactions/:id", (request) =>
    changes.proposeTransactionEdit(id(request.params), request.body),
  );
  app.delete("/api/v1/transactions/:id", (request) =>
    changes.proposeTransactionEdit(id(request.params), null),
  );
  app.post("/api/v1/observations", (request) =>
    changes.proposeObservation(request.body),
  );
  app.get("/api/v1/portfolio/assets", async (request) => {
    const { scope } = z
      .object({ scope: scopeSchema.default("global") })
      .parse(request.query);
    const [all, positions] = await Promise.all([
      accounts.list(),
      portfolio.positions(),
    ]);
    const rows = all
      .filter(
        (a) =>
          scope === "global" ||
          (scope === "other"
            ? !["crypto", "equities"].includes(a.assetClass)
            : a.assetClass === scope),
      )
      .flatMap((a) =>
        (positions.get(a.id) ?? []).map((p) => ({
          ...p,
          accountId: a.id,
          accountName: a.name,
        })),
      );
    if (!rows.length) return rows;
    try {
      const ids = [...new Set(rows.map((row) => row.assetId))];
      const metadata = await database.sql<Asset[]>`
        SELECT * FROM assets WHERE id = ANY(${ids}::uuid[])`;
      const resolved = await logos.resolveAll(metadata);
      return rows.map((row) => ({
        ...row,
        logoUrl: resolved.get(row.assetId) ?? null,
      }));
    } catch {
      return rows;
    }
  });
  app.get("/api/v1/portfolio/dashboard", async (request) => {
    const { scope, range } = z
      .object({
        scope: scopeSchema.default("global"),
        range: rangeSchema.default("1m"),
      })
      .parse(request.query);
    let key: string | undefined;
    try {
      key = `portfolio:${(await cache.get("portfolio:revision")) ?? "0"}:${scope}:${range}`;
      const hit = await cache.get(key);
      if (hit) return JSON.parse(hit) as unknown;
    } catch {}
    const result = await portfolio.dashboard(scope, range);
    try {
      if (key && config.DASHBOARD_CACHE_SECONDS > 0)
        await cache.setEx(
          key,
          config.DASHBOARD_CACHE_SECONDS,
          JSON.stringify(result),
        );
    } catch {}
    return result;
  });
  app.get("/api/v1/accounts/:id/detail", async (request) => {
    const accountId = id(request.params);
    const { range } = z
      .object({ range: rangeSchema.default("1m") })
      .parse(request.query);
    const [account, dashboard, positions, activity] = await Promise.all([
      accounts.get(accountId),
      portfolio.dashboard("global", range, "EUR", accountId),
      portfolio.positions(accountId),
      ledger.list(accountId),
    ]);
    return {
      account,
      dashboard,
      positions: positions.get(accountId) ?? [],
      derivatives: account.metadata.derivatives ?? null,
      performance: await tradingPerformance(
        database.sql,
        accountId,
        new Date(
          Date.now() -
            {
              "1d": 1,
              "1w": 7,
              "3w": 21,
              "1m": 30,
              "3m": 90,
              "1y": 365,
              all: 36500,
            }[range] *
              86400000,
        ),
        range,
      ),
      historyJob:
        account.sourceType === "evm_wallet"
          ? await evmHistory.status(accountId)
          : null,
      historyStatus: account.metadata.historyStatus ?? null,
      historyError: account.metadata.historyError ?? null,
      activity,
    };
  });
  app.get("/api/v1/recurring-rules", () => recurring.list());
  app.post("/api/v1/recurring-rules", (request) =>
    changes.proposeRule(request.body),
  );
  app.get("/api/v1/recurring-rules/:id", (request) =>
    recurring.get(id(request.params)),
  );
  app.get("/api/v1/recurring-rules/:id/occurrences", (request) =>
    recurring.occurrences(id(request.params)),
  );
  app.post("/api/v1/recurring-rules/:id/change-from-date", (request) => {
    const body = z
      .object({ effectiveOn: z.iso.date(), replacement: z.unknown() })
      .strict()
      .parse(request.body);
    return changes.proposeRuleChange(
      id(request.params),
      body.effectiveOn,
      body.replacement,
    );
  });
  app.post("/api/v1/recurring-rules/:id/stop", (request) =>
    changes.proposeRuleChange(
      id(request.params),
      z.object({ effectiveOn: z.iso.date() }).strict().parse(request.body)
        .effectiveOn,
      null,
    ),
  );
  app.post("/api/v1/recurring-rules/:id/edit-series", (request) =>
    changes.proposeEntireSeries(id(request.params), request.body),
  );
  app.post("/api/v1/recurring-occurrences/:id/confirm", (request) =>
    changes.proposePostOccurrence(id(request.params), request.body),
  );
  app.post("/api/v1/recurring-occurrences/:id/skip", (request) =>
    changes.proposeOccurrence(id(request.params), "skipped"),
  );
  app.post("/api/v1/recurring-occurrences/:id/detach", (request) =>
    changes.proposeOccurrence(id(request.params), "detached"),
  );
  app.get("/api/v1/change-sets/:id", (request) =>
    changes.get(id(request.params)),
  );
  app.post("/api/v1/change-sets/:id/apply", (request) =>
    changes.apply(id(request.params)),
  );
  app.post("/api/v1/change-sets/:id/undo", (request) =>
    changes.apply(id(request.params), true),
  );
  app.post("/api/v1/change-sets/:id/reject", (request) =>
    changes.reject(id(request.params)),
  );
  app.get("/api/v1/reconciliation", (request) =>
    reconciliation.list(
      z
        .object({ accountId: z.uuid().toLowerCase().optional() })
        .parse(request.query).accountId,
    ),
  );
  app.post("/api/v1/accounts/:id/reconcile", (request) =>
    reconciliation.run(id(request.params)),
  );
  app.post("/api/v1/snapshots", () => snapshots.capture());
}

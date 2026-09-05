import Fastify from "fastify";
import { registerBotRoutes } from "./modules/bots/routes.js";
import { registerAgentRoutes } from "./modules/agent/routes.js";
import { registerImportRoutes } from "./modules/imports/routes.js";
import { registerFinanceRoutes } from "./modules/routes.js";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { connectDatabase, type Database } from "./db/index.js";
import { connectCache, type Cache } from "./shared/cache.js";
import { AuthService } from "./modules/auth/service.js";
import { AppError } from "./shared/errors.js";

export function aiConfigurationStatus(
  config: Pick<
    Config,
    | "OPENROUTER_API_KEY"
    | "OPENROUTER_MODEL_PRIMARY"
    | "OPENROUTER_MODEL_VISION"
  >,
) {
  const keyConfigured = !!config.OPENROUTER_API_KEY;
  return {
    keyConfigured,
    chatConfigured: keyConfigured && !!config.OPENROUTER_MODEL_PRIMARY,
    visionConfigured: keyConfigured && !!config.OPENROUTER_MODEL_VISION,
  };
}

export async function createApp(
  config: Config,
  dependencies?: { database: Database; cache: Cache },
) {
  const database =
    dependencies?.database ?? connectDatabase(config.DATABASE_URL);
  const cache = dependencies?.cache ?? connectCache(config.REDIS_URL);
  const auth = new AuthService(database);
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      redact: [
        "req.headers.authorization",
        "req.body",
        "res.headers.authorization",
        "*.token",
        "*.apiKey",
        "*.password",
      ],
    },
  });
  await app.register(helmet);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request",
          details: error.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        },
      });
    if (error instanceof AppError)
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    const status =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode)
        : 500;
    if (status >= 400 && status < 500)
      return reply.code(status).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request rejected",
          details: {},
        },
      });
    request.log.error({ requestId: request.id }, "Request failed");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
        details: {},
      },
    });
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?")[0] === "/health") return;
    if (!(await auth.authenticate(request.headers.authorization)))
      return reply.code(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Valid device token required",
          details: {},
        },
      });
  });
  app.get("/health", async (_, reply) => {
    try {
      await database.sql`SELECT 1`;
      return { status: "healthy" };
    } catch {
      return reply.code(503).send({ status: "unhealthy" });
    }
  });
  app.get("/api/v1/session", async () => {
    const ai = aiConfigurationStatus(config);
    return {
      apiVersion: "1",
      ai: {
        configured: ai.chatConfigured,
        ...ai,
        primaryModel: config.OPENROUTER_MODEL_PRIMARY,
        visionModel: config.OPENROUTER_MODEL_VISION,
      },
      walletConfigured: !!config.ALCHEMY_API_KEY,
    };
  });
  app.get("/api/v1/diagnostics", async () => {
    let db = false;
    let redis = false;
    try {
      await database.sql`SELECT 1`;
      db = true;
    } catch {}
    try {
      redis = (await cache.ping()) === "PONG";
    } catch {}
    const heartbeat = db
      ? await database.sql`SELECT seen_at FROM worker_heartbeat WHERE id=1`
      : [];
    const ai = aiConfigurationStatus(config);
    return {
      apiVersion: "1",
      dbReachable: db,
      redisReachable: redis,
      workerHeartbeat: heartbeat[0]?.seenAt ?? null,
      aiConfigured: ai.chatConfigured,
      ...ai,
      walletConfigured: !!config.ALCHEMY_API_KEY,
    };
  });
  await registerFinanceRoutes(app, database, cache, config);
  const importJobs = await registerImportRoutes(app, database, cache, config);
  const agentRuns = registerAgentRoutes(app, database, config);
  registerBotRoutes(app, database);
  app.addHook("preClose", () => agentRuns.close());
  app.addHook("onClose", async () => {
    await importJobs.close();
    await agentRuns.close();
    if (cache.isOpen) cache.destroy();
    await database.close();
  });
  return app;
}

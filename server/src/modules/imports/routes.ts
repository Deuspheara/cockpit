import { registerCsvRoutes } from "./csv/routes.js";
import { ImportJobs, type Screenshot } from "./jobs.js";
import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import type { Database } from "../../db/index.js";
import type { Config } from "../../config.js";
import type { Cache } from "../../shared/cache.js";
import { OpenRouterClient } from "../agent/openrouter.js";
import { ChangeSetService } from "../changes/service.js";
import { ImportService } from "./service.js";
import { validateImage, readImageBytes } from "./images.js";
import { AppError } from "../../shared/errors.js";
import { EODHDMarketData } from "./market-data.js";
import { currency, decimalString } from "../../shared/decimal.js";
export async function registerImportRoutes(
  app: FastifyInstance,
  database: Database,
  cache: Cache,
  config: Config,
  model = new OpenRouterClient(config),
) {
  await app.register(multipart, {
    limits: {
      fileSize: config.MAX_UPLOAD_MB * 1024 * 1024,
      files: 5,
      fields: 2,
      parts: 7,
    },
  });
  registerCsvRoutes(app, database, cache);
  const imports = new ImportService(
    database,
    model,
    new ChangeSetService(database),
    new EODHDMarketData(cache, config),
  );
  const id = (params: unknown) =>
    z.object({ id: z.uuid().toLowerCase() }).parse(params).id;
  const jobs = new ImportJobs(database, imports);
  await jobs.expire();

  app.post("/api/v1/imports", (request) => {
    const body = z
      .object({
        accountId: z.uuid().toLowerCase().optional(),
        conversationId: z.uuid().toLowerCase().optional(),
        requestId: z.uuid().toLowerCase().optional(),
      })
      .strict()
      .parse(request.body ?? {});
    return imports.create(body.accountId, body.conversationId, body.requestId);
  });
  const jobParams = (params: unknown) =>
    z
      .object({ id: z.uuid().toLowerCase(), jobId: z.uuid().toLowerCase() })
      .parse(params);
  app.get("/api/v1/imports/:id/jobs/:jobId", (request) => {
    const p = jobParams(request.params);
    return jobs.get(p.id, p.jobId);
  });
  app.post("/api/v1/imports/:id/jobs/:jobId/cancel", (request) => {
    const p = jobParams(request.params);
    return jobs.cancel(p.id, p.jobId);
  });
  app.post(
    "/api/v1/imports/:id/jobs",
    { bodyLimit: config.MAX_UPLOAD_MB * 1024 * 1024 * 5 + 65536 },
    async (request, reply) => {
      const images: Screenshot[] = [];
      let handedOff = false;
      try {
        const query = z
          .object({
            requestId: z.uuid().toLowerCase(),
            revision: z.coerce.number().int().nonnegative(),
          })
          .strict()
          .parse(request.query);
        for await (const part of request.parts()) {
          if (part.type !== "file")
            throw new AppError(
              "INVALID_IMAGE",
              "Only screenshot files are accepted",
            );
          const bytes = await readImageBytes(
            part.file,
            config.MAX_UPLOAD_MB * 1024 * 1024,
          );
          images.push({ bytes, mime: part.mimetype });
          validateImage(
            bytes,
            part.mimetype,
            config.MAX_UPLOAD_MB * 1024 * 1024,
          );
          if (part.file.truncated)
            throw new AppError(
              "UPLOAD_LIMIT",
              "Screenshot exceeds upload limit",
              413,
            );
        }
        if (!images.length)
          throw new AppError("INVALID_IMAGE", "Choose at least one screenshot");
        const job = await jobs.create(
          id(request.params),
          query.requestId,
          query.revision,
          images,
        );
        handedOff = true;
        return reply.code(202).send(job);
      } finally {
        if (!handedOff) images.forEach((image) => image.bytes.fill(0));
      }
    },
  );
  app.post("/api/v1/agent/conversations/:id/imports", (request) => {
    const body = z
      .object({
        requestId: z.uuid().toLowerCase(),
        accountId: z.uuid().toLowerCase().optional(),
      })
      .strict()
      .parse(request.body);
    return imports.create(body.accountId, id(request.params), body.requestId);
  });
  app.get("/api/v1/imports/:id", (request) => imports.get(id(request.params)));
  app.post(
    "/api/v1/imports/:id/screenshots",
    { bodyLimit: config.MAX_UPLOAD_MB * 1024 * 1024 * 5 },
    async (request) => {
      const sessionId = id(request.params);
      let files = 0;
      for await (const part of request.parts()) {
        if (part.type !== "file")
          throw new AppError(
            "INVALID_IMAGE",
            "Only screenshot files are accepted",
          );
        const bytes = await readImageBytes(
          part.file,
          config.MAX_UPLOAD_MB * 1024 * 1024,
        );
        try {
          validateImage(
            bytes,
            part.mimetype,
            config.MAX_UPLOAD_MB * 1024 * 1024,
          );
          await imports.extract(sessionId, { bytes, mime: part.mimetype });
          files++;
        } finally {
          bytes.fill(0);
        }
      }
      if (!files)
        throw new AppError("INVALID_IMAGE", "Choose at least one screenshot");
      return imports.get(sessionId);
    },
  );
  app.post("/api/v1/imports/:id/message", (request) =>
    imports.extract(
      id(request.params),
      undefined,
      z
        .object({ message: z.string().trim().min(1).max(4000) })
        .strict()
        .parse(request.body).message,
    ),
  );
  app.get("/api/v1/imports/:id/positions/:candidateId/matches", (request) => {
    const params = z
      .object({
        id: z.uuid().toLowerCase(),
        candidateId: z.uuid().toLowerCase(),
      })
      .parse(request.params);
    const query = z
      .object({ query: z.string().trim().min(1).max(200).optional() })
      .parse(request.query);
    return imports.matchingChoices(params.id, params.candidateId, query.query);
  });
  const editableText = z.string().trim().max(1000).nullable();
  const editableAmount = decimalString.nullable();
  app.patch("/api/v1/imports/:id", (request) => {
    const body = z
      .object({
        revision: z.number().int().nonnegative(),
        accountId: z.uuid().toLowerCase().nullable().optional(),
        likelyAccountName: editableText.optional(),
        capturedAt: z.iso.datetime({ offset: true }).optional(),
        positions: z
          .array(
            z
              .object({
                candidateId: z.uuid().toLowerCase(),
                symbol: editableText.optional(),
                name: editableText.optional(),
                isin: editableText.optional(),
                quantity: editableAmount.optional(),
                marketValue: editableAmount.optional(),
                currency: currency.nullable().optional(),
              })
              .strict(),
          )
          .max(50)
          .optional(),
        derivatives: z
          .array(
            z
              .object({
                candidateId: z.uuid().toLowerCase(),
                underlyingSymbol: editableText.optional(),
                name: editableText.optional(),
                optionType: z.enum(["call", "put"]).nullable().optional(),
                strike: editableAmount.optional(),
                expiration: z.iso.date().nullable().optional(),
                contractSymbol: editableText.optional(),
                quantity: editableAmount.optional(),
                marketValue: editableAmount.optional(),
                currency: currency.nullable().optional(),
              })
              .strict(),
          )
          .max(50)
          .optional(),
      })
      .strict()
      .parse(request.body);
    const { revision, ...patch } = body;
    return imports.update(id(request.params), revision, patch);
  });
  app.post("/api/v1/imports/:id/prepare-change-set", (request) =>
    imports.prepare(
      id(request.params),
      z
        .object({
          accountName: z.string().trim().min(1).max(120).optional(),
          assetMappings: z
            .record(z.string(), z.uuid().toLowerCase())
            .optional(),
        })
        .strict()
        .parse(request.body ?? {}),
    ),
  );
  return jobs;
}

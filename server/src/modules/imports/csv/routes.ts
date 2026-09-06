import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../../db/index.js";
import type { Cache } from "../../../shared/cache.js";
import { AppError } from "../../../shared/errors.js";
import { MAX_CSV_BYTES } from "./parser.js";
import { CsvImportService } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    deviceTokenId: string;
  }
}
export function registerCsvRoutes(
  app: FastifyInstance,
  database: Database,
  cache: Cache,
) {
  const service = new CsvImportService(database);
  const id = (p: unknown) =>
    z.object({ id: z.uuid().toLowerCase() }).parse(p).id;
  const revision = z.object({ revision: z.number().int().positive() }).strict();
  app.post(
    "/api/v1/imports/csv/preview",
    { bodyLimit: MAX_CSV_BYTES + 65536 },
    async (request) => {
      const query = z
        .object({
          provider: z.enum(["auto", "trade_republic"]).default("auto"),
          accountId: z.uuid().toLowerCase().optional(),
        })
        .strict()
        .parse(request.query);
      let bytes: Buffer | undefined;
      let filename = "";
      const started = Date.now();
      try {
        for await (const part of request.parts({
          limits: { fileSize: MAX_CSV_BYTES, files: 1, fields: 0, parts: 1 },
        })) {
          if (part.type !== "file" || part.fieldname !== "file")
            throw new AppError("INVALID_CSV", "Choose one CSV file.");
          filename = part.filename
            .split(/[\\/]/)
            .pop()!
            .replace(/[\x00-\x1f\x7f]/g, "")
            .slice(0, 200);
          if (!/\.csv$/i.test(filename))
            throw new AppError("UNSUPPORTED_FILE", "Choose a .csv file.");
          if (
            ![
              "text/csv",
              "application/csv",
              "text/plain",
              "application/octet-stream",
              "application/vnd.ms-excel",
            ].includes(part.mimetype)
          )
            throw new AppError("UNSUPPORTED_FILE", "Choose a CSV text file.");
          bytes = await part.toBuffer();
          if (part.file.truncated)
            throw new AppError(
              "UPLOAD_LIMIT",
              "CSV exceeds the 10 MB limit.",
              413,
            );
        }
        if (!bytes) throw new AppError("INVALID_CSV", "Choose one CSV file.");
        const preview = await service.create(
          request.deviceTokenId,
          filename,
          bytes,
          query.provider,
          query.accountId,
        );
        request.log.info(
          {
            importId: preview.id,
            provider: preview.provider,
            rows: preview.summary.rows,
            durationMs: Date.now() - started,
          },
          "CSV preview prepared",
        );
        return preview;
      } finally {
        bytes?.fill(0);
      }
    },
  );
  app.get("/api/v1/imports/csv/:id", (r) =>
    service.get(id(r.params), r.deviceTokenId),
  );
  app.patch("/api/v1/imports/csv/:id", (r) => {
    const body = revision
      .extend({
        destinations: z
          .array(
            z
              .object({
                group: z.enum(["DEFAULT", "PEA"]),
                accountId: z.uuid().toLowerCase().nullable(),
                name: z.string().trim().min(1).max(120),
                included: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(2),
      })
      .parse(r.body);
    return service.update(
      id(r.params),
      r.deviceTokenId,
      body.revision,
      body.destinations,
    );
  });
  app.post("/api/v1/imports/csv/:id/confirm", async (r) => {
    const started = Date.now(),
      result = await service.confirm(
        id(r.params),
        r.deviceTokenId,
        revision.parse(r.body).revision,
      );
    if (result.result) {
      try {
        await cache.incr("portfolio:revision");
      } catch {}
    }
    r.log.info(
      {
        importId: result.id,
        provider: result.provider,
        ...result.summary,
        durationMs: Date.now() - started,
      },
      "CSV confirmation processed",
    );
    return result;
  });
  app.delete("/api/v1/imports/csv/:id", (r) =>
    service.cancel(id(r.params), r.deviceTokenId),
  );
  app.get("/api/v1/accounts/:id/imports", (r) =>
    service.history(
      id(r.params),
      z
        .object({
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .parse(r.query).offset,
    ),
  );
}

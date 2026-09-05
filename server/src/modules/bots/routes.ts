import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/index.js";
import { BotService } from "./service.js";
export function registerBotRoutes(app: FastifyInstance, database: Database) {
  const bots = new BotService(database);
  const id = (input: unknown) =>
    z.object({ id: z.uuid().toLowerCase() }).parse(input).id;
  app.get("/api/v1/bots", () => bots.list());
  app.post("/api/v1/bots", (request) => bots.create(request.body));
  app.patch("/api/v1/bots/:id", (request) =>
    bots.enable(
      id(request.params),
      z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled,
    ),
  );
  app.get("/api/v1/bots/:id/runs", (request) => bots.runs(id(request.params)));
}

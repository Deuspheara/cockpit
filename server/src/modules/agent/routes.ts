import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/index.js";
import type { Config } from "../../config.js";
import { ChangeSetService } from "../changes/service.js";
import { AgentService } from "./service.js";
import { AgentTools } from "./tools.js";
import { OpenRouterClient } from "./openrouter.js";
export function registerAgentRoutes(
  app: FastifyInstance,
  database: Database,
  config: Config,
) {
  const service = new AgentService(
    database,
    new OpenRouterClient(config),
    new AgentTools(database, new ChangeSetService(database)),
  );
  const id = (input: unknown) =>
    z.object({ id: z.uuid().toLowerCase() }).parse(input).id;
  app.post("/api/v1/agent/conversations", () => service.create());
  app.get("/api/v1/agent/conversations/:id", (request) =>
    service.get(id(request.params)),
  );
  app.post("/api/v1/agent/conversations/:id/messages", (request) =>
    service.message(
      id(request.params),
      z
        .object({ text: z.string().min(1).max(4000) })
        .strict()
        .parse(request.body).text,
    ),
  );
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors.js";
import { z } from "zod";
import type { Database } from "../../db/index.js";
import type { Config } from "../../config.js";
import { OpenRouterClient } from "./openrouter.js";
import { AgentRuns } from "./runs.js";
export function registerAgentRoutes(
  app: FastifyInstance,
  database: Database,
  config: Config,
) {
  const model = new OpenRouterClient(config),
    runs = new AgentRuns(database, model);
  const id = (input: unknown) =>
    z.object({ id: z.uuid().toLowerCase() }).parse(input).id;
  const after = (input: unknown) =>
    z
      .string()
      .regex(/^\d{1,18}$/)
      .parse(input ?? "0");
  const subscribe = async (
    request: FastifyRequest,
    reply: FastifyReply,
    attemptId: string,
  ) => {
    await runs.attempt(attemptId);
    let cursor = after(
      (request.query as { after?: string })?.after ??
        request.headers["last-event-id"],
    );
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();
    let closed = false,
      lastHeartbeat = Date.now();
    const close = () => {
      closed = true;
    };
    reply.raw.on("close", close);
    let finished: () => void = () => {};
    runs.trackSubscription(
      new Promise<void>((resolve) => {
        finished = resolve;
      }),
    );
    try {
      while (!closed) {
        const events = await runs.events(attemptId, cursor);
        for (const event of events) {
          if (closed) break;
          cursor = event.id;
          if (
            !reply.raw.write(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`,
            )
          ) {
            closed = true;
            break;
          }
        }
        const attempt = await runs.attempt(attemptId);
        if (attempt.status !== "running" && events.length === 0) break;
        if (Date.now() - lastHeartbeat >= 15000) {
          reply.raw.write(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }
        if (events.length < 250)
          await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch {
      /* Client recovers unexpected transport/storage failure through snapshot/replay. */
    } finally {
      reply.raw.off("close", close);
      reply.raw.end();
      finished();
    }
  };
  const respond = async (
    request: FastifyRequest,
    reply: FastifyReply,
    attempt: Awaited<ReturnType<AgentRuns["attempt"]>>,
  ) => {
    if (request.headers.accept?.includes("text/event-stream"))
      return subscribe(request, reply, attempt.id);
    while ((await runs.attempt(attempt.id)).status === "running")
      await new Promise((resolve) => setTimeout(resolve, 100));
    const [message] =
      await database.sql`SELECT * FROM agent_messages WHERE attempt_id=${attempt.id}`;
    if (message?.status !== "completed") {
      const [terminal] =
        await database.sql`SELECT payload FROM agent_events WHERE attempt_id=${attempt.id} AND type IN ('run.error','run.interrupted') LIMIT 1`;
      const error = terminal?.payload?.error ?? {
        code: "AI_INTERRUPTED",
        message:
          "The response was interrupted. Reload to recover saved progress.",
      };
      if (!message?.changeSetIds?.length)
        throw new AppError(error.code, error.message, 502, {
          retryable: error.retryable ?? true,
        });
      return { ...message, content: message.content || error.message };
    }
    return message;
  };
  app.post("/api/v1/agent/conversations", (request) =>
    runs.create(
      z
        .object({ requestId: z.uuid().toLowerCase().optional() })
        .strict()
        .parse(request.body ?? {}).requestId,
    ),
  );
  app.get("/api/v1/agent/conversations/:id", (request) =>
    runs.get(id(request.params)),
  );
  app.post(
    "/api/v1/agent/conversations/:id/messages",
    async (request, reply) => {
      const body = z
        .object({
          text: z.string().trim().min(1).max(4000),
          requestId: z.uuid().toLowerCase().optional(),
        })
        .strict()
        .parse(request.body);
      return respond(
        request,
        reply,
        await runs.start(
          id(request.params),
          body.requestId ?? randomUUID(),
          body.text,
        ),
      );
    },
  );
  app.get("/api/v1/agent/attempts/:id/events", (request, reply) =>
    subscribe(request, reply, id(request.params)),
  );
  app.post("/api/v1/agent/attempts/:id/cancel", (request) =>
    runs.cancel(id(request.params)),
  );
  app.post("/api/v1/agent/attempts/:id/retry", async (request, reply) => {
    const { requestId } = z
      .object({ requestId: z.uuid().toLowerCase() })
      .strict()
      .parse(request.body);
    return respond(
      request,
      reply,
      await runs.retry(id(request.params), requestId),
    );
  });
  app.get("/api/v1/agent/compatibility", () => model.compatibility());
  return runs;
}

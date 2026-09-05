import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { connectDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { AuthService } from "../src/modules/auth/service.js";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { SSEParser } from "../src/modules/agent/stream.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("authenticated chat HTTP streams", () => {
  let app: FastifyInstance,
    db: ReturnType<typeof connectDatabase>,
    origin: string,
    token: string;
  beforeEach(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    token = (await new AuthService(db).create("Chat HTTP fixture")).token;
    app = await createApp(
      readConfig({
        ...process.env,
        DATABASE_URL: url,
        LOG_LEVEL: "silent",
        OPENROUTER_API_KEY: "fixture",
        OPENROUTER_MODEL_PRIMARY: "fixture",
      }),
    );
    origin = await app.listen({ host: "127.0.0.1", port: 0 });
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    await db.sql`TRUNCATE agent_conversations CASCADE`;
    await db.sql`DELETE FROM api_tokens WHERE name='Chat HTTP fixture'`;
    await db.close();
  });
  const json = (body: object) => ({
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  it("authenticates every new stream endpoint and reports errors before SSE headers", async () => {
    for (const [path, method] of [
      ["agent/conversations", "POST"],
      [`agent/attempts/${randomUUID()}/events`, "GET"],
      [`agent/attempts/${randomUUID()}/cancel`, "POST"],
      [`agent/attempts/${randomUUID()}/retry`, "POST"],
      ["agent/compatibility", "GET"],
    ]) {
      const result = await fetch(origin + "/api/v1/" + path, { method });
      expect(result.status).toBe(401);
    }
    const response = await fetch(
      origin + "/api/v1/agent/attempts/not-a-uuid/events",
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "text/event-stream",
        },
      },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
  it("flushes acceptance before model completion, survives disconnect, and replays committed text once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const model = vi
      .spyOn(OpenRouterClient.prototype, "stream")
      .mockImplementation(async (_context, _options, delta) => {
        await gate;
        await delta("Live response");
        return { content: "Live response" };
      });
    const conversation = (await (
      await fetch(
        origin + "/api/v1/agent/conversations",
        json({ requestId: randomUUID() }),
      )
    ).json()) as { id: string };
    const requestId = randomUUID();
    const init = json({ requestId, text: "hello" });
    const response = await fetch(
      origin + `/api/v1/agent/conversations/${conversation.id}/messages`,
      { ...init, headers: { ...init.headers, accept: "text/event-stream" } },
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const frames = new SSEParser().feed(new TextDecoder().decode(first.value));
    expect(frames[0]!.event).toBe("run.started");
    const attempt = JSON.parse(frames[0]!.data).attemptId;
    await reader.cancel();
    release();
    let snapshot:
      | {
          messages: { role: string; content: string }[];
          attempts: { status: string }[];
        }
      | undefined;
    for (let i = 0; i < 100; i++) {
      snapshot = (await (
        await fetch(origin + `/api/v1/agent/conversations/${conversation.id}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as typeof snapshot;
      if (snapshot!.attempts[0]!.status === "completed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(snapshot!.messages.map((m) => m.content)).toEqual([
      "hello",
      "Live response",
    ]);
    const replay = await fetch(
      origin + `/api/v1/agent/attempts/${attempt}/events`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          "last-event-id": frames[0]!.id!,
        },
      },
    );
    const text = await replay.text();
    expect(text).toContain("text.delta");
    expect(text).toContain("run.completed");
    expect(text).not.toContain("run.started");
    const duplicate = await fetch(
      origin + `/api/v1/agent/conversations/${conversation.id}/messages`,
      init,
    );
    expect(duplicate.status).toBe(200);
    expect(model).toHaveBeenCalledTimes(1);
  });
  it("shutdown interrupts active upstream work before closing the database", async () => {
    let aborted = false;
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(OpenRouterClient.prototype, "stream").mockImplementation(
      async (_context, { signal }) => {
        entered();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            aborted = true;
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    );
    const conversation = (await (
      await fetch(origin + "/api/v1/agent/conversations", json({}))
    ).json()) as { id: string };
    const init = json({ requestId: randomUUID(), text: "wait" });
    const response = await fetch(
      origin + `/api/v1/agent/conversations/${conversation.id}/messages`,
      { ...init, headers: { ...init.headers, accept: "text/event-stream" } },
    );
    const consumed = response.text();
    await started;
    await app.close();
    expect(aborted).toBe(true);
    expect(await consumed).toContain("run.interrupted");
    expect(
      (
        await db.sql`SELECT status FROM agent_attempts WHERE conversation_id=${conversation.id}`
      )[0]!.status,
    ).toBe("interrupted");
  });
});

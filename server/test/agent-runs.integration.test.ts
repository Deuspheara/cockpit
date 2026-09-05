import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { readConfig } from "../src/config.js";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { AgentTools } from "../src/modules/agent/tools.js";
import { AgentRuns } from "../src/modules/agent/runs.js";
import { AccountService } from "../src/modules/accounts/service.js";
import { AssetService } from "../src/modules/assets/service.js";
const url = process.env.TEST_DATABASE_URL;
const config = readConfig({
  DATABASE_URL: url ?? "postgresql://test:test@localhost/finance_test",
  REDIS_URL: "redis://localhost",
  OPENROUTER_API_KEY: "test",
  OPENROUTER_MODEL_PRIMARY: "test",
});
const chunk = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const answer = (text: string) =>
  new Response(chunk({ content: text }, "stop") + "data: [DONE]\n\n");
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for test condition");
}
describe.skipIf(!url)("durable streaming runs", () => {
  let db: ReturnType<typeof connectDatabase>;
  const services: AgentRuns[] = [];
  const service = (transport: typeof fetch) => {
    const runs = new AgentRuns(db, new OpenRouterClient(config, transport));
    services.push(runs);
    return runs;
  };
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
  });
  afterAll(async () => {
    await Promise.all(services.map((s) => s.close()));
    await db.sql`TRUNCATE accounts,assets,agent_conversations CASCADE`;
    await db.close();
  });
  it("creates once, streams and completes without a subscriber, replays without executing again", async () => {
    let calls = 0;
    const runs = service(async () => {
      calls++;
      return answer("Hello €");
    });
    const createId = randomUUID();
    const c = await runs.create(createId);
    expect((await runs.create(createId)).id).toBe(c.id);
    const request = randomUUID();
    const [a, b] = await Promise.all([
      runs.start(c.id, request, "hello"),
      runs.start(c.id, request, "hello"),
    ]);
    expect(a.id).toBe(b.id);
    await until(async () => (await runs.attempt(a.id)).status !== "running");
    const conversation = await runs.get(c.id);
    expect(conversation.messages.map((m) => m.content)).toEqual([
      "hello",
      "Hello €",
    ]);
    const events = await runs.events(a.id, "0");
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "text.delta",
      "run.completed",
    ]);
    expect((await runs.events(a.id, events[0]!.id)).length).toBe(2);
    expect(calls).toBe(1);
    await expect(runs.start(c.id, request, "different")).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("persists partial text, enforces one run and cancels upstream with one terminal event", async () => {
    let aborted = false;
    const runs = service(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  chunk({ content: "Partial response" }),
                ),
              );
              init!.signal!.addEventListener("abort", () => {
                aborted = true;
                controller.error(init!.signal!.reason);
              });
            },
          }),
        ),
    );
    const c = await runs.create(),
      a = await runs.start(c.id, randomUUID(), "wait");
    await until(async () =>
      (await runs.events(a.id, "0")).some((e) => e.type === "text.delta"),
    );
    await expect(
      runs.start(c.id, randomUUID(), "second"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await Promise.all([runs.cancel(a.id), runs.cancel(a.id)]);
    await until(async () => (await runs.attempt(a.id)).status !== "running");
    expect(aborted).toBe(true);
    const snapshot = await runs.get(c.id);
    expect(snapshot.messages[1]).toMatchObject({
      content: "Partial response",
      status: "interrupted",
    });
    expect(
      (await runs.events(a.id, "0")).filter(
        (e) => e.type === "run.interrupted",
      ),
    ).toHaveLength(1);
  });
  it("keeps proposals unapplied across provider failure, retry, and repeated proposal calls", async () => {
    const account = (
      await new AccountService(db).create({
        name: "Streaming test",
        sourceType: "manual",
        assetClass: "equities",
      })
    ).id;
    const asset = (
      await new AssetService(db).create({
        symbol: "CHAT",
        name: "Chat Test",
        assetType: "etf",
        quoteCurrency: "EUR",
      })
    ).id;
    const args = {
      accountId: account,
      assetId: asset,
      transactionType: "BUY",
      inputMode: "cash_amount",
      cashAmount: "25",
      currency: "EUR",
      cadence: "monthly",
      startOn: "2026-01-01",
    };
    let iteration = 0;
    const runs = service(async () => {
      iteration++;
      if (iteration === 2)
        return new Response(
          JSON.stringify({ error: { code: 402, message: "private metadata" } }),
          { status: 402 },
        );
      if (iteration === 1 || iteration === 3)
        return new Response(
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-" + iteration,
                  type: "function",
                  function: {
                    name: "propose_create_recurring_rule",
                    arguments: JSON.stringify(
                      iteration === 3
                        ? {
                            ...args,
                            accountId: account.toUpperCase(),
                            cashAmount: "25.00",
                            interval: 1,
                            endOn: null,
                          }
                        : args,
                    ),
                  },
                },
              ],
            },
            "tool_calls",
          ) + "data: [DONE]\n\n",
        );
      return answer("Review the proposal before applying it.");
    });
    const c = await runs.create(),
      a = await runs.start(c.id, randomUUID(), "create a recurring investment");
    await until(async () => (await runs.attempt(a.id)).status === "failed");
    const first = await runs.get(c.id);
    const proposal = first.messages[1]!.changeSetIds[0];
    expect(proposal).toBeTruthy();
    const retryId = randomUUID();
    const [retry, repeated] = await Promise.all([
      runs.retry(a.id, retryId),
      runs.retry(a.id, retryId),
    ]);
    expect(retry.id).toBe(repeated.id);
    await until(
      async () => (await runs.attempt(retry.id)).status === "completed",
    );
    const [count] =
      await db.sql`SELECT count(*)::int AS count FROM change_sets WHERE created_by='agent' AND operations @> ${db.sql.json([{ after: { accountId: account } }])}::jsonb`;
    expect(count!.count).toBe(1);
    expect(
      (await db.sql`SELECT status FROM change_sets WHERE id=${proposal}`)[0]!
        .status,
    ).toBe("draft");
    expect(
      await db.sql`SELECT id FROM recurring_rules WHERE account_id=${account}`,
    ).toHaveLength(0);
    const final = await runs.get(c.id);
    expect(final.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(final.messages[2]!.changeSetIds).toEqual([proposal]);
    const encoded = JSON.stringify(final.events);
    expect(encoded).not.toContain("cashAmount");
    expect(encoded).not.toContain("private metadata");
  });
  it("Stop during a draft transaction retains that draft and prevents the next tool", async () => {
    const account = (
      await new AccountService(db).create({
        name: "Stop race",
        sourceType: "manual",
        assetClass: "equities",
      })
    ).id;
    const asset = (
      await new AssetService(db).create({
        symbol: "STOP",
        name: "Stop fixture",
        assetType: "etf",
        quoteCurrency: "EUR",
      })
    ).id;
    const args = {
      accountId: account,
      assetId: asset,
      transactionType: "BUY",
      inputMode: "cash_amount",
      cashAmount: "25",
      currency: "EUR",
      cadence: "monthly",
      startOn: "2026-01-01",
    };
    let entered: () => void = () => {},
      release: () => void = () => {};
    const inside = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = AgentTools.prototype.execute;
    let executions = 0;
    const spy = vi
      .spyOn(AgentTools.prototype, "execute")
      .mockImplementation(async function (this: AgentTools, name, input) {
        executions++;
        const result = await original.call(this, name, input);
        entered();
        await gate;
        return result;
      });
    try {
      const runs = service(
        async () =>
          new Response(
            chunk(
              {
                tool_calls: [25, 30].map((amount, index) => ({
                  index,
                  id: "race-" + index,
                  type: "function",
                  function: {
                    name: "propose_create_recurring_rule",
                    arguments: JSON.stringify({
                      ...args,
                      cashAmount: String(amount),
                    }),
                  },
                })),
              },
              "tool_calls",
            ) + "data: [DONE]\n\n",
          ),
      );
      const c = await runs.create(),
        a = await runs.start(c.id, randomUUID(), "prepare two drafts");
      await inside;
      const stopping = runs.cancel(a.id);
      await new Promise((r) => setTimeout(r, 30));
      release();
      await stopping;
      await until(
        async () => (await runs.attempt(a.id)).status === "interrupted",
      );
      expect(executions).toBe(1);
      const snapshot = await runs.get(c.id);
      expect(snapshot.messages[1]!.changeSetIds).toHaveLength(1);
      expect(
        await db.sql`SELECT id FROM recurring_rules WHERE account_id=${account}`,
      ).toHaveLength(0);
      const types = (await runs.events(a.id, "0")).map((e) => e.type);
      expect(types.at(-1)).toBe("run.interrupted");
      expect(types).toContain("proposal.created");
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("recovers abandoned leases without restarting or duplicating terminal events", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runs = service(async () => {
      await gate;
      return answer("late");
    });
    const c = await runs.create(),
      a = await runs.start(c.id, randomUUID(), "restart");
    await db.sql`UPDATE agent_attempts SET lease_until=now()-interval '1 second' WHERE id=${a.id}`;
    await runs.recover();
    await runs.recover();
    release();
    await until(
      async () => (await runs.attempt(a.id)).status === "interrupted",
    );
    expect(
      (await runs.events(a.id, "0")).filter(
        (e) => e.type.startsWith("run.") && e.type !== "run.started",
      ),
    ).toHaveLength(1);
  });
});

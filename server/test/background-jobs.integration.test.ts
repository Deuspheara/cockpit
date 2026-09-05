import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { readConfig } from "../src/config.js";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { ChangeSetService } from "../src/modules/changes/service.js";
import { ImportService } from "../src/modules/imports/service.js";
import { ImportJobs } from "../src/modules/imports/jobs.js";
import { AccountService } from "../src/modules/accounts/service.js";
import { SyncService } from "../src/modules/integrations/service.js";
import { connectCache } from "../src/shared/cache.js";
import { emptySync } from "../src/modules/integrations/types.js";
import Fastify from "fastify";
import { registerImportRoutes } from "../src/modules/imports/routes.js";
const url = process.env.TEST_DATABASE_URL;
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await pause();
  }
  throw new Error("State did not settle");
}
describe.skipIf(!url)("durable asynchronous imports and wallet sync", () => {
  let db: ReturnType<typeof connectDatabase>;
  let cache: ReturnType<typeof connectCache>;
  const config = readConfig({
    ...process.env,
    DATABASE_URL: url ?? "postgresql://test:test@localhost/finance_test",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    OPENROUTER_API_KEY: "fixture",
    OPENROUTER_MODEL_VISION: "fixture",
  });
  beforeAll(async () => {
    if (!url?.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    cache = connectCache(process.env.REDIS_URL!);
  });
  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets,import_sessions CASCADE`;
    cache.destroy();
    await db.close();
  });
  function service(
    transport: typeof fetch,
    market?: { search: (query: string) => Promise<never[]> },
  ) {
    return new ImportService(
      db,
      new OpenRouterClient(config, transport),
      new ChangeSetService(db),
      market,
    );
  }
  function response(count = 1) {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                likelyAccountName: "Review",
                currency: "EUR",
                positions: Array.from({ length: count }, (_, i) => ({
                  symbol: `P${i % 5}`,
                  quantity: null,
                  marketValue: "10",
                  currency: "EUR",
                  confidence: 1,
                })),
              }),
            },
          },
        ],
      }),
    );
  }
  it("returns HTTP 202 before blocked vision, combines images, deduplicates market calls at concurrency four", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const model = new OpenRouterClient(config, async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(
        body.messages[1].content.filter(
          (c: { type: string }) => c.type === "image_url",
        ),
      ).toHaveLength(2);
      await gate;
      return response();
    });
    const app = Fastify();
    const jobs = await registerImportRoutes(app, db, cache, config, model);
    const created = (
      await app.inject({ method: "POST", url: "/api/v1/imports", payload: {} })
    ).json();
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    const boundary = "test-boundary";
    const payload = Buffer.concat(
      [1, 2]
        .flatMap(() => [
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="screenshot"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`,
          ),
          png,
          Buffer.from("\r\n"),
        ])
        .concat(Buffer.from(`--${boundary}--\r\n`)),
    );
    const started = Date.now();
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/imports/${created.id}/jobs?requestId=${randomUUID()}&revision=0`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(accepted.statusCode).toBe(202);
    expect(Date.now() - started).toBeLessThan(2000);
    release();
    await until(
      async () =>
        (await jobs.get(created.id, accepted.json().id)).status === "completed",
    );
    expect(calls).toBe(1);
    await jobs.close();
    await app.close();
    let active = 0,
      maximum = 0;
    const lookups: string[] = [];
    const imports = service(async () => response(20), {
      search: async (query) => {
        lookups.push(query);
        active++;
        maximum = Math.max(maximum, active);
        await pause(20);
        active--;
        throw new Error("quota");
      },
    });
    const session = await imports.create();
    const result = await imports.extract(session.id, {
      bytes: Buffer.from("image"),
      mime: "image/png",
    });
    expect(lookups).toHaveLength(5);
    expect(maximum).toBe(4);
    expect(result.warnings.join(" ")).toContain("unknown quantity");
  });
  it("persists phases, fences cancellation and revisions, wipes buffers, and expires interrupted jobs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const imports = service(async () => {
      await gate;
      return response();
    });
    const jobs = new ImportJobs(db, imports);
    const session = await imports.create();
    const requestId = randomUUID();
    const bytes = Buffer.from("secret-image");
    const job = await jobs.create(session.id, requestId, 0, [
      { bytes, mime: "image/png" },
    ]);
    const replayBytes = Buffer.from("replay");
    expect(
      (
        await jobs.create(session.id, requestId, 0, [
          { bytes: replayBytes, mime: "image/png" },
        ])
      ).id,
    ).toBe(job.id);
    expect(replayBytes.every((v) => v === 0)).toBe(true);
    await until(
      async () =>
        (await jobs.get(session.id, String(job.id))).phase === "extracting",
    );
    await jobs.cancel(session.id, String(job.id));
    release();
    expect(bytes.every((v) => v === 0)).toBe(true);
    await pause(30);
    expect((await imports.get(session.id)).extraction).toBeNull();
    const phases: string[] = [];
    const next = await imports.create();
    const [running] =
      await db.sql`INSERT INTO import_jobs(import_session_id,request_id,session_revision,status) VALUES(${next.id},${randomUUID()},0,'running') RETURNING id`;
    await imports.extract(
      next.id,
      { bytes: Buffer.from("image"), mime: "image/png" },
      undefined,
      {
        id: String(running!.id),
        revision: 0,
        signal: new AbortController().signal,
        phase: async (phase) => {
          phases.push(phase);
        },
      },
    );
    expect(phases).toEqual(["matching", "estimating", "finalizing"]);
    const oldBytes = Buffer.from("old");
    await expect(
      jobs.create(next.id, randomUUID(), 0, [
        { bytes: oldBytes, mime: "image/png" },
      ]),
    ).rejects.toThrow("changed");
    expect(oldBytes.every((v) => v === 0)).toBe(true);
    const interrupted = await imports.create();
    await db.sql`INSERT INTO import_jobs(import_session_id,request_id,session_revision) VALUES(${interrupted.id},${randomUUID()},0)`;
    await jobs.expire();
    expect(
      (await imports.get(interrupted.id)).processing?.failure,
    ).toMatchObject({ code: "REUPLOAD_REQUIRED" });
    await jobs.close();
  });
  it("keeps EVM accounts saved after missing configuration, reports Alchemy failure, and retries successfully", async () => {
    const accounts = new AccountService(db);
    const account = await accounts.create({
      name: "Wallet",
      sourceType: "evm_wallet",
      assetClass: "crypto",
      externalAddress: "0x" + "a".repeat(40),
    });
    const sync = new SyncService(db, cache, { ...config, ALCHEMY_API_KEY: "" });
    expect((await sync.getRun(account.id))?.status).toBe("queued");
    await Promise.all([sync.runQueued(), sync.runQueued()]);
    expect(await accounts.get(account.id)).toBeTruthy();
    expect(await sync.getRun(account.id)).toMatchObject({
      status: "failed",
      provider: "alchemy",
      failure: { code: "ALCHEMY_NOT_CONFIGURED", retryable: false },
    });
    let calls = 0;
    const healthy = new SyncService(db, cache, config, {
      evm_wallet: {
        kind: "evm_wallet",
        syncAccount: async () => {
          calls++;
          return {
            ...emptySync(),
            coveredScopes: ["eth-mainnet"],
            warnings: ["base-mainnet: unavailable"],
          };
        },
      },
    });
    const run = await healthy.enqueue(account.id);
    expect((await healthy.enqueue(account.id))?.id).toBe(run?.id);
    await Promise.all([healthy.runQueued(), healthy.runQueued()]);
    expect(calls).toBe(1);
    expect(await healthy.getRun(account.id)).toMatchObject({
      status: "partial",
      provider: "alchemy",
      warnings: ["base-mainnet: unavailable"],
    });
  });
});

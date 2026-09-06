import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { connectDatabase } from "../src/db/index.js";
import { readConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { migrate } from "../src/db/migrate.js";
import type { FastifyInstance } from "fastify";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL device authentication", () => {
  let app: FastifyInstance;
  let token: string;
  let id: string;
  let database: ReturnType<typeof connectDatabase>;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error(
        "Integration tests require dedicated finance_test database",
      );
    await migrate(url);
    database = connectDatabase(url);
    const created = await new AuthService(database).create("Integration test");
    token = created.token;
    id = created.id;
    app = await createApp(
      readConfig({ ...process.env, DATABASE_URL: url, LOG_LEVEL: "silent" }),
    );
  });
  afterAll(async () => {
    await database.sql`DELETE FROM api_tokens WHERE id=${id}`;
    await database.close();
    await app.close();
  });
  it("health reaches PostgreSQL without auth", async () => {
    const result = await app.inject("/health");
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ status: "healthy" });
  });
  it("protects application routes", async () => {
    expect((await app.inject("/api/v1/session")).statusCode).toBe(401);
    for (const method of ["GET", "POST"] as const) {
      expect(
        (
          await app.inject({
            method,
            url: "/api/v1/accounts/00000000-0000-4000-8000-000000000001/history-jobs",
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (
        await app.inject({
          url: "/api/v1/session",
          headers: { authorization: "Bearer incorrect" },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("accepts a token whose database record contains only the hash", async () => {
    const records =
      await database.sql`SELECT token_hash FROM api_tokens WHERE id=${id}`;
    expect(records[0]?.tokenHash).not.toBe(token);
    expect(
      (
        await app.inject({
          url: "/api/v1/session",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("accepts uppercase iOS UUIDs without dropping account positions or valuation", async () => {
    const [account] =
      await database.sql`INSERT INTO accounts(name,asset_class,source_type,base_currency) VALUES('UUID regression','cash','manual','EUR') RETURNING id`;
    const [asset] =
      await database.sql`INSERT INTO assets(asset_type,symbol,name,quote_currency) VALUES('cash','EUR','Euro','EUR') RETURNING id`;
    try {
      await database.sql`INSERT INTO holding_observations(account_id,asset_id,observed_at,quantity,currency,source) VALUES(${String(account!.id)},${String(asset!.id)},now(),'123','EUR','manual')`;
      const result = await app.inject({
        url: `/api/v1/accounts/${String(account!.id).toUpperCase()}/detail`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().positions).toHaveLength(1);
      expect(result.json().dashboard.value).toBe("123.000000000000000000");
    } finally {
      await database.sql`DELETE FROM holding_observations WHERE account_id=${String(account!.id)}`;
      await database.sql`DELETE FROM accounts WHERE id=${String(account!.id)}`;
      await database.sql`DELETE FROM assets WHERE id=${String(asset!.id)}`;
    }
  });
  it("rejects revoked tokens", async () => {
    await new AuthService(database).revoke(id);
    expect(
      (
        await app.inject({
          url: "/api/v1/session",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});

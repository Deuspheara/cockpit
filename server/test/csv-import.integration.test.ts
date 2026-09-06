import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { connectDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { readConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { CsvImportService } from "../src/modules/imports/csv/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
import { readCsv, parseCsv } from "../src/modules/imports/csv/parser.js";
import { Decimal } from "../src/shared/decimal.js";
const url = process.env.TEST_DATABASE_URL;
const fixture = readFileSync(
  new URL("./fixtures/trade-republic.csv", import.meta.url),
);
const input = readCsv(fixture);
function csv(count: number, patch: Record<string, string> = {}) {
  const template = input.records.find(
    (r) => r.values[input.headers.indexOf("type")] === "TRANSFER_INBOUND",
  )!.values;
  const records = Array.from({ length: count }, (_, i) => {
    const r = [...template];
    const p = { transaction_id: `fixture-${i}`, amount: "100", ...patch };
    for (const [k, v] of Object.entries(p)) r[input.headers.indexOf(k)] = v;
    return r;
  });
  return Buffer.from(
    [input.headers, ...records]
      .map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(","))
      .join("\n"),
  );
}
describe.skipIf(!url)("atomic CSV HTTP imports", () => {
  let db: ReturnType<typeof connectDatabase>,
    app: FastifyInstance,
    service: CsvImportService,
    owner: string,
    token: string,
    otherToken: string,
    otherOwner: string;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    service = new CsvImportService(db);
    const auth = new AuthService(db),
      a = await auth.create("csv test"),
      b = await auth.create("csv other device");
    owner = a.id;
    token = a.token;
    otherToken = b.token;
    otherOwner = b.id;
    app = await createApp(
      readConfig({ ...process.env, DATABASE_URL: url, LOG_LEVEL: "silent" }),
    );
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE accounts,assets,csv_import_batches CASCADE`;
  });
  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets,csv_import_batches CASCADE`;
    await db.sql`DELETE FROM api_tokens WHERE id IN (${owner},${otherOwner})`;
    await app.close();
    await db.close();
  });
  async function upload(bytes: Buffer, filename = "fixture.csv", auth = token) {
    const boundary = "csv-test";
    return app.inject({
      method: "POST",
      url: "/api/v1/imports/csv/preview",
      headers: {
        authorization: `Bearer ${auth}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  }
  async function preview(bytes = csv(100)) {
    const p = await upload(bytes);
    expect(p.statusCode, p.body).toBe(200);
    return p.json() as Awaited<ReturnType<CsvImportService["create"]>>;
  }
  async function confirm(p: Awaited<ReturnType<typeof preview>>) {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/imports/csv/${p.id}/confirm`,
      headers: { authorization: `Bearer ${token}` },
      payload: { revision: p.revision },
    });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Awaited<ReturnType<CsvImportService["confirm"]>>;
  }
  it("previews without financial writes, confirms 100, ignores repeats, and inserts only 10 overlapping additions", async () => {
    const first = await preview();
    expect(first.summary.new).toBe(100);
    expect(await db.sql`SELECT id FROM transactions`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM accounts`).toHaveLength(0);
    expect((await confirm(first)).result!.imported).toBe(100);
    expect((await confirm(first)).result!.imported).toBe(100);
    const repeated = await preview();
    expect(repeated.summary.duplicates).toBe(100);
    expect((await confirm(repeated)).result!.imported).toBe(0);
    const newer = await preview(csv(110));
    expect((await confirm(newer)).result!.imported).toBe(10);
    expect(await db.sql`SELECT id FROM transactions`).toHaveLength(110);
  });
  it("reconstructs positions and cash independently for both account groups with no invented prices", async () => {
    const p = await preview(fixture),
      completed = await confirm(p);
    expect(completed.result!.accounts).toHaveLength(2);
    const parsed = parseCsv(fixture),
      positions = await new PortfolioService(db).positions();
    for (const account of completed.result!.accounts) {
      const group = account.name.includes("PEA") ? "PEA" : "DEFAULT";
      const expected = parsed.transactions
        .filter((t) => t.group === group)
        .reduce((sum, t) => sum.plus(t.netCashAmount), new Decimal(0));
      const cash = positions
        .get(account.id)!
        .find((p) => p.assetType === "cash");
      expect(cash?.quantity ?? "0.000000000000000000").toBe(
        expected.toFixed(18),
      );
      for (const position of positions
        .get(account.id)!
        .filter((p) => p.assetType !== "cash"))
        expect(position.marketValue).toBeUndefined();
    }
    const history = await app.inject({
      url: `/api/v1/accounts/${completed.result!.accounts[0]!.id}/imports`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(history.json()).toHaveLength(1);
    const batch =
      await db.sql`SELECT staged FROM csv_import_batches WHERE id=${p.id}`;
    expect(batch[0]!.staged).toBeNull();
  });
  it("cancellation, expiration, authentication and ownership protect previews", async () => {
    const p = await preview(csv(1));
    expect(
      (
        await app.inject({
          url: `/api/v1/imports/csv/${p.id}`,
          headers: { authorization: `Bearer ${otherToken}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/imports/csv/${p.id}/confirm`,
          headers: { authorization: `Bearer ${otherToken}` },
          payload: { revision: 1 },
        })
      ).statusCode,
    ).toBe(404);
    await service.cancel(p.id, owner);
    expect(await db.sql`SELECT id FROM transactions`).toHaveLength(0);
    expect(await db.sql`SELECT id FROM assets`).toHaveLength(0);
    const exp = await preview(csv(1));
    await db.sql`UPDATE csv_import_batches SET expires_at=now()-interval '1 minute' WHERE id=${exp.id}`;
    expect((await service.get(exp.id, owner)).status).toBe("expired");
    await expect(service.confirm(exp.id, owner, 1)).rejects.toThrow();
    expect((await upload(csv(1), "file.csv", "bad")).statusCode).toBe(401);
  });
  it("does not overwrite conflicts and does not resurrect voided rows", async () => {
    await confirm(await preview(csv(1)));
    const conflict = await preview(csv(1, { amount: "101" }));
    expect(conflict.summary.conflicts).toBe(1);
    expect((await confirm(conflict)).result!.imported).toBe(0);
    await db.sql`UPDATE transactions SET is_voided=true`;
    expect((await preview(csv(1))).summary.duplicates).toBe(1);
    expect((await db.sql`SELECT quantity FROM transactions`)[0]!.quantity).toBe(
      "100.000000000000000000",
    );
  });
  it("serializes overlapping confirmations and refreshes newly discovered conflicts", async () => {
    const a = await preview(csv(100)),
      b = await preview(csv(100));
    const results = await Promise.all([
      service.confirm(a.id, owner, 1),
      service.confirm(b.id, owner, 1),
    ]);
    expect(results.reduce((n, r) => n + r.result!.imported, 0)).toBe(100);
    expect(await db.sql`SELECT id FROM accounts`).toHaveLength(1);
    const c = await preview(csv(101)),
      d = await preview(csv(101, { amount: "101" }));
    await confirm(c);
    const stale = await service.confirm(d.id, owner, 1);
    expect(stale.result).toBeNull();
    expect(stale.revision).toBe(2);
  });
  it("handles duplicate IDs inside files and missing-ID fingerprints conservatively", async () => {
    const p = await preview(csv(2, { transaction_id: "" }));
    expect(p.summary.new).toBe(1);
    expect(p.summary.duplicates).toBe(1);
    expect((await confirm(p)).result!.imported).toBe(1);
    expect(
      (await preview(csv(2, { transaction_id: "" }))).summary.duplicates,
    ).toBe(2);
  });
  it("reorders without duplicates, restricts destination groups, and supports existing account updates", async () => {
    const first = await preview(fixture);
    const selected = first.destinations.map((d) => ({
      group: d.group,
      accountId: d.accountId,
      name: d.name,
      included: d.group === "PEA",
    }));
    const updated = await service.update(
      first.id,
      owner,
      first.revision,
      selected,
    );
    const completed = await service.confirm(first.id, owner, updated.revision);
    expect(completed.result!.accounts).toHaveLength(1);
    const target = completed.result!.accounts[0]!.id;
    const subsequent = await app.inject({
      method: "POST",
      url: `/api/v1/imports/csv/${first.id}/confirm`,
      headers: { authorization: `Bearer ${token}` },
      payload: { revision: updated.revision, transactions: [] },
    });
    expect(subsequent.statusCode).toBe(400);
    const reversed = Buffer.from(
      [input.headers, ...input.records.map((r) => r.values).reverse()]
        .map((r) => r.map((v) => '"' + v.replaceAll('"', '""') + '"').join(","))
        .join("\n"),
    );
    const again = await service.create(
      owner,
      "reordered.csv",
      reversed,
      "trade_republic",
      target,
    );
    expect(again.destinations.find((d) => d.group === "PEA")!.summary.new).toBe(
      0,
    );
    expect(
      again.destinations.find((d) => d.group === "PEA")!.summary.duplicates,
    ).toBeGreaterThan(0);
    await expect(
      service.update(
        again.id,
        owner,
        1,
        again.destinations.map((d) => ({
          group: d.group,
          accountId: target,
          name: d.name,
          included: true,
        })),
      ),
    ).rejects.toThrow();
  });
  it("creates cash settlement for a trade-only file without turning execution prices into quotes", async () => {
    const p = await preview(
      csv(1, {
        type: "BUY",
        category: "TRADING",
        symbol: "US0378331005",
        asset_class: "STOCK",
        name: "Example",
        shares: "2",
        price: "10",
        amount: "-20",
        fee: "-1",
        tax: "-2",
      }),
    );
    const done = await confirm(p);
    const positions = (await new PortfolioService(db).positions()).get(
      done.result!.accounts[0]!.id,
    )!;
    expect(positions.find((p) => p.assetType === "cash")!.quantity).toBe(
      "-23.000000000000000000",
    );
    expect(positions.find((p) => p.assetType === "equity")!.quantity).toBe(
      "2.000000000000000000",
    );
    expect(
      positions.find((p) => p.assetType === "equity")!.marketValue,
    ).toBeUndefined();
    expect(done.result!.positionsUpdated).toBe(2);
  });
  it("reconciles observed cash including trade settlements", async () => {
    const completed = await confirm(await preview(fixture));
    const account = completed.result!.accounts.find(
      (a) => a.name === "Trade Republic",
    )!;
    const positions = await new PortfolioService(db).positions(account.id);
    const cash = positions
      .get(account.id)!
      .find((p) => p.assetType === "cash")!;
    await db.sql`INSERT INTO holding_observations(account_id,asset_id,observed_at,quantity,currency,source) VALUES(${account.id},${cash.assetId},now(),${cash.quantity!},'EUR','manual')`;
    await confirm(await preview(fixture));
    expect(
      await db.sql`SELECT id FROM reconciliation_items WHERE account_id=${account.id} AND asset_id=${cash.assetId} AND status='open'`,
    ).toHaveLength(0);
  });
  it("does not mix an existing security's accounting currency", async () => {
    await db.sql`INSERT INTO assets(asset_type,symbol,name,quote_currency,external_ids) VALUES('equity','AAPL','Example','USD','{"isin":"US0378331005"}')`;
    const p = await preview(
      csv(1, {
        type: "BUY",
        category: "TRADING",
        symbol: "US0378331005",
        asset_class: "STOCK",
        name: "Example",
        shares: "2",
        price: "10",
        amount: "-20",
      }),
    );
    expect(p.summary.new).toBe(0);
    expect(p.issues[0]!.code).toBe("ASSET_CURRENCY_MISMATCH");
  });
  it("imports several thousand rows across bulk-insert boundaries", async () => {
    const done = await confirm(await preview(csv(5000)));
    expect(done.result!.imported).toBe(5000);
    expect(await db.sql`SELECT id FROM transactions`).toHaveLength(5000);
    expect((await preview(csv(5000))).summary.duplicates).toBe(5000);
  }, 20000);
  it("rolls back accounts, assets, transactions and completion on a critical failure", async () => {
    const p = await preview(csv(2));
    await db.sql`CREATE FUNCTION csv_test_failure() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''test failure''; END;'`;
    await db.sql`CREATE TRIGGER csv_test_failure BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION csv_test_failure()`;
    try {
      await expect(service.confirm(p.id, owner, 1)).rejects.toThrow();
      expect(await db.sql`SELECT id FROM accounts`).toHaveLength(0);
      expect(await db.sql`SELECT id FROM assets`).toHaveLength(0);
      expect((await service.get(p.id, owner)).status).toBe("preview");
    } finally {
      await db.sql`DROP TRIGGER csv_test_failure ON transactions`;
      await db.sql`DROP FUNCTION csv_test_failure()`;
    }
  });
  it("rejects extensions, malformed uploads, binary and oversized data", async () => {
    for (const [data, name] of [
      [csv(1), "file.exe"],
      [Buffer.from("\0binary"), "file.csv"],
      [Buffer.alloc(10 * 1024 * 1024 + 1, 65), "file.csv"],
    ] as const)
      expect((await upload(data, name)).statusCode).toBeGreaterThanOrEqual(400);
  });
});

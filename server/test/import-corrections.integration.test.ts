import { beforeAll, afterAll, describe, it, expect } from "vitest";
import Fastify from "fastify";
import { connectDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { readConfig } from "../src/config.js";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { ChangeSetService } from "../src/modules/changes/service.js";
import { ImportService } from "../src/modules/imports/service.js";
import { registerImportRoutes } from "../src/modules/imports/routes.js";
import type { MarketCandidate } from "../src/modules/imports/market-data.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("screenshot holding corrections from iOS", () => {
  let db: ReturnType<typeof connectDatabase>;
  const config = readConfig({
    ...process.env,
    DATABASE_URL: url ?? "postgres://test:test@localhost/finance_test",
    REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
    OPENROUTER_API_KEY: "fixture",
    OPENROUTER_MODEL_VISION: "fixture",
  });
  beforeAll(async () => {
    if (!url?.endsWith("/finance_test")) throw new Error("Test DB required");
    await migrate(url);
    db = connectDatabase(url);
  });
  afterAll(async () => {
    await db.sql`TRUNCATE import_sessions,accounts,assets CASCADE`;
    await db.close();
  });
  const candidate: MarketCandidate = {
    providerKey: "EUNL.XETRA",
    symbol: "EUNL",
    name: "iShares Core MSCI World UCITS ETF",
    exchange: "XETRA",
    type: "ETF",
    currency: "EUR",
    isin: "IE00B4L5Y983",
    price: "100",
    quotedAt: "2026-09-04T00:00:00Z",
    isPrimary: false,
  };
  function setup(unitPrice: string | null = null, ambiguous = false) {
    const model = new OpenRouterClient(config, async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                likelyAccountName: "Broker",
                capturedAt: "2026-09-05T10:00:00Z",
                currency: "EUR",
                positions: [
                  {
                    name: "Core MSCI World USD (Acc)",
                    unitPrice,
                    marketValue: "2500",
                    currency: "EUR",
                    confidence: 1,
                  },
                ],
                derivatives: [
                  {
                    name: "AAPL Put 195 USD 2026-12-18",
                    underlyingSymbol: "AAPL",
                    optionType: "put",
                    strike: "195",
                    expiration: "2026-12-18",
                    marketValue: "35",
                    currency: "USD",
                    confidence: 1,
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
    let calls = 0;
    const service = new ImportService(db, model, new ChangeSetService(db), {
      search: async () => {
        calls++;
        return [
          {
            ...candidate,
            isin: ambiguous ? "IE00OTHER0001" : candidate.isin,
            providerKey: "IWDA.LSE",
            symbol: "IWDA",
            currency: "USD",
            price: "110",
            isPrimary: true,
          },
          candidate,
        ];
      },
    });
    return { model, service, calls: () => calls };
  }
  it("resolves the abbreviated fund name across listings and estimates shares without asking for a ticker", async () => {
    const { service } = setup();
    const created = await service.create();
    const result = await service.extract(created.id, {
      bytes: Buffer.from("fixture"),
      mime: "image/png",
    });
    expect(result.blockers).toEqual([]);
    expect(result.extraction!.positions[0]).toMatchObject({
      symbol: "EUNL",
      quantity: "25",
      quantitySource: "estimated",
      quoteCurrency: "EUR",
    });
    expect(result.extraction!.derivatives[0]).toMatchObject({
      optionType: "put",
      quantity: null,
      marketValue: "35",
    });
  });
  it("still asks for investment identity when similarly named funds have different ISINs", async () => {
    const { service } = setup(null, true);
    const created = await service.create();
    const result = await service.extract(created.id, {
      bytes: Buffer.from("fixture"),
      mime: "image/png",
    });
    expect(result.extraction!.positions[0]).toMatchObject({
      matchStatus: "ambiguous",
      quantity: null,
      marketValue: "2500",
    });
    expect(
      result.blockers.every((message) => !message.includes("needs a quantity")),
    ).toBe(true);
    const row = result.extraction!.positions[0]!;
    expect(row.matchCandidates).toHaveLength(2);
    expect(result.candidateIssues[row.candidateId!]).not.toEqual([]);
    const saved = await service.update(created.id, result.revision, {
      positions: [{ candidateId: row.candidateId! }],
    });
    expect(saved.candidateIssues[row.candidateId!]).not.toEqual([]);
    expect(saved.revision).toBe(result.revision + 1);
    const selected = row.matchCandidates.find((c) => c.symbol === "EUNL")!;
    const resolved = await service.update(created.id, saved.revision, {
      positions: [{ candidateId: row.candidateId!, symbol: selected.symbol, isin: selected.isin, name: selected.name }],
    });
    expect(resolved.candidateIssues[row.candidateId!]).toEqual([]);
    expect(resolved.blockers).toEqual([]);
    expect(resolved.extraction!.positions[0]!.quantity).toBe("25");
    await expect(service.prepare(created.id)).resolves.toBeDefined();
  });
  it("accepts uppercase iOS row IDs for both stocks and puts and keeps no-op edits estimated", async () => {
    const { service, model } = setup("125");
    const created = await service.create();
    let session = await service.extract(created.id, {
      bytes: Buffer.from("fixture"),
      mime: "image/png",
    });
    expect(session.extraction!.positions[0]!.quantity).toBe("20");
    const app = Fastify();
    const jobs = await registerImportRoutes(
      app,
      db,
      {} as never,
      config,
      model,
    );
    const result = await app.inject({
      method: "PATCH",
      url: `/api/v1/imports/${session.id.toUpperCase()}`,
      payload: {
        revision: session.revision,
        positions: [
          {
            candidateId:
              session.extraction!.positions[0]!.candidateId!.toUpperCase(),
            symbol: "EUNL",
          },
        ],
        derivatives: [
          {
            candidateId:
              session.extraction!.derivatives[0]!.candidateId!.toUpperCase(),
            marketValue: "40",
          },
        ],
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().extraction.positions[0]).toMatchObject({
      quantity: "20",
      quantitySource: "estimated",
    });
    expect(result.json().extraction.derivatives[0].marketValue).toBe("40");
    session = await service.get(created.id);
    const updated = await service.update(created.id, session.revision, {
      positions: [
        {
          candidateId:
            session.extraction!.positions[0]!.candidateId!.toUpperCase(),
          marketValue: "1250",
        },
      ],
    });
    expect(updated.extraction!.positions[0]!.quantity).toBe("10");
    await jobs.close();
    await app.close();
  });
});

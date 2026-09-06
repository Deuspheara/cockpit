import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Cache } from "../src/shared/cache.js";
import { connectDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { readConfig } from "../src/config.js";
import {
  EODHDClient,
  EODHDQuotaCoordinator,
  MarketProviderError,
  OpenFigiClient,
  type EodBar,
} from "../src/modules/market-data/providers.js";
import {
  linkSecurityAsset,
  MarketDataService,
} from "../src/modules/market-data/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";

const url = process.env.TEST_DATABASE_URL;

function cache() {
  return {
    async incr() {
      return 1;
    },
    async expire() {
      return true;
    },
  } as unknown as Cache;
}

describe.skipIf(!url)("durable shared market-data pipeline", () => {
  let db: ReturnType<typeof connectDatabase>;

  beforeAll(async () => {
    if (!url?.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE provider_call_budgets,provider_work_leases,accounts,assets CASCADE`;
  });

  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets CASCADE`;
    await db.close();
  });

  it("queues without provider I/O, preserves a revision-locked selection, and retains its last good close", async () => {
    let searches = 0;
    let mappings = 0;
    let enrichments = 0;
    let dailyRequests = 0;
    let figiBatches = 0;
    let failDaily = false;
    const bars: EodBar[] = [
      {
        date: new Date().toISOString().slice(0, 10),
        open: "100.000000000000000000",
        high: "102.000000000000000000",
        low: "99.000000000000000000",
        close: "101.000000000000000000",
        adjustedClose: "101.000000000000000000",
        volume: "1000.000000000000000000",
      },
    ];
    const eodhd = {
      async mapIsin() {
        mappings++;
        return [];
      },
      async searchIsin(isin: string) {
        searches++;
        return [
          {
            providerSymbol: "AIR.PA",
            ticker: "AIR",
            exchange: "PA",
            name: "Airbus SE",
            type: "Common Stock",
            currency: "EUR",
            isin,
            isPrimary: false,
          },
          {
            providerSymbol: "AIR.XETRA",
            ticker: "AIR",
            exchange: "XETRA",
            name: "Airbus SE",
            type: "Common Stock",
            currency: "EUR",
            isin,
            isPrimary: false,
          },
        ];
      },
      async searchExact() {
        enrichments++;
        return [];
      },
      async daily() {
        dailyRequests++;
        if (failDaily)
          throw new MarketProviderError(
            "provider_unavailable",
            "EODHD is temporarily unavailable.",
          );
        return bars;
      },
    } as unknown as EODHDClient;
    const openFigi = {
      async mapIsins(isins: string[]) {
        figiBatches++;
        return new Map(isins.map((isin) => [isin, []]));
      },
    } as unknown as OpenFigiClient;
    const config = readConfig({
      ...process.env,
      DATABASE_URL: url!,
      REDIS_URL: "redis://127.0.0.1:6379",
      LOG_LEVEL: "silent",
    });
    const service = new MarketDataService(db, cache(), config, {
      eodhd,
      openFigi,
    });

    const [account] = await db.sql<{ id: string }[]>`
      INSERT INTO accounts(name,asset_class,source_type,base_currency)
      VALUES('PEA','equities','manual','EUR') RETURNING id`;
    const [asset] = await db.sql<{ id: string }[]>`
      INSERT INTO assets(asset_type,symbol,name,quote_currency,external_ids)
      VALUES('equity','AIR','Airbus','EUR',${db.sql.json({ isin: "NL0000235190" })}) RETURNING id`;
    const securityId = await db.sql.begin((tx) =>
      linkSecurityAsset(tx, {
        assetId: asset!.id,
        isin: "NL0000235190",
        name: "Airbus",
        assetType: "equity",
      }),
    );
    await db.sql`
      INSERT INTO transactions(account_id,asset_id,type,occurred_at,quantity,unit_price,currency,source,external_id)
      VALUES(${account!.id},${asset!.id},'BUY',now(),2,100,'EUR','manual','air-buy')`;
    const [defaultAccount] = await db.sql<{ id: string }[]>`
      INSERT INTO accounts(name,asset_class,source_type,base_currency)
      VALUES('DEFAULT','equities','manual','EUR') RETURNING id`;
    const [duplicate] = await db.sql<{ id: string }[]>`
      INSERT INTO assets(asset_type,symbol,name,quote_currency,external_ids)
      VALUES('equity','AIR','Airbus duplicate','EUR',${db.sql.json({ isin: "NL0000235190" })}) RETURNING id`;
    await db.sql.begin((tx) =>
      linkSecurityAsset(tx, {
        assetId: duplicate!.id,
        isin: "NL0000235190",
        name: "Airbus duplicate",
        assetType: "equity",
      }),
    );
    await db.sql`
      INSERT INTO transactions(account_id,asset_id,type,occurred_at,quantity,unit_price,currency,source,external_id)
      VALUES(${defaultAccount!.id},${duplicate!.id},'BUY',now(),1,100,'EUR','manual','air-default-buy')`;
    expect(
      await db.sql`SELECT id FROM market_data_jobs WHERE security_id=${securityId} AND job_type='resolve' AND status IN ('queued','running')`,
    ).toHaveLength(1);
    expect(
      await db.sql`SELECT DISTINCT security_id FROM assets WHERE id IN (${asset!.id},${duplicate!.id})`,
    ).toEqual([{ securityId }]);
    expect(searches).toBe(0);

    expect(await service.runDue()).toBe(1);
    expect(searches).toBe(1);
    expect(mappings).toBe(0);
    expect(enrichments).toBe(0);
    expect(figiBatches).toBe(1);
    let detail = await service.detail(securityId!);
    expect(detail).toMatchObject({
      identityStatus: "identity_resolved",
      selectionLocked: false,
      preferredMappingId: null,
    });
    expect(detail.mappings).toHaveLength(2);

    const mappingId = detail.mappings[0]!.id as string;
    await service.select(securityId!, mappingId, detail.revision);
    detail = await service.detail(securityId!);
    expect(detail).toMatchObject({
      preferredMappingId: mappingId,
      selectionLocked: true,
    });
    await expect(
      service.select(securityId!, null, detail.revision - 1),
    ).rejects.toThrow("changed");

    await db.sql`
      INSERT INTO market_data_jobs(security_id,job_type)
      VALUES(${securityId},'resolve')`;
    expect(await service.runDue(4)).toBe(2);
    detail = await service.detail(securityId!);
    expect(dailyRequests).toBe(1);
    expect(searches).toBe(1);
    expect(detail.selectionLocked).toBe(true);
    expect(detail.latestPrice).toMatchObject({
      close: "101.000000000000000000",
      timePrecision: "date",
    });

    await db.sql.begin((tx) =>
      linkSecurityAsset(tx, {
        assetId: duplicate!.id,
        isin: "NL0000235190",
        name: "Airbus reimported",
        assetType: "equity",
      }),
    );
    expect(
      await db.sql`SELECT id FROM market_data_jobs WHERE security_id=${securityId} AND job_type='resolve' AND status IN ('queued','running')`,
    ).toHaveLength(0);
    expect(
      await db.sql`SELECT DISTINCT security_id FROM assets WHERE id IN (${asset!.id},${duplicate!.id})`,
    ).toEqual([{ securityId }]);
    expect(searches).toBe(1);
    detail = await service.detail(securityId!);
    expect(detail).toMatchObject({
      preferredMappingId: mappingId,
      selectionLocked: true,
    });
    detail = await service.select(securityId!, null, detail.revision);
    expect(detail).toMatchObject({
      preferredMappingId: mappingId,
      selectionLocked: false,
    });
    await db.sql`
      INSERT INTO market_data_jobs(security_id,job_type)
      VALUES(${securityId},'resolve')`;
    const restarted = new MarketDataService(db, cache(), config, {
      eodhd,
      openFigi,
    });
    expect(await restarted.runDue()).toBe(1);
    expect(searches).toBe(1);
    expect(figiBatches).toBe(1);

    await db.sql`
      UPDATE security_listings SET active=false
      WHERE security_id=${securityId}`;
    detail = await service.detail(securityId!);
    expect(detail.mappings.every((mapping) => !mapping.selectable)).toBe(true);
    const verificationRevision = detail.verificationRevision as number;
    detail = await service.reResolve(securityId!, detail.revision);
    expect(detail.verificationRevision).toBe(verificationRevision + 1);
    expect(await service.runDue()).toBe(1);
    detail = await service.detail(securityId!);
    expect(searches).toBe(2);
    expect(detail.mappings.some((mapping) => mapping.selectable)).toBe(true);

    let position = (await new PortfolioService(db).positions(account!.id)).get(
      account!.id,
    )?.[0];
    expect(position?.marketValue).toBe("202.000000000000000000");
    await db.sql`
      INSERT INTO market_data_state(security_id,stage,status,error_class,metadata)
      VALUES(${securityId},'history','history_partial','corporate_action_review',
        ${db.sql.json({ corporateActionDate: bars[0]!.date })})
      ON CONFLICT(security_id,stage) DO UPDATE SET
        status=excluded.status,error_class=excluded.error_class,metadata=excluded.metadata`;
    position = (await new PortfolioService(db).positions(account!.id)).get(
      account!.id,
    )?.[0];
    expect(position?.marketValue).toBeUndefined();
    expect(position?.unpricedReason).toContain("corporate action");

    failDaily = true;
    await db.sql`
      UPDATE market_data_jobs SET next_attempt_at=now(),status='completed'
      WHERE security_id=${securityId} AND status='queued'`;
    await service.refresh(securityId!);
    await service.runDue(4);
    detail = await service.detail(securityId!);
    expect(detail.latestPrice).toMatchObject({
      close: "101.000000000000000000",
      timePrecision: "date",
    });
    expect(detail.selectionLocked).toBe(false);
    expect(dailyRequests).toBe(2);
    expect(searches).toBe(2);
  });

  it("uses ID mapping only after an empty exact search and performs one enrichment search", async () => {
    let searches = 0;
    let mappings = 0;
    const enriched: string[] = [];
    const eodhd = {
      async searchIsin() {
        searches++;
        return [];
      },
      async mapIsin() {
        mappings++;
        return ["AAA.F", "EXH1.XETRA", "EXH1.MU"];
      },
      async searchExact(symbol: string, isin: string) {
        enriched.push(symbol);
        return [
          {
            providerSymbol: symbol,
            ticker: "EXH1",
            exchange: "XETRA",
            name: "iShares STOXX Europe 600 Oil & Gas UCITS ETF (DE)",
            type: "ETF",
            currency: "EUR",
            isin,
            isPrimary: true,
          },
        ];
      },
    } as unknown as EODHDClient;
    const openFigi = {
      async mapIsins(isins: string[]) {
        return new Map(
          isins.map((isin) => [isin, [{ ticker: "EXH1", figi: "BBG-EXH1" }]]),
        );
      },
    } as unknown as OpenFigiClient;
    const config = readConfig({
      ...process.env,
      DATABASE_URL: url!,
      REDIS_URL: "redis://127.0.0.1:6379",
      LOG_LEVEL: "silent",
    });
    const service = new MarketDataService(db, cache(), config, {
      eodhd,
      openFigi,
    });
    const [asset] = await db.sql<{ id: string }[]>`
      INSERT INTO assets(asset_type,symbol,name,quote_currency,external_ids)
      VALUES('etf','EXH1','Oil & Gas ETF','EUR',${db.sql.json({ isin: "DE000A0H08M3" })}) RETURNING id`;
    const securityId = await db.sql.begin((tx) =>
      linkSecurityAsset(tx, {
        assetId: asset!.id,
        isin: "DE000A0H08M3",
        name: "Oil & Gas ETF",
        assetType: "etf",
      }),
    );

    expect(await service.runDue()).toBe(1);
    expect(searches).toBe(1);
    expect(mappings).toBe(1);
    expect(enriched).toEqual(["EXH1.MU"]);
    expect((await service.detail(securityId!)).mappings).toEqual([
      expect.objectContaining({
        providerSymbol: "EXH1.MU",
        verificationStatus: "verified",
        selectable: true,
      }),
    ]);
  });

  it("defers quota-blocked discovery until after midnight GMT without repeated execution", async () => {
    let searches = 0;
    const retryAt = new Date();
    retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    retryAt.setUTCHours(0, 0, 5, 0);
    const eodhd = {
      async searchIsin() {
        searches++;
        throw new MarketProviderError(
          "quota_exhausted",
          "EODHD request capacity was reached.",
          "429",
          retryAt,
        );
      },
    } as unknown as EODHDClient;
    const openFigi = {
      async mapIsins(isins: string[]) {
        return new Map(isins.map((isin) => [isin, []]));
      },
    } as unknown as OpenFigiClient;
    const config = readConfig({
      ...process.env,
      DATABASE_URL: url!,
      REDIS_URL: "redis://127.0.0.1:6379",
      LOG_LEVEL: "silent",
    });
    const service = new MarketDataService(db, cache(), config, {
      eodhd,
      openFigi,
    });
    const [asset] = await db.sql<{ id: string }[]>`
      INSERT INTO assets(asset_type,symbol,name,quote_currency,external_ids)
      VALUES('etf','EXH1','Oil & Gas ETF','EUR',${db.sql.json({ isin: "DE000A0H08M3" })}) RETURNING id`;
    const securityId = await db.sql.begin((tx) =>
      linkSecurityAsset(tx, {
        assetId: asset!.id,
        isin: "DE000A0H08M3",
        name: "Oil & Gas ETF",
        assetType: "etf",
      }),
    );

    expect(await service.runDue()).toBe(1);
    expect(await service.runDue()).toBe(0);
    expect(searches).toBe(1);
    const [job] = await db.sql<
      { status: string; nextAttemptAt: Date; attempts: number }[]
    >`SELECT status,next_attempt_at,attempts FROM market_data_jobs WHERE security_id=${securityId}`;
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    expect(job!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      retryAt.getTime(),
    );
    expect(await service.detail(securityId!)).toMatchObject({
      resolutionReason: "verification_quota_delayed",
      nextRetryAt: retryAt,
    });
  });

  it("shares configured and upstream EODHD quota blocks durably", async () => {
    const config = readConfig({
      ...process.env,
      DATABASE_URL: url!,
      REDIS_URL: "redis://127.0.0.1:6379",
      EODHD_API_TOKEN: "fixture",
      EODHD_DAILY_LIMIT: "1",
      LOG_LEVEL: "silent",
    });
    const gate = new EODHDQuotaCoordinator(db, cache(), config);
    let requests = 0;
    const client = new EODHDClient(gate, config, async () => {
      requests++;
      return Response.json([]);
    });
    await client.searchIsin("DE000A0H08M3");
    await expect(client.searchIsin("DE000A0H08M3")).rejects.toMatchObject({
      failure: "quota_exhausted",
    });
    expect(requests).toBe(1);
    expect(await gate.blockedUntil()).toBeInstanceOf(Date);

    await db.sql`TRUNCATE provider_call_budgets`;
    const upstreamGate = new EODHDQuotaCoordinator(db, cache(), {
      ...config,
      EODHD_DAILY_LIMIT: 20,
    });
    const upstream = new EODHDClient(upstreamGate, config, async () => {
      requests++;
      return new Response("API calls limit for the day exceeded", {
        status: 429,
      });
    });
    await expect(upstream.searchIsin("DE000A0H08M3")).rejects.toMatchObject({
      failure: "quota_exhausted",
    });
    await expect(upstream.searchIsin("DE000A0H08M3")).rejects.toMatchObject({
      failure: "quota_exhausted",
    });
    expect(requests).toBe(2);
  });
});

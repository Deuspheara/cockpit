import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Cache } from "../src/shared/cache.js";
import { connectDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { readConfig } from "../src/config.js";
import {
  EODHDClient,
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
    await db.sql`TRUNCATE accounts,assets CASCADE`;
  });

  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets CASCADE`;
    await db.close();
  });

  it("queues without provider I/O, preserves a revision-locked selection, and retains its last good close", async () => {
    let searches = 0;
    let failDaily = false;
    let mappingGate: Promise<void> | null = null;
    let mappingStarted: (() => void) | null = null;
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
        if (mappingGate) {
          mappingStarted?.();
          await mappingGate;
        }
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
        return [];
      },
      async daily() {
        if (failDaily)
          throw new MarketProviderError(
            "provider_unavailable",
            "EODHD is temporarily unavailable.",
          );
        return bars;
      },
    } as unknown as EODHDClient;
    const openFigi = {
      async mapIsin() {
        return [];
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
    expect(searches).toBe(0);

    expect(await service.runDue()).toBe(1);
    expect(searches).toBe(1);
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

    await service.select(securityId!, null, detail.revision);
    detail = await service.detail(securityId!);
    const started = new Promise<void>((resolve) => {
      mappingStarted = resolve;
    });
    let releaseMapping!: () => void;
    mappingGate = new Promise<void>((resolve) => {
      releaseMapping = resolve;
    });
    const resolving = service.runDue();
    await started;
    await service.select(securityId!, mappingId, detail.revision);
    releaseMapping();
    await resolving;
    mappingGate = null;
    mappingStarted = null;
    detail = await service.detail(securityId!);
    expect(detail).toMatchObject({
      preferredMappingId: mappingId,
      selectionLocked: true,
    });

    await db.sql.begin((tx) =>
      linkSecurityAsset(tx, {
        assetId: asset!.id,
        isin: "NL0000235190",
        name: "Airbus reimported",
        assetType: "equity",
      }),
    );
    await service.runDue();
    detail = await service.detail(securityId!);
    expect(detail).toMatchObject({
      preferredMappingId: mappingId,
      selectionLocked: true,
    });

    await service.runDue(4);
    detail = await service.detail(securityId!);
    expect(detail.latestPrice).toMatchObject({
      close: "101.000000000000000000",
      timePrecision: "date",
    });
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
    expect(detail.selectionLocked).toBe(true);
  });
});

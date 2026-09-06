import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { connectDatabase } from "../src/db/index.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("market-data migration from 0013", () => {
  it("links legacy duplicate ISIN assets to one security and seeds one resolve job", async () => {
    if (!url?.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    const db = connectDatabase(url);
    const namespace = `market_${randomUUID().replaceAll("-", "")}`;
    const directory = new URL("../migrations/", import.meta.url);
    try {
      await db.sql.begin(async (tx) => {
        await tx.unsafe(`CREATE SCHEMA ${namespace}`);
        await tx.unsafe(`SET LOCAL search_path TO ${namespace},public`);
        const migrations = (await readdir(directory))
          .filter((name) => name.endsWith(".sql") && name < "0014")
          .sort();
        for (const name of migrations)
          await tx.unsafe(await readFile(new URL(name, directory), "utf8"));

        const [account] = await tx<{ id: string }[]>`
          INSERT INTO accounts(name,asset_class,source_type,base_currency)
          VALUES('Legacy PEA','equities','manual','EUR') RETURNING id`;
        const [oldest] = await tx<{ id: string }[]>`
          INSERT INTO assets(asset_type,symbol,name,quote_currency,external_ids,created_at)
          VALUES('equity','AIR','Airbus','EUR',${tx.json({ isin: "NL0000235190" })},'2025-01-01') RETURNING id`;
        const [duplicate] = await tx<{ id: string }[]>`
          INSERT INTO assets(asset_type,symbol,name,quote_currency,external_ids,created_at)
          VALUES('equity','AIR','Airbus legacy USD','USD',${tx.json({ isin: "nl0000235190" })},'2026-01-01') RETURNING id`;
        await tx`
          INSERT INTO transactions(account_id,asset_id,type,occurred_at,quantity,unit_price,currency,source,external_id)
          VALUES(${account!.id},${duplicate!.id},'BUY','2026-01-02',1,100,'EUR','manual','legacy-held')`;

        await tx.unsafe(
          await readFile(
            new URL("0014_market_data_pipeline.sql", directory),
            "utf8",
          ),
        );

        const securities = await tx<
          { id: string; isin: string; primaryAssetId: string }[]
        >`SELECT id,isin,primary_asset_id FROM securities`;
        expect(securities).toHaveLength(1);
        expect(securities[0]).toMatchObject({
          isin: "NL0000235190",
          primaryAssetId: oldest!.id,
        });
        const assets = await tx<{ id: string; securityId: string }[]>`
          SELECT id,security_id FROM assets ORDER BY created_at`;
        expect(assets.map((asset) => asset.securityId)).toEqual([
          securities[0]!.id,
          securities[0]!.id,
        ]);
        const jobs = await tx`
          SELECT security_id,job_type,status FROM market_data_jobs`;
        expect(jobs).toEqual([
          {
            securityId: securities[0]!.id,
            jobType: "resolve",
            status: "queued",
          },
        ]);
        const [listing] = await tx<{ id: string }[]>`
          INSERT INTO security_listings(security_id,ticker,name,quote_currency)
          VALUES(${securities[0]!.id},'AIR','Airbus','EUR') RETURNING id`;
        await tx`
          INSERT INTO provider_mappings(
            listing_id,provider,provider_symbol,verification_status,verified_at
          ) VALUES(${listing!.id},'eodhd','AIR.PA','verified',now())`;
        await tx.unsafe(
          await readFile(
            new URL("0015_eodhd_quota_resolution.sql", directory),
            "utf8",
          ),
        );
        expect(
          await tx`
            SELECT s.verification_revision AS security_revision,
              m.verification_revision AS mapping_revision
            FROM securities s JOIN security_listings l ON l.security_id=s.id
            JOIN provider_mappings m ON m.listing_id=l.id`,
        ).toEqual([{ securityRevision: 1, mappingRevision: 1 }]);
        await tx.unsafe(`DROP SCHEMA ${namespace} CASCADE`);
      });
    } finally {
      await db.close();
    }
  });
});

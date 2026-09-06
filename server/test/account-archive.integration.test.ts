import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { AccountService } from "../src/modules/accounts/service.js";
import { AssetService } from "../src/modules/assets/service.js";
import { ChangeSetService } from "../src/modules/changes/service.js";
import { ActivityService } from "../src/modules/activity/service.js";
import { LedgerService } from "../src/modules/ledger/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
import { SyncService } from "../src/modules/integrations/service.js";
import { readConfig } from "../src/config.js";
import type { Cache } from "../src/shared/cache.js";
import type { ProviderSyncResult } from "../src/modules/integrations/types.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("account removal and manual deletion", () => {
  let db: ReturnType<typeof connectDatabase>;
  let accounts: AccountService;
  let changes: ChangeSetService;
  let assetId: string;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    accounts = new AccountService(db);
    changes = new ChangeSetService(db);
    assetId = (
      await new AssetService(db).create({
        symbol: "ARCH",
        name: "Archive test",
        assetType: "equity",
        quoteCurrency: "EUR",
      })
    ).id;
  });
  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets CASCADE`;
    await db.close();
  });
  const manual = () =>
    accounts.create({
      name: "Trade Republic",
      assetClass: "equities",
      sourceType: "manual",
      institution: "Trade Republic",
    });
  it("voids a manual transaction, recalculates holdings, retains its audited record", async () => {
    const a = await manual();
    const proposal = await changes.proposeTransaction({
      accountId: a.id,
      assetId,
      type: "BUY",
      quantity: "2",
      unitPrice: "10",
      currency: "EUR",
      occurredAt: new Date().toISOString(),
    });
    await changes.apply(proposal.id);
    const [transaction] = await new LedgerService(db).list(a.id);
    expect(
      (await new PortfolioService(db).positions(a.id))
        .get(a.id)
        ?.some((p) => p.assetId === assetId),
    ).toBe(true);
    const deletion = await changes.proposeTransactionEdit(
      transaction!.id,
      null,
    );
    await changes.apply(deletion.id);
    await changes.apply(deletion.id);
    expect(await new LedgerService(db).list(a.id)).toEqual([]);
    expect(
      (await new ActivityService(db).list({ accountId: a.id })).some(
        (e) => e.id === transaction!.id,
      ),
    ).toBe(false);
    expect((await new LedgerService(db).get(transaction!.id)).isVoided).toBe(
      true,
    );
    expect(
      (await new PortfolioService(db).positions(a.id))
        .get(a.id)
        ?.some((p) => p.assetId === assetId),
    ).toBe(false);
  });
  it("allows deleting manually imported CSV activity while retaining its deduplication key", async () => {
    const a = await manual();
    const [row] =
      await db.sql`INSERT INTO transactions(account_id,asset_id,type,occurred_at,quantity,unit_price,currency,source,provider,external_id) VALUES(${a.id},${assetId},'BUY',now(),1,10,'EUR','manual','trade_republic','csv-delete-test') RETURNING id`;
    const deletion = await changes.proposeTransactionEdit(
      String(row!.id),
      null,
    );
    await changes.apply(deletion.id);
    const [saved] =
      await db.sql`SELECT is_voided,external_id FROM transactions WHERE id=${String(row!.id)}`;
    expect(saved!.isVoided).toBe(true);
    expect(saved!.externalId).toBe("csv-delete-test");
  });
  it("archives idempotently, excludes history and rejects drafts created before removal", async () => {
    const a = await manual();
    const draft = await changes.proposeObservation({
      accountId: a.id,
      assetId,
      quantity: "3",
      unitPrice: "10",
      currency: "EUR",
      observedAt: new Date().toISOString(),
    });
    await accounts.archive(a.id);
    await accounts.archive(a.id);
    expect((await accounts.list()).some((row) => row.id === a.id)).toBe(false);
    expect(
      (await new PortfolioService(db).dashboard("global", "1m")).accounts.some(
        (row) => row.id === a.id,
      ),
    ).toBe(false);
    expect(await new ActivityService(db).list({ accountId: a.id })).toEqual([]);
    await expect(changes.apply(draft.id)).rejects.toThrow();
    const audit =
      await db.sql`SELECT id FROM audit_log WHERE entity_id=${a.id} AND action='archive'`;
    expect(audit).toHaveLength(1);
    await expect(
      db.sql`INSERT INTO evm_account_history(account_id,at,value,complete,coverage) VALUES(${a.id},now(),1,true,'{}')`,
    ).rejects.toThrow("Account removed");
    await expect(
      db.sql`INSERT INTO sync_runs(account_id,provider,status) VALUES(${a.id},'dydx','queued')`,
    ).rejects.toThrow("Account removed");
  });
  it("discards provider results that arrive after removal and keeps connected transactions read-only", async () => {
    const a = await accounts.create({
      name: "Trading",
      assetClass: "crypto",
      sourceType: "dydx",
      externalAddress: "dydx1" + "q".repeat(38),
    });
    const [connectedTransaction] =
      await db.sql`INSERT INTO transactions(account_id,asset_id,type,occurred_at,quantity,currency,source,external_id) VALUES(${a.id},${assetId},'BUY',now(),1,'EUR','dydx','read-only-test') RETURNING id`;
    await expect(
      changes.proposeTransactionEdit(String(connectedTransaction!.id), null),
    ).rejects.toThrow("manual account");
    let resolve!: (value: ProviderSyncResult) => void;
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const response = new Promise<ProviderSyncResult>((r) => (resolve = r));
    const cache = { incr: vi.fn(async () => 1) } as unknown as Cache;
    const config = readConfig({
      DATABASE_URL: url!,
      REDIS_URL: "redis://localhost",
    });
    const sync = new SyncService(db, cache, config, {
      dydx: {
        kind: "dydx",
        async syncAccount() {
          started();
          return response;
        },
      },
    });
    const pending = sync.sync(a.id);
    const rejected = expect(pending).rejects.toThrow();
    await ready;
    await accounts.archive(a.id);
    resolve({
      positions: [
        {
          asset: {
            key: "archive:cash",
            symbol: "USD",
            name: "Dollar",
            assetType: "cash",
          },
          scope: "account",
          quantity: "10",
          marketValue: "10",
          currency: "USD",
        },
      ],
      transactions: [],
      warnings: [],
      coveredScopes: ["account"],
      cursor: {},
    });
    await rejected;
    expect(
      await db.sql`SELECT id FROM holding_observations WHERE account_id=${a.id}`,
    ).toHaveLength(0);
    await expect(sync.enqueue(a.id)).rejects.toThrow();
    await expect(
      changes.proposeTransaction({
        accountId: a.id,
        assetId,
        type: "BUY",
        quantity: "1",
        currency: "EUR",
        occurredAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
  });
});

import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { AccountService } from "../src/modules/accounts/service.js";
import { AssetService } from "../src/modules/assets/service.js";
import { ChangeSetService } from "../src/modules/changes/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
import { RecurringService } from "../src/modules/recurring/service.js";
import { ReconciliationService } from "../src/modules/reconciliation/service.js";
import { SnapshotService } from "../src/modules/snapshots/service.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("real PostgreSQL finance behavior", () => {
  let db: ReturnType<typeof connectDatabase>,
    changes: ChangeSetService,
    portfolio: PortfolioService,
    recurring: RecurringService;
  let accountId: string, assetId: string, cashId: string;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    changes = new ChangeSetService(db);
    portfolio = new PortfolioService(db);
    recurring = new RecurringService(db);
    accountId = (
      await new AccountService(db).create({
        name: "Test PEA",
        assetClass: "equities",
        sourceType: "manual",
      })
    ).id;
    assetId = (
      await new AssetService(db).create({
        symbol: "CW8",
        name: "Test ETF",
        assetType: "etf",
        quoteCurrency: "EUR",
      })
    ).id;
    cashId = (
      await new AssetService(db).create({
        symbol: "EUR",
        name: "Euro",
        assetType: "cash",
        quoteCurrency: "EUR",
      })
    ).id;
  });
  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets CASCADE`;
    await db.close();
  });
  it("applies observed holdings atomically without invented transactions and supports idempotent apply/undo", async () => {
    const draft = await changes.proposeObservation({
      accountId,
      assetId,
      observedAt: "2026-08-31T00:00:00Z",
      quantity: "18.23",
      marketValue: "9483",
      currency: "EUR",
    });
    expect((await portfolio.positions(accountId)).get(accountId)).toEqual([]);
    await changes.apply(draft.id);
    await changes.apply(draft.id);
    const positions = (await portfolio.positions(accountId)).get(accountId)!;
    expect(positions[0]?.marketValue).toBe("9483.000000000000000000");
    expect(positions[0]?.costBasis).toBeUndefined();
    expect(
      await db.sql`SELECT id FROM transactions WHERE account_id=${accountId}`,
    ).toHaveLength(0);
    await changes.apply(draft.id, true);
    await changes.apply(draft.id, true);
    expect((await portfolio.positions(accountId)).get(accountId)).toEqual([]);
  });
  it("settles explicit cash balances and computes exact account valuation", async () => {
    const deposit = await changes.proposeTransaction({
      accountId,
      assetId: cashId,
      type: "DEPOSIT",
      occurredAt: "2026-01-01T00:00:00Z",
      quantity: "10000",
      currency: "EUR",
    });
    await changes.apply(deposit.id);
    const buy = await changes.proposeTransaction({
      accountId,
      assetId,
      type: "BUY",
      occurredAt: "2026-01-02T00:00:00Z",
      quantity: "18.23",
      unitPrice: "500",
      feeAmount: "1",
      currency: "EUR",
    });
    await changes.apply(buy.id);
    await db.sql`INSERT INTO price_quotes(asset_id,quoted_at,price,currency,source) VALUES(${assetId},now(),'520','EUR','manual')`;
    const positions = (await portfolio.positions(accountId)).get(accountId)!;
    expect(positions.find((p) => p.assetId === cashId)?.quantity).toBe(
      "884.000000000000000000",
    );
    expect(positions.find((p) => p.assetId === assetId)?.costBasis).toBe(
      "9116.000000000000000000",
    );
    const dashboard = await portfolio.dashboard(
      "global",
      "1m",
      "EUR",
      accountId,
    );
    expect(dashboard.value).toBe("10363.600000000000000000");
    expect(dashboard.complete).toBe(true);
    expect((await new SnapshotService(db, portfolio).capture()).captured).toBe(
      true,
    );
  });
  it("rejects stale edits without partially committing", async () => {
    const [transaction] =
      await db.sql`SELECT * FROM transactions WHERE account_id=${accountId} AND type='BUY'`;
    const first = await changes.proposeTransactionEdit(
      String(transaction!.id),
      null,
    );
    const stale = await changes.proposeTransactionEdit(
      String(transaction!.id),
      null,
    );
    await changes.apply(first.id);
    await expect(changes.apply(stale.id)).rejects.toThrow("Data changed");
    expect((await changes.get(stale.id)).status).toBe("draft");
    await changes.apply(first.id, true);
  });
  it("reconciles observations against the ledger without overwriting quantity", async () => {
    const draft = await changes.proposeObservation({
      accountId,
      assetId,
      observedAt: "2026-08-31T00:00:00Z",
      quantity: "16.23",
      currency: "EUR",
    });
    await changes.apply(draft.id);
    const result = await new ReconciliationService(db).run(accountId);
    expect(result[0]?.deltaQuantity).toBe("-2.000000000000000000");
    expect(
      (await portfolio.positions(accountId))
        .get(accountId)
        ?.find((p) => p.assetId === assetId)?.quantity,
    ).toBe("18.230000000000000000");
  });
  it("versions a rule from June and previews historical posted events before voiding", async () => {
    const input = {
      accountId,
      assetId,
      transactionType: "BUY",
      inputMode: "quantity",
      quantity: "1",
      currency: "EUR",
      cadence: "monthly",
      startOn: "2026-01-01",
      autoPost: true,
    };
    const draft = await changes.proposeRule(input);
    await changes.apply(draft.id);
    const ruleId = draft.operations[0]!.id;
    await recurring.materialize("2026-08-01");
    expect(
      await db.sql`SELECT id FROM recurring_occurrences WHERE rule_id=${ruleId}`,
    ).toHaveLength(8);
    const split = await changes.proposeRuleChange(ruleId, "2026-06-01", {
      ...input,
      quantity: "2",
      startOn: "2026-06-01",
    });
    expect(
      split.operations.filter((o) => o.table === "transactions"),
    ).toHaveLength(3);
    await changes.apply(split.id);
    const old = await recurring.get(ruleId);
    expect(String(old.endOn).slice(0, 10)).toBe("2026-05-31");
    const newId = split.operations.find(
      (o) => o.table === "recurring_rules" && o.before === null,
    )!.id;
    expect((await recurring.get(newId)).seriesId).toBe(old.seriesId);
    expect(
      await db.sql`SELECT id FROM transactions WHERE recurrence_occurrence_id IN (SELECT id FROM recurring_occurrences WHERE rule_id=${ruleId}) AND is_voided`,
    ).toHaveLength(3);
    await changes.apply(split.id, true);
    expect((await recurring.get(ruleId)).endOn).toBeNull();
  });
  it("skip voids a generated transaction; detach preserves it; both undo", async () => {
    const [occurrence] =
      await db.sql`SELECT * FROM recurring_occurrences WHERE status='posted' ORDER BY due_at LIMIT 1`;
    const skipped = await changes.proposeOccurrence(
      String(occurrence!.id),
      "skipped",
    );
    await changes.apply(skipped.id);
    expect(
      (
        await db.sql`SELECT is_voided FROM transactions WHERE id=${String(occurrence!.transactionId)}`
      )[0]?.isVoided,
    ).toBe(true);
    await changes.apply(skipped.id, true);
    const detached = await changes.proposeOccurrence(
      String(occurrence!.id),
      "detached",
    );
    await changes.apply(detached.id);
    expect(
      (
        await db.sql`SELECT is_voided FROM transactions WHERE id=${String(occurrence!.transactionId)}`
      )[0]?.isVoided,
    ).toBe(false);
    await changes.apply(detached.id, true);
  });
  it("confirms an actual quantity for a cash-budget occurrence and previews its effects", async () => {
    const draft = await changes.proposeRule({
      accountId,
      assetId,
      transactionType: "BUY",
      inputMode: "cash_amount",
      cashAmount: "500",
      currency: "EUR",
      cadence: "monthly",
      startOn: "2026-08-01",
    });
    await changes.apply(draft.id);
    const ruleId = draft.operations[0]!.id;
    await recurring.materialize("2026-08-01");
    const [occurrence] =
      await db.sql`SELECT * FROM recurring_occurrences WHERE rule_id=${ruleId}`;
    expect(occurrence?.status).toBe("planned");
    const proposal = await changes.proposePostOccurrence(
      String(occurrence!.id),
      {
        accountId,
        assetId,
        type: "BUY",
        quantity: "0.9",
        unitPrice: "500",
        currency: "EUR",
        occurredAt: "2026-08-01T00:00:00Z",
      },
    );
    expect(proposal.effects.ledgerQuantityChanges[0]?.deltaQuantity).toBe(
      "0.900000000000000000",
    );
    expect(proposal.labels[assetId]).toContain("CW8");
    await changes.apply(proposal.id);
    expect(
      (
        await db.sql`SELECT * FROM recurring_occurrences WHERE id=${String(occurrence!.id)}`
      )[0]?.status,
    ).toBe("posted");
    await changes.apply(proposal.id, true);
    expect(
      (
        await db.sql`SELECT * FROM recurring_occurrences WHERE id=${String(occurrence!.id)}`
      )[0]?.status,
    ).toBe("planned");
  });
  it("stopping before a later rule version also previews and disables that version", async () => {
    const input = {
      accountId,
      assetId,
      transactionType: "BUY",
      inputMode: "cash_amount",
      cashAmount: "500",
      currency: "EUR",
      cadence: "monthly",
      startOn: "2026-01-01",
    };
    const draft = await changes.proposeRule(input);
    await changes.apply(draft.id);
    const firstId = draft.operations[0]!.id;
    const split = await changes.proposeRuleChange(firstId, "2026-06-01", {
      ...input,
      cashAmount: "700",
      startOn: "2026-06-01",
    });
    await changes.apply(split.id);
    const laterId = split.operations.find(
      (o) => o.table === "recurring_rules" && o.before === null,
    )!.id;
    const stop = await changes.proposeRuleChange(firstId, "2026-04-01", null);
    expect(
      stop.operations.some(
        (o) => o.id === laterId && o.after?.enabled === false,
      ),
    ).toBe(true);
    await changes.apply(stop.id);
    expect((await recurring.get(laterId)).enabled).toBe(false);
    await changes.apply(stop.id, true);
    expect((await recurring.get(laterId)).enabled).toBe(true);
  });
});

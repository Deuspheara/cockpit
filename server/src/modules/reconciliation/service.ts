import type { Sql, TransactionSql } from "postgres";
import {
  ledgerQuantity,
  reconciliationDelta,
} from "../portfolio/projection.js";
import type { Transaction } from "../ledger/schemas.js";
export class ReconciliationService {
  constructor(private database: { sql: Sql | TransactionSql }) {}
  async run(accountId: string) {
    const transactions = await this.database.sql<
      Transaction[]
    >`SELECT * FROM transactions WHERE account_id=${accountId} AND NOT is_voided`;
    const observations = await this.database
      .sql`SELECT DISTINCT ON(o.asset_id) o.*,a.asset_type FROM holding_observations o JOIN assets a ON a.id=o.asset_id WHERE account_id=${accountId} ORDER BY asset_id,observed_at DESC,created_at DESC`;
    await this.database
      .sql`UPDATE reconciliation_items SET status='resolved',updated_at=now() WHERE account_id=${accountId} AND status='open' AND NOT EXISTS(SELECT 1 FROM holding_observations o WHERE o.account_id=${accountId} AND o.asset_id=reconciliation_items.asset_id)`;
    for (const o of observations) {
      const ledger = transactions.filter(
        (t) =>
          t.assetId === o.assetId &&
          new Date(t.occurredAt) <= new Date(String(o.observedAt)),
      );
      if (!ledger.length) continue;
      const expected = ledgerQuantity(ledger),
        delta = reconciliationDelta(
          expected,
          String(o.quantity),
          String(o.assetType),
        );
      if (delta === null) {
        await this.database
          .sql`UPDATE reconciliation_items SET status='resolved',updated_at=now() WHERE account_id=${accountId} AND asset_id=${String(o.assetId)} AND status='open'`;
        continue;
      }
      await this.database
        .sql`INSERT INTO reconciliation_items(account_id,asset_id,expected_quantity,observed_quantity,delta_quantity)
    VALUES(${accountId},${String(o.assetId)},${expected},${String(o.quantity)},${delta})
    ON CONFLICT(account_id,asset_id) WHERE status='open' DO UPDATE SET expected_quantity=excluded.expected_quantity,observed_quantity=excluded.observed_quantity,delta_quantity=excluded.delta_quantity,updated_at=now()`;
    }
    return this.list(accountId);
  }
  async list(accountId?: string) {
    return accountId
      ? this.database
          .sql`SELECT * FROM reconciliation_items WHERE account_id=${accountId} ORDER BY created_at DESC`
      : this.database
          .sql`SELECT * FROM reconciliation_items ORDER BY created_at DESC LIMIT 500`;
  }
}

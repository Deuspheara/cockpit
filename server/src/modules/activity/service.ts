import { AccountService } from "../accounts/service.js";
import type { Database } from "../../db/index.js";
export class ActivityService {
  constructor(private database: Database) {}
  async list(filters: {
    accountId?: string;
    assetClass?: string;
    source?: string;
  }) {
    const accounts = await new AccountService(this.database).list();
    if (!accounts.length) return [];
    const rows = await this.database.sql`
   SELECT * FROM (
    SELECT t.id,t.account_id,a.name AS account_name,a.asset_class::text,t.source,t.type::text AS kind,t.occurred_at AS at,
      t.quantity::text,t.currency,s.symbol,t.is_voided,(a.source_type='manual') AS editable,t.id AS transaction_id
      FROM transactions t JOIN accounts a ON a.id=t.account_id JOIN assets s ON s.id=t.asset_id
    UNION ALL
    SELECT o.id,r.account_id,a.name,a.asset_class::text,'recurring_rule','RECURRING_'||upper(o.status),o.due_at,
      r.quantity::text,r.currency,s.symbol,false,false,NULL::uuid
      FROM recurring_occurrences o JOIN recurring_rules r ON r.id=o.rule_id JOIN accounts a ON a.id=r.account_id LEFT JOIN assets s ON s.id=r.asset_id
      WHERE o.status<>'posted'
    UNION ALL
    SELECT h.id,h.account_id,a.name,a.asset_class::text,h.source,'OBSERVATION',h.observed_at,h.quantity::text,h.currency,s.symbol,false,false,NULL::uuid
      FROM holding_observations h JOIN accounts a ON a.id=h.account_id JOIN assets s ON s.id=h.asset_id WHERE a.source_type='manual'
    UNION ALL
    SELECT r.id,r.account_id,a.name,a.asset_class::text,'reconciliation','RECONCILIATION_'||upper(r.status),r.updated_at,r.delta_quantity::text,a.base_currency,s.symbol,false,false,NULL::uuid
      FROM reconciliation_items r JOIN accounts a ON a.id=r.account_id JOIN assets s ON s.id=r.asset_id
   ) events
   WHERE account_id IN ${this.database.sql(accounts.map((a) => a.id))}
     AND (${filters.accountId ?? null}::uuid IS NULL OR account_id=${filters.accountId ?? null}::uuid)
     AND (${filters.assetClass ?? null}::text IS NULL OR asset_class=${filters.assetClass ?? null})
     AND (${filters.source ?? null}::text IS NULL OR source=${filters.source ?? null})
   ORDER BY at DESC,id LIMIT 500`;
    return rows;
  }
}

import { randomUUID } from "node:crypto";
import type { Database } from "../../db/index.js";
import { NotFoundError } from "../../shared/errors.js";
import { dueDates } from "./calendar.js";
import type { Rule } from "./schemas.js";
export class RecurringService {
  constructor(private database: Database) {}
  async list() {
    return this.database.sql<
      Rule[]
    >`SELECT * FROM recurring_rules ORDER BY start_on,id`;
  }
  async get(id: string) {
    const [r] = await this.database.sql<
      Rule[]
    >`SELECT * FROM recurring_rules WHERE id=${id}`;
    if (!r) throw new NotFoundError();
    return r;
  }
  async occurrences(ruleId: string) {
    await this.materialize(
      new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
    );
    return this.database
      .sql`SELECT * FROM recurring_occurrences WHERE rule_id=${ruleId} ORDER BY due_at`;
  }
  async materialize(through: string) {
    await this.database.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(64023002)`;
      const rules = await tx<
        Rule[]
      >`SELECT r.* FROM recurring_rules r JOIN accounts a ON a.id=r.account_id WHERE r.enabled AND NOT a.is_archived AND a.source_type='manual'`;
      for (const rule of rules) {
        const normalized = {
          ...rule,
          startOn: String(rule.startOn).slice(0, 10),
          endOn: rule.endOn ? String(rule.endOn).slice(0, 10) : null,
        };
        for (const due of dueDates(normalized, through)) {
          await tx`INSERT INTO recurring_occurrences(rule_id,due_at) VALUES(${rule.id},${due}) ON CONFLICT(rule_id,due_at) DO NOTHING`;
          if (
            !rule.autoPost ||
            rule.inputMode !== "quantity" ||
            due > new Date().toISOString()
          )
            continue;
          const [occurrence] =
            await tx`SELECT * FROM recurring_occurrences WHERE rule_id=${rule.id} AND due_at=${due} FOR UPDATE`;
          if (!occurrence || occurrence.status !== "planned") continue;
          const id = randomUUID();
          await tx`INSERT INTO transactions(id,account_id,asset_id,type,occurred_at,quantity,currency,source,recurrence_occurrence_id)
      VALUES(${id},${rule.accountId},${rule.assetId},${rule.transactionType},${due},${rule.quantity!},${rule.currency},'recurring_rule',${String(occurrence.id)})`;
          await tx`UPDATE recurring_occurrences SET status='posted',transaction_id=${id},updated_at=now() WHERE id=${String(occurrence.id)}`;
          await tx`INSERT INTO audit_log(actor,action,entity_type,entity_id,after) VALUES('system','auto_post','transaction',${id},${tx.json({ ruleId: rule.id, quantity: rule.quantity! })})`;
        }
      }
    });
  }
}

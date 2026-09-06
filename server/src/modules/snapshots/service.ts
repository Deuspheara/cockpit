import type { Database } from "../../db/index.js";
import { PortfolioService } from "../portfolio/service.js";
export class SnapshotService {
  constructor(
    private database: Database,
    _portfolio: PortfolioService,
  ) {}
  async capture(currency = "EUR", capturedAt = new Date()) {
    return this.database.sql.begin(
      "isolation level repeatable read",
      async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(64023002)`;
        const dashboard = await new PortfolioService({ sql: tx }).dashboard(
          "global",
          "1d",
          currency,
        );
        const eligible = dashboard.accounts.filter(
          (a) =>
            a.hasKnownValue &&
            (a.sourceType === "manual" || a.isDemo || !a.stale),
        );
        if (!eligible.length)
          return {
            captured: false,
            reason: "No accounts have a current known valuation",
          };
        const [batch] =
          await tx`INSERT INTO valuation_batches(captured_at,base_currency) VALUES(${capturedAt},${currency}) ON CONFLICT DO NOTHING RETURNING id`;
        if (!batch) return { captured: false, reason: "Already captured" };
        for (const a of eligible)
          await tx`INSERT INTO account_valuations(batch_id,account_id,total_value,currency,complete,coverage) VALUES(${String(batch.id)},${a.id},${a.value},${currency},${a.complete},${tx.json(a.coverage as never)})`;
        return { captured: true, id: batch.id };
      },
    );
  }
}

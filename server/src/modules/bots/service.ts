import { z } from "zod";
import type { Database } from "../../db/index.js";
import { nonnegativeDecimal, currency } from "../../shared/decimal.js";
import { NotFoundError } from "../../shared/errors.js";
export const botInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    scheduleMinutes: z.number().int().min(1).max(10080).default(60),
    allocatedPaperCapital: nonnegativeDecimal.default("10000"),
    currency: currency.default("EUR"),
  })
  .strict();
export class BotService {
  constructor(private database: Database) {}
  async list() {
    return this.database
      .sql`SELECT b.*, (SELECT paper_pnl FROM bot_runs WHERE bot_id=b.id ORDER BY started_at DESC LIMIT 1) AS paper_pnl FROM bots b ORDER BY b.created_at`;
  }
  async create(input: unknown) {
    const b = botInput.parse(input);
    const [bot] = await this.database
      .sql`INSERT INTO bots(name,schedule_minutes,allocated_paper_capital,currency) VALUES(${b.name},${b.scheduleMinutes},${b.allocatedPaperCapital},${b.currency}) RETURNING *`;
    return bot!;
  }
  async enable(id: string, enabled: boolean) {
    const [bot] = await this.database
      .sql`UPDATE bots SET enabled=${enabled},next_run_at=${enabled ? new Date() : null},updated_at=now() WHERE id=${id} RETURNING *`;
    if (!bot) throw new NotFoundError();
    return bot;
  }
  async runs(id: string) {
    return this.database
      .sql`SELECT * FROM bot_runs WHERE bot_id=${id} ORDER BY started_at DESC LIMIT 100`;
  }
  async runDue(now = new Date()) {
    return this.database.sql.begin(async (tx) => {
      const bots =
        await tx`SELECT * FROM bots WHERE enabled AND (next_run_at IS NULL OR next_run_at<=${now}) FOR UPDATE SKIP LOCKED`;
      for (const bot of bots) {
        const scheduled = bot.nextRunAt ?? now;
        // The only V1 strategy is a no-trade heartbeat. It has no network or credential access.
        await tx`INSERT INTO bot_runs(bot_id,scheduled_for,status,paper_pnl,order_count,finished_at) VALUES(${String(bot.id)},${scheduled},'success','0',0,${now}) ON CONFLICT(bot_id,scheduled_for) DO NOTHING`;
        const next = new Date(
          now.getTime() + Number(bot.scheduleMinutes) * 60000,
        );
        await tx`UPDATE bots SET last_run_at=${now},next_run_at=${next},error_message=NULL,updated_at=now() WHERE id=${String(bot.id)}`;
      }
      return { evaluated: bots.length };
    });
  }
}

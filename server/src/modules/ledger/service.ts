import { NotFoundError } from "../../shared/errors.js";
import type { Database } from "../../db/index.js";
import type { Transaction } from "./schemas.js";
export class LedgerService {
  constructor(private database: Database) {}
  async get(id: string) {
    const [t] = await this.database.sql<
      Transaction[]
    >`SELECT * FROM transactions WHERE id=${id}`;
    if (!t) throw new NotFoundError();
    return t;
  }
  async list(accountId?: string) {
    return accountId
      ? this.database.sql<
          Transaction[]
        >`SELECT t.* FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.account_id=${accountId} AND NOT a.is_archived AND NOT t.is_voided ORDER BY t.occurred_at DESC,t.id LIMIT 500`
      : this.database.sql<
          Transaction[]
        >`SELECT t.* FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE NOT a.is_archived AND NOT t.is_voided ORDER BY t.occurred_at DESC,t.id LIMIT 500`;
  }
}

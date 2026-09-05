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
        >`SELECT * FROM transactions WHERE account_id=${accountId} ORDER BY occurred_at DESC,id LIMIT 500`
      : this.database.sql<
          Transaction[]
        >`SELECT * FROM transactions ORDER BY occurred_at DESC,id LIMIT 500`;
  }
}

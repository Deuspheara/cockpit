import type { Database } from "../../db/index.js";
import { accountInput, type Account } from "./schemas.js";
import { NotFoundError, AppError } from "../../shared/errors.js";
import { visibleAccounts } from "./visibility.js";
export class AccountService {
  constructor(private database: Database) {}
  async list() {
    const accounts = await this.database.sql<
      Account[]
    >`SELECT * FROM accounts WHERE NOT is_archived ORDER BY sort_order,name`;
    return visibleAccounts(accounts);
  }
  async get(id: string) {
    const [a] = await this.database.sql<
      Account[]
    >`SELECT * FROM accounts WHERE id=${id}`;
    if (!a) throw new NotFoundError("Account not found");
    return a;
  }
  async create(input: unknown) {
    const a = accountInput.parse(input);
    return this.database.sql.begin(async (tx) => {
      const [result] = await tx<
        Account[]
      >`INSERT INTO accounts(name,asset_class,source_type,institution,base_currency,external_address,external_subaccount)
        VALUES(${a.name},${a.assetClass},${a.sourceType},${a.institution ?? null},${a.baseCurrency},${a.externalAddress ?? null},${a.externalSubaccount ?? null}) RETURNING *`;
      if (a.sourceType === "evm_wallet")
        await tx`INSERT INTO sync_runs(account_id,provider,status) VALUES(${result!.id},'evm_wallet','queued')`;
      return result!;
    });
  }

  async rename(id: string, name: string) {
    if (!name.trim() || name.length > 120)
      throw new AppError("VALIDATION_ERROR", "Invalid name");
    return this.database.sql.begin(async (tx) => {
      const [before] =
        await tx`SELECT * FROM accounts WHERE id=${id} FOR UPDATE`;
      if (!before) throw new NotFoundError();
      const [after] =
        await tx`UPDATE accounts SET name=${name.trim()},updated_at=now() WHERE id=${id} RETURNING *`;
      await tx`INSERT INTO audit_log(actor,action,entity_type,entity_id,before,after) VALUES('user','rename','account',${id},${tx.json(before)},${tx.json(after!)})`;
      return after;
    });
  }
}

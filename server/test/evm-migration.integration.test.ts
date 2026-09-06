import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { connectDatabase } from "../src/db/index.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("EVM migration from populated schema 0010", () => {
  it("retains complete snapshots and provider PnL without relabeling either", async () => {
    if (!url || new URL(url).pathname != "/finance_test")
      throw new Error("Dedicated test DB required");
    const db = connectDatabase(url),
      schema = "evm_" + randomUUID().replaceAll("-", "");
    const directory = new URL("../migrations/", import.meta.url);
    try {
      await db.sql.begin(async (tx) => {
        await tx.unsafe(`CREATE SCHEMA ${schema}`);
        await tx.unsafe(`SET LOCAL search_path TO ${schema},public`);
        for (const file of (await readdir(directory))
          .filter((f) => f.endsWith(".sql") && f < "0011")
          .sort())
          await tx.unsafe(await readFile(new URL(file, directory), "utf8"));
        const [account] =
          await tx`INSERT INTO accounts(name,asset_class,source_type,base_currency) VALUES('Existing','cash','manual','EUR') RETURNING id`;
        const [batch] =
          await tx`INSERT INTO valuation_batches(captured_at,base_currency) VALUES(now(),'EUR') RETURNING id`;
        await tx`INSERT INTO account_valuations(batch_id,account_id,total_value,currency) VALUES(${batch!.id},${account!.id},'123','EUR')`;
        await tx`INSERT INTO provider_account_history(account_id,at,resolution,equity,total_pnl,net_transfers,currency,source) VALUES(${account!.id},now(),'daily','123','23','100','EUR','dydx')`;
        await tx.unsafe(
          await readFile(new URL("0011_evm_history.sql", directory), "utf8"),
        );
        const [snapshot] =
          await tx`SELECT total_value,complete,coverage FROM account_valuations`;
        expect(snapshot).toEqual({
          totalValue: "123.000000000000000000",
          complete: true,
          coverage: {},
        });
        expect(
          (await tx`SELECT total_pnl FROM provider_account_history`)[0]!
            .totalPnl,
        ).toBe("23.000000000000000000");
        await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      });
    } finally {
      await db.close();
    }
  });
});

import { readConfig } from "../config.js";
import { connectDatabase } from "./index.js";
import { randomUUID } from "node:crypto";
import { Decimal, money } from "../shared/decimal.js";
import { RecurringService } from "../modules/recurring/service.js";
const config = readConfig();
if (config.NODE_ENV !== "development")
  throw new Error("Seed is restricted to NODE_ENV=development");
const database = connectDatabase(config.DATABASE_URL);
try {
  await database.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(64023002)`;
    if ((await tx`SELECT id FROM accounts LIMIT 1`).length)
      throw new Error(
        "Seed requires an empty database; existing financial data is never replaced",
      );
    const assets = new Map<string, string>();
    for (const [symbol, name, type, price] of [
      ["BTC", "Bitcoin", "crypto", "55000"],
      ["ETH", "Ethereum", "crypto", "2500"],
      ["HYPE", "Hyperliquid", "crypto", "30"],
      ["USDC", "USD Coin (demo EUR valuation)", "crypto", "1"],
      ["CW8", "Amundi MSCI World", "etf", "520"],
      ["WPEA", "iShares MSCI World", "etf", "5"],
      ["EUR", "Euro cash", "cash", "1"],
    ]) {
      const id = randomUUID();
      assets.set(symbol!, id);
      await tx`INSERT INTO assets(id,symbol,name,asset_type,quote_currency,external_ids) VALUES(${id},${symbol!},${name!},${type!},'EUR',${tx.json({ demo: true })})`;
      await tx`INSERT INTO price_quotes(asset_id,quoted_at,price,currency,source) VALUES(${id},now(),${price!},'EUR','system')`;
    }
    const accounts = [
      {
        name: "Hyperliquid",
        category: "crypto",
        source: "hyperliquid",
        total: "18241",
        positions: [
          ["HYPE", "400", "12000"],
          ["USDC", "6241", "6241"],
        ],
      },
      {
        name: "Ledger",
        category: "crypto",
        source: "evm_wallet",
        total: "10620",
        positions: [
          ["BTC", "0.12", "6600"],
          ["ETH", "1.608", "4020"],
        ],
      },
      {
        name: "dYdX",
        category: "crypto",
        source: "dydx",
        total: "2140",
        positions: [["USDC", "2140", "2140"]],
      },
      {
        name: "PEA",
        category: "equities",
        source: "manual",
        total: "27840",
        positions: [
          ["CW8", "50", "26000"],
          ["WPEA", "200", "1000"],
          ["EUR", "840", "840"],
        ],
      },
      {
        name: "CTO",
        category: "equities",
        source: "manual",
        total: "4030",
        positions: [
          ["WPEA", "800", "4000"],
          ["EUR", "30", "30"],
        ],
      },
    ];
    const accountIds = new Map<string, string>();
    for (const a of accounts) {
      const id = randomUUID();
      accountIds.set(a.name, id);
      const address =
        a.source === "manual"
          ? null
          : a.source === "dydx"
            ? "dydx1" + "q".repeat(38)
            : "0x" + "0".repeat(40);
      await tx`INSERT INTO accounts(id,name,asset_class,source_type,base_currency,external_address,metadata) VALUES(${id},${a.name},${a.category},${a.source},'EUR',${address},${tx.json({ demo: true, syncDisabled: true })})`;
      for (const [symbol, quantity, value] of a.positions)
        await tx`INSERT INTO holding_observations(account_id,asset_id,observed_at,quantity,market_value,currency,source,metadata)
    VALUES(${id},${assets.get(symbol!)!},now(),${quantity!},${value!},'EUR','system',${tx.json({ demo: true })})`;
    }
    const ruleId = randomUUID();
    await tx`INSERT INTO recurring_rules(id,series_id,account_id,asset_id,transaction_type,input_mode,cash_amount,currency,cadence,start_on)
   VALUES(${ruleId},${randomUUID()},${accountIds.get("PEA")!},${assets.get("CW8")!},'BUY','cash_amount','500','EUR','monthly','2026-01-01')`;
    await tx`INSERT INTO recurring_occurrences(rule_id,due_at,status) VALUES(${ruleId},'2026-07-01T00:00:00Z','skipped')`;
    await tx`INSERT INTO reconciliation_items(account_id,asset_id,expected_quantity,observed_quantity,delta_quantity)
   VALUES(${accountIds.get("PEA")!},${assets.get("CW8")!},'52','50','-2')`;
    await tx`INSERT INTO audit_log(actor,action,entity_type,after) VALUES('system','seed_demo','portfolio',${tx.json({ demo: true, description: "Synthetic example values; not investment performance" })})`;
    for (let day = 89; day >= 0; day--) {
      const at = new Date(Date.now() - day * 86400000);
      const batchId = randomUUID();
      await tx`INSERT INTO valuation_batches(id,captured_at,base_currency) VALUES(${batchId},${at},'EUR')`;
      for (const a of accounts) {
        const value = money(
          new Decimal(a.total).mul(
            new Decimal(1).minus(new Decimal(day).mul("0.001")),
          ),
        );
        await tx`INSERT INTO account_valuations(batch_id,account_id,total_value,currency) VALUES(${batchId},${accountIds.get(a.name)!},${value},'EUR')`;
      }
    }
  });
  await new RecurringService(database).materialize(
    new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
  );
  console.log(
    "Seeded explicit demo positions: EUR 62,871.00. External demo accounts are sync-disabled.",
  );
} finally {
  await database.close();
}

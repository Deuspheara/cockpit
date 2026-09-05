import { Decimal, money } from "../../shared/decimal.js";
import type { Operation } from "./service.js";
export function changeEffects(operations: Operation[]) {
  const deltas = new Map<
    string,
    { accountId: string; assetId: string; delta: Decimal }
  >();
  let historicalTransactions = 0;
  const quantity = (row: Record<string, unknown> | null) => {
    if (!row || row.isVoided === true || typeof row.quantity !== "string")
      return new Decimal(0);
    return new Decimal(row.quantity).mul(
      ["SELL", "WITHDRAWAL", "TRANSFER_OUT", "FEE"].includes(String(row.type))
        ? -1
        : 1,
    );
  };
  for (const op of operations)
    if (op.table === "transactions") {
      const row = op.after ?? op.before;
      if (!row) continue;
      const key = `${row.accountId}:${row.assetId}`;
      const item = deltas.get(key) ?? {
        accountId: String(row.accountId),
        assetId: String(row.assetId),
        delta: new Decimal(0),
      };
      item.delta = item.delta.plus(
        quantity(op.after).minus(quantity(op.before)),
      );
      deltas.set(key, item);
      if (
        op.before &&
        new Date(String(op.before.occurredAt)).getTime() <= Date.now()
      )
        historicalTransactions++;
    }
  return {
    historicalTransactions,
    ledgerQuantityChanges: [...deltas.values()]
      .filter((d) => !d.delta.isZero())
      .map((d) => ({
        accountId: d.accountId,
        assetId: d.assetId,
        deltaQuantity: money(d.delta),
      })),
  };
}

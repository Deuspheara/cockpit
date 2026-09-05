import { describe, it, expect } from "vitest";
import {
  ledgerQuantity,
  ledgerCost,
  reconciliationDelta,
} from "../src/modules/portfolio/projection.js";
import { dueDates, previousDay } from "../src/modules/recurring/calendar.js";
import { ruleInput } from "../src/modules/recurring/schemas.js";
import { accountInput } from "../src/modules/accounts/schemas.js";
import { Decimal, money, decimalString } from "../src/shared/decimal.js";
import type { Transaction } from "../src/modules/ledger/schemas.js";
const accountId = "00000000-0000-4000-8000-000000000001";
const assetId = "00000000-0000-4000-8000-000000000002";
const base = {
  accountId,
  assetId,
  transactionType: "BUY",
  inputMode: "cash_amount",
  cashAmount: "500",
  currency: "EUR",
  cadence: "monthly",
  startOn: "2026-01-31",
};
describe("financial invariants", () => {
  it("projects BUY/SELL with full decimal precision and ignores voids", () => {
    expect(
      ledgerQuantity([
        { type: "BUY", quantity: "0.1", isVoided: false },
        { type: "BUY", quantity: "0.2", isVoided: false },
        { type: "SELL", quantity: "0.01", isVoided: false },
        { type: "BUY", quantity: "90", isVoided: true },
      ]),
    ).toBe("0.290000000000000000");
    expect(
      money(
        new Decimal("9999999999999999.000000000000000001").plus(
          "0.000000000000000001",
        ),
      ),
    ).toBe("9999999999999999.000000000000000002");
    expect(decimalString.safeParse(0.3).success).toBe(false);
  });
  it("does not infer cost basis from an unpriced purchase", () => {
    expect(
      ledgerCost([
        {
          id: assetId,
          type: "BUY",
          quantity: "18.23",
          unitPrice: null,
          isVoided: false,
          occurredAt: "2026-01-01T00:00:00Z",
        } as Transaction,
      ]),
    ).toBeUndefined();
  });
  it("rejects an opaque manual account total and credentials", () => {
    expect(
      accountInput.safeParse({
        name: "PEA",
        assetClass: "equities",
        sourceType: "manual",
        total: "10000",
      }).success,
    ).toBe(false);
    expect(
      accountInput.safeParse({
        name: "Wallet",
        assetClass: "crypto",
        sourceType: "evm_wallet",
        privateKey: "secret",
      }).success,
    ).toBe(false);
  });
  it("clamps monthly dates without drifting after February", () => {
    expect(
      dueDates(ruleInput.parse(base), "2026-04-30").map((d) => d.slice(0, 10)),
    ).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(previousDay("2024-03-01")).toBe("2024-02-29");
  });
  it("supports weekly/yearly intervals and rejects automatic cash-amount posting", () => {
    expect(
      dueDates(
        ruleInput.parse({
          ...base,
          startOn: "2026-01-01",
          cadence: "weekly",
          weekday: 1,
          interval: 2,
        }),
        "2026-02-01",
      ).map((d) => d.slice(0, 10)),
    ).toEqual(["2026-01-05", "2026-01-19"]);
    expect(
      dueDates(
        ruleInput.parse({ ...base, startOn: "2024-02-29", cadence: "yearly" }),
        "2026-03-01",
      ).map((d) => d.slice(0, 10)),
    ).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"]);
    expect(ruleInput.safeParse({ ...base, autoPost: true }).success).toBe(
      false,
    );
  });
  it("uses asset-aware reconciliation tolerance", () => {
    expect(reconciliationDelta("32.20", "30.20", "etf")).toBe(
      "-2.000000000000000000",
    );
    expect(reconciliationDelta("1", "1.000000001", "crypto")).toBeNull();
  });
});

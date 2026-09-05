import { z } from "zod";
import { Decimal, money, decimalString } from "../../shared/decimal.js";
import type { Account } from "../accounts/schemas.js";
export const providerDecimal = z
  .string()
  .regex(/^-?\d{1,20}(?:\.\d{1,60})?$/)
  .transform((value) => decimalString.parse(money(value)));
export interface ProviderAsset {
  key: string;
  symbol: string;
  name: string;
  assetType: "crypto" | "perp" | "cash";
  chain?: string;
  contractAddress?: string;
}
export interface ProviderPosition {
  asset: ProviderAsset;
  scope: string;
  quantity: string;
  currency: string;
  unitPrice?: string;
  marketValue?: string;
  unrealizedPnl?: string;
  realizedPnl?: string;
  side?: "long" | "short";
  entryPrice?: string;
  leverage?: string;
  liquidationPrice?: string;
  metadata?: Record<string, string | boolean>;
}
export interface ProviderTransaction {
  asset: ProviderAsset;
  externalId: string;
  type: "BUY" | "SELL" | "DEPOSIT" | "WITHDRAWAL" | "FEE" | "FUNDING";
  occurredAt: string;
  quantity: string;
  unitPrice?: string;
  feeAmount?: string;
  currency: string;
}
export interface ProviderHistoryPoint {
  at: string;
  resolution: "hourly" | "daily";
  equity: string;
  totalPnl: string;
  netTransfers: string;
  currency: string;
}
export interface ProviderSyncResult {
  history?: ProviderHistoryPoint[];
  positions: ProviderPosition[];
  transactions: ProviderTransaction[];
  coveredScopes: string[];
  warnings: string[];
  cursor: Record<string, string | number>;
  metadata?: Record<string, unknown>;
}
export interface ReadOnlyAccountProvider {
  readonly kind: string;
  syncAccount(
    account: Account,
    cursor: Record<string, unknown>,
  ): Promise<ProviderSyncResult>;
}
export const emptySync = (): ProviderSyncResult => ({
  positions: [],
  transactions: [],
  coveredScopes: [],
  warnings: [],
  cursor: {},
});
export function signedBalance(
  asset: ProviderAsset,
  scope: string,
  value: string,
): ProviderPosition {
  const amount = new Decimal(value);
  return {
    asset,
    scope,
    quantity: money(amount.abs()),
    currency: "USD",
    unitPrice: money(1),
    marketValue: money(amount),
    side: amount.lt(0) ? "short" : "long",
  };
}

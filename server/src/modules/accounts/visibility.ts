import type { Account } from "./schemas.js";
// Seed data is a standalone preview, never part of a real user's totals.
export function visibleAccounts(accounts: Account[]): Account[] {
  return accounts.some((a) => a.metadata.demo !== true)
    ? accounts.filter((a) => a.metadata.demo !== true)
    : accounts;
}

export const toolLabels: Record<string, string> = {
  get_portfolio_overview: "Checking your portfolio",
  list_accounts: "Checking your accounts",
  get_account: "Loading account details",
  list_positions: "Loading positions",
  list_transactions: "Loading transactions",
  list_recurring_rules: "Checking recurring investments",
  get_recurring_rule: "Loading recurring investment details",
  list_recurring_occurrences: "Checking scheduled occurrences",
  find_assets: "Finding assets",
  get_reconciliation_items: "Checking reconciliation items",
  get_stale_accounts: "Checking data freshness",
  propose_create_transaction: "Preparing a transaction proposal",
  propose_void_transaction: "Preparing a transaction removal proposal",
  propose_update_transaction: "Preparing a transaction correction",
  propose_create_recurring_rule: "Preparing a recurring investment proposal",
  propose_change_recurring_rule_from_date:
    "Preparing a recurring investment change",
  propose_stop_recurring_rule: "Preparing a stop proposal",
  propose_skip_occurrence: "Preparing a skip proposal",
  propose_detach_occurrence: "Preparing an occurrence proposal",
};
export function toolSummary(result: unknown, proposal: boolean) {
  if (proposal)
    return "Proposal ready for review. No financial changes applied.";
  if (Array.isArray(result))
    return `${result.length} record${result.length === 1 ? "" : "s"} loaded`;
  return "Records loaded";
}

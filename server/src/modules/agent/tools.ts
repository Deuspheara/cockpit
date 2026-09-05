import { z } from "zod";
import type { Database } from "../../db/index.js";
import { AppError } from "../../shared/errors.js";
import { AccountService } from "../accounts/service.js";
import { AssetService } from "../assets/service.js";
import { PortfolioService } from "../portfolio/service.js";
import { LedgerService } from "../ledger/service.js";
import { RecurringService } from "../recurring/service.js";
import { ReconciliationService } from "../reconciliation/service.js";
import { ChangeSetService } from "../changes/service.js";
import { transactionInput } from "../ledger/schemas.js";
import { ruleInput } from "../recurring/schemas.js";
export class AgentTools {
  private accounts: AccountService;
  private assets: AssetService;
  private portfolio: PortfolioService;
  private ledger: LedgerService;
  private recurring: RecurringService;
  private reconciliation: ReconciliationService;
  private schemas = {
    get_portfolio_overview: z.object({}).strict(),
    list_accounts: z.object({}).strict(),
    get_account: z.object({ accountId: z.uuid().toLowerCase() }).strict(),
    list_positions: z.object({ accountId: z.uuid().toLowerCase() }).strict(),
    list_transactions: z.object({ accountId: z.uuid().toLowerCase() }).strict(),
    list_recurring_rules: z.object({}).strict(),
    get_recurring_rule: z.object({ ruleId: z.uuid().toLowerCase() }).strict(),
    list_recurring_occurrences: z
      .object({ ruleId: z.uuid().toLowerCase() })
      .strict(),
    find_assets: z.object({ query: z.string().min(1).max(100) }).strict(),
    get_reconciliation_items: z
      .object({ accountId: z.uuid().toLowerCase() })
      .strict(),
    get_stale_accounts: z.object({}).strict(),
    propose_create_transaction: transactionInput,
    propose_void_transaction: z
      .object({ transactionId: z.uuid().toLowerCase() })
      .strict(),
    propose_update_transaction: z
      .object({
        transactionId: z.uuid().toLowerCase(),
        transaction: transactionInput,
      })
      .strict(),
    propose_create_recurring_rule: ruleInput,
    propose_change_recurring_rule_from_date: z
      .object({
        ruleId: z.uuid().toLowerCase(),
        effectiveOn: z.iso.date(),
        replacement: ruleInput,
      })
      .strict(),
    propose_stop_recurring_rule: z
      .object({ ruleId: z.uuid().toLowerCase(), effectiveOn: z.iso.date() })
      .strict(),
    propose_skip_occurrence: z
      .object({ occurrenceId: z.uuid().toLowerCase() })
      .strict(),
    propose_detach_occurrence: z
      .object({ occurrenceId: z.uuid().toLowerCase() })
      .strict(),
  };
  constructor(
    database: Database,
    private changes: ChangeSetService,
  ) {
    this.accounts = new AccountService(database);
    this.assets = new AssetService(database);
    this.portfolio = new PortfolioService(database);
    this.ledger = new LedgerService(database);
    this.recurring = new RecurringService(database);
    this.reconciliation = new ReconciliationService(database);
  }
  definitions() {
    return Object.entries(this.schemas).map(([name, schema]) => ({
      type: "function",
      function: {
        name,
        description: name.startsWith("propose_")
          ? "Create a deterministic draft for user review. Does not apply financial changes."
          : "Read bounded finance records. Missing cost basis remains unknown.",
        parameters: z.toJSONSchema(schema),
      },
    }));
  }
  validate(name: string, input: unknown): unknown {
    if (!Object.hasOwn(this.schemas, name))
      throw new AppError(
        "TOOL_FORBIDDEN",
        "This tool is not available to the finance assistant",
        403,
      );
    return this.schemas[name as keyof typeof this.schemas].parse(input);
  }
  async execute(name: string, input: unknown): Promise<unknown> {
    // Exhaustive dispatch is the authorization boundary; never invoke arbitrary object properties by model name.
    switch (name) {
      case "get_portfolio_overview":
        this.schemas.get_portfolio_overview.parse(input);
        return this.portfolio.dashboard("global", "1m");
      case "list_accounts":
        this.schemas.list_accounts.parse(input);
        return this.accounts.list();
      case "get_account":
        return this.accounts.get(
          this.schemas.get_account.parse(input).accountId,
        );
      case "list_positions":
        return (
          (
            await this.portfolio.positions(
              this.schemas.list_positions.parse(input).accountId,
            )
          )
            .values()
            .next().value ?? []
        );
      case "list_transactions":
        return this.ledger.list(
          this.schemas.list_transactions.parse(input).accountId,
        );
      case "list_recurring_rules":
        this.schemas.list_recurring_rules.parse(input);
        return (await this.recurring.list()).slice(0, 100);
      case "get_recurring_rule":
        return this.recurring.get(
          this.schemas.get_recurring_rule.parse(input).ruleId,
        );
      case "list_recurring_occurrences":
        return (
          await this.recurring.occurrences(
            this.schemas.list_recurring_occurrences.parse(input).ruleId,
          )
        ).slice(-100);
      case "find_assets": {
        const { query } = this.schemas.find_assets.parse(input);
        return (await this.assets.list())
          .filter((a) =>
            `${a.symbol} ${a.name}`.toLowerCase().includes(query.toLowerCase()),
          )
          .slice(0, 30);
      }
      case "get_reconciliation_items":
        return this.reconciliation.list(
          this.schemas.get_reconciliation_items.parse(input).accountId,
        );
      case "get_stale_accounts":
        this.schemas.get_stale_accounts.parse(input);
        return (await this.portfolio.dashboard("global", "1m")).accounts.filter(
          (a) => a.stale,
        );
      case "propose_create_transaction":
        return this.changes.proposeTransaction(
          this.schemas.propose_create_transaction.parse(input),
          "agent",
        );
      case "propose_void_transaction":
        return this.changes.proposeTransactionEdit(
          this.schemas.propose_void_transaction.parse(input).transactionId,
          null,
          "agent",
        );
      case "propose_update_transaction": {
        const { transactionId, transaction } =
          this.schemas.propose_update_transaction.parse(input);
        return this.changes.proposeTransactionEdit(
          transactionId,
          transaction,
          "agent",
        );
      }
      case "propose_create_recurring_rule":
        return this.changes.proposeRule(
          this.schemas.propose_create_recurring_rule.parse(input),
          "agent",
        );
      case "propose_change_recurring_rule_from_date": {
        const { ruleId, effectiveOn, replacement } =
          this.schemas.propose_change_recurring_rule_from_date.parse(input);
        return this.changes.proposeRuleChange(
          ruleId,
          effectiveOn,
          replacement,
          "agent",
        );
      }
      case "propose_stop_recurring_rule": {
        const { ruleId, effectiveOn } =
          this.schemas.propose_stop_recurring_rule.parse(input);
        return this.changes.proposeRuleChange(
          ruleId,
          effectiveOn,
          null,
          "agent",
        );
      }
      case "propose_skip_occurrence":
        return this.changes.proposeOccurrence(
          this.schemas.propose_skip_occurrence.parse(input).occurrenceId,
          "skipped",
          "agent",
        );
      case "propose_detach_occurrence":
        return this.changes.proposeOccurrence(
          this.schemas.propose_detach_occurrence.parse(input).occurrenceId,
          "detached",
          "agent",
        );
      default:
        throw new AppError(
          "TOOL_FORBIDDEN",
          "This tool is not available to the finance assistant",
          403,
        );
    }
  }
}

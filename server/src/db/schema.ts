import {
  pgTable,
  bigint,
  uuid,
  text,
  timestamp,
  uniqueIndex,
  pgEnum,
  numeric,
  integer,
  boolean,
  jsonb,
  date,
} from "drizzle-orm/pg-core";
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("api_tokens_hash_unique").on(table.tokenHash)],
);

// SQL migrations contain additional CHECK constraints, partial indexes, and circular FKs.
export const assetClassEnum = pgEnum("asset_class", [
  "crypto",
  "equities",
  "cash",
  "other",
]);
export const sourceTypeEnum = pgEnum("source_type", [
  "manual",
  "hyperliquid",
  "dydx",
  "evm_wallet",
]);
export const assetTypeEnum = pgEnum("asset_type", [
  "crypto",
  "equity",
  "etf",
  "cash",
  "perp",
  "option",
  "other",
]);
export const transactionTypeEnum = pgEnum("transaction_type", [
  "BUY",
  "SELL",
  "DEPOSIT",
  "WITHDRAWAL",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "FEE",
  "INCOME",
  "FUNDING",
  "ADJUSTMENT",
]);
export const accounts = pgTable("accounts", {
  provider: text("provider"),
  connectionType: text("connection_type"),
  providerAccountKey: text("provider_account_key"),
  lastImportedAt: timestamp("last_imported_at", { withTimezone: true }),
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  assetClass: assetClassEnum("asset_class").notNull(),
  sourceType: sourceTypeEnum("source_type").notNull(),
  institution: text("institution"),
  baseCurrency: text("base_currency").notNull(),
  externalAddress: text("external_address"),
  externalSubaccount: integer("external_subaccount"),
  metadata: jsonb("metadata").notNull().default({}),
  sortOrder: integer("sort_order").notNull(),
  isArchived: boolean("is_archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetType: assetTypeEnum("asset_type").notNull(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  chain: text("chain"),
  contractAddress: text("contract_address"),
  externalIds: jsonb("external_ids").notNull().default({}),
  securityId: uuid("security_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const recurringRules = pgTable("recurring_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  seriesId: uuid("series_id").notNull(),
  accountId: uuid("account_id").notNull(),
  assetId: uuid("asset_id"),
  transactionType: transactionTypeEnum("transaction_type").notNull(),
  inputMode: text("input_mode").notNull(),
  quantity: numeric("quantity", { precision: 38, scale: 18 }),
  cashAmount: numeric("cash_amount", { precision: 38, scale: 18 }),
  currency: text("currency").notNull(),
  cadence: text("cadence").notNull(),
  interval: integer("interval").notNull(),
  weekday: integer("weekday"),
  dayOfMonth: integer("day_of_month"),
  startOn: date("start_on").notNull(),
  endOn: date("end_on"),
  autoPost: boolean("auto_post").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  supersedesRuleId: uuid("supersedes_rule_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const recurringOccurrences = pgTable("recurring_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  ruleId: uuid("rule_id").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  transactionId: uuid("transaction_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const transactions = pgTable("transactions", {
  provider: text("provider"),
  importBatchId: uuid("import_batch_id"),
  contentHash: text("content_hash"),
  netCashAmount: numeric("net_cash_amount", { precision: 38, scale: 18 }),
  taxAmount: numeric("tax_amount", { precision: 38, scale: 18 }),
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  assetId: uuid("asset_id"),
  type: transactionTypeEnum("type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  quantity: numeric("quantity", { precision: 38, scale: 18 }),
  unitPrice: numeric("unit_price", { precision: 38, scale: 18 }),
  currency: text("currency").notNull(),
  grossAmount: numeric("gross_amount", { precision: 38, scale: 18 }),
  feeAmount: numeric("fee_amount", { precision: 38, scale: 18 }),
  notes: text("notes"),
  source: text("source").notNull(),
  externalId: text("external_id"),
  recurrenceOccurrenceId: uuid("recurrence_occurrence_id"),
  transferGroupId: uuid("transfer_group_id"),
  isVoided: boolean("is_voided").notNull().default(false),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const holdingObservations = pgTable("holding_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  quantity: numeric("quantity", { precision: 38, scale: 18 }),
  unitPrice: numeric("unit_price", { precision: 38, scale: 18 }),
  marketValue: numeric("market_value", { precision: 38, scale: 18 }),
  currency: text("currency").notNull(),
  costBasis: numeric("cost_basis", { precision: 38, scale: 18 }),
  unrealizedPnl: numeric("unrealized_pnl", { precision: 38, scale: 18 }),
  realizedPnl: numeric("realized_pnl", { precision: 38, scale: 18 }),
  side: text("side"),
  entryPrice: numeric("entry_price", { precision: 38, scale: 18 }),
  leverage: numeric("leverage", { precision: 38, scale: 18 }),
  liquidationPrice: numeric("liquidation_price", { precision: 38, scale: 18 }),
  source: text("source").notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }),
  importSessionId: uuid("import_session_id"),
  externalId: text("external_id"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const priceQuotes = pgTable("price_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  assetId: uuid("asset_id").notNull(),
  quotedAt: timestamp("quoted_at", { withTimezone: true }).notNull(),
  price: numeric("price", { precision: 38, scale: 18 }).notNull(),
  currency: text("currency").notNull(),
  source: text("source").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
});
export const changeSets = pgTable("change_sets", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull(),
  operations: jsonb("operations").notNull(),
  inverseOperations: jsonb("inverse_operations"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
});
export const reconciliationItems = pgTable("reconciliation_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  importSessionId: uuid("import_session_id"),
  accountId: uuid("account_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  expectedQuantity: numeric("expected_quantity", { precision: 38, scale: 18 }),
  observedQuantity: numeric("observed_quantity", { precision: 38, scale: 18 }),
  deltaQuantity: numeric("delta_quantity", { precision: 38, scale: 18 }),
  status: text("status").notNull(),
  proposedAction: jsonb("proposed_action"),
  changeSetId: uuid("change_set_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  changeSetId: uuid("change_set_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const valuationBatches = pgTable("valuation_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  baseCurrency: text("base_currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const accountValuations = pgTable("account_valuations", {
  complete: boolean("complete").notNull().default(true),
  coverage: jsonb("coverage").notNull().default({}),
  batchId: uuid("batch_id").notNull(),
  accountId: uuid("account_id").notNull(),
  totalValue: numeric("total_value", { precision: 38, scale: 18 }).notNull(),
  netContributions: numeric("net_contributions", { precision: 38, scale: 18 }),
  realizedPnl: numeric("realized_pnl", { precision: 38, scale: 18 }),
  unrealizedPnl: numeric("unrealized_pnl", { precision: 38, scale: 18 }),
  currency: text("currency").notNull(),
});

// SQL migrations contain additional CHECK constraints, partial indexes, and circular FKs.
export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  cursor: jsonb("cursor"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  details: jsonb("details").notNull().default({}),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const fxQuotes = pgTable("fx_quotes", {
  id: uuid("id").primaryKey().defaultRandom(),
  baseCurrency: text("base_currency").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  rate: numeric("rate", { precision: 38, scale: 18 }).notNull(),
  quotedAt: timestamp("quoted_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(),
});
export const importSessions = pgTable("import_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id"),
  conversationId: uuid("conversation_id"),
  requestId: uuid("request_id"),
  status: text("status").notNull(),
  summary: text("summary"),
  model: text("model"),
  changeSetId: uuid("change_set_id"),
  revision: integer("revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const importExtractions = pgTable("import_extractions", {
  id: uuid("id").primaryKey().defaultRandom(),
  importSessionId: uuid("import_session_id").notNull(),
  artifactIndex: integer("artifact_index").notNull(),
  extraction: jsonb("extraction").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const agentConversations = pgTable("agent_conversations", {
  requestId: uuid("request_id"),
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const agentMessages = pgTable("agent_messages", {
  runId: uuid("run_id"),
  attemptId: uuid("attempt_id"),
  status: text("status").notNull().default("completed"),
  ordinal: bigint("ordinal", { mode: "bigint" }),
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  kind: text("kind").notNull().default("text"),
  metadata: jsonb("metadata").notNull().default({}),
  changeSetIds: jsonb("change_set_ids").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const bots = pgTable("bots", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  strategy: text("strategy").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  scheduleMinutes: integer("schedule_minutes").notNull(),
  allocatedPaperCapital: numeric("allocated_paper_capital", {
    precision: 38,
    scale: 18,
  }).notNull(),
  currency: text("currency").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const botRuns = pgTable("bot_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  botId: uuid("bot_id").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  paperPnl: numeric("paper_pnl", { precision: 38, scale: 18 }),
  orderCount: integer("order_count").notNull(),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});
export const paperOrders = pgTable("paper_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  botRunId: uuid("bot_run_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  side: text("side").notNull(),
  quantity: numeric("quantity", { precision: 38, scale: 18 }).notNull(),
  price: numeric("price", { precision: 38, scale: 18 }).notNull(),
  currency: text("currency").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const providerAccountHistory = pgTable("provider_account_history", {
  accountId: uuid("account_id").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  resolution: text("resolution").notNull(),
  equity: numeric("equity", { precision: 38, scale: 18 }).notNull(),
  totalPnl: numeric("total_pnl", { precision: 38, scale: 18 }).notNull(),
  netTransfers: numeric("net_transfers", {
    precision: 38,
    scale: 18,
  }).notNull(),
  currency: text("currency").notNull(),
  source: text("source").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Durable agent execution is authoritative in PostgreSQL; see migration 0007 for constraints.
export const agentRuns = pgTable("agent_runs", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  requestId: uuid("request_id").notNull(),
  text: text("text").notNull(),
  context: jsonb("context").notNull(),
  pending: jsonb("pending").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const agentAttempts = pgTable("agent_attempts", {
  id: uuid("id").primaryKey(),
  runId: uuid("run_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  requestId: uuid("request_id").notNull(),
  status: text("status").notNull(),
  cancelRequested: boolean("cancel_requested").notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const agentEvents = pgTable("agent_events", {
  id: bigint("id", { mode: "bigint" }).primaryKey(),
  attemptId: uuid("attempt_id").notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const agentToolResults = pgTable("agent_tool_results", {
  runId: uuid("run_id").notNull(),
  key: text("key").notNull(),
  result: jsonb("result").notNull(),
  proposalId: uuid("proposal_id"),
});

export const importJobs = pgTable("import_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  importSessionId: uuid("import_session_id").notNull(),
  requestId: uuid("request_id").notNull(),
  sessionRevision: integer("session_revision").notNull(),
  status: text("status").notNull(),
  phase: text("phase").notNull(),
  failure: jsonb("failure"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const csvImportBatches = pgTable("csv_import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  creatorTokenId: uuid("creator_token_id").notNull(),
  provider: text("provider").notNull(),
  filename: text("filename").notNull(),
  parserVersion: text("parser_version").notNull(),
  status: text("status").notNull().default("preview"),
  revision: integer("revision").notNull().default(1),
  staged: jsonb("staged"),
  preview: jsonb("preview").notNull(),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
export const csvImportAccounts = pgTable("csv_import_accounts", {
  batchId: uuid("batch_id").notNull(),
  accountId: uuid("account_id").notNull(),
  importedRows: integer("imported_rows").notNull(),
  duplicateRows: integer("duplicate_rows").notNull(),
});

export const securities = pgTable("securities", {
  id: uuid("id").primaryKey().defaultRandom(),
  isin: text("isin").notNull(),
  name: text("name").notNull(),
  assetType: assetTypeEnum("asset_type").notNull(),
  primaryAssetId: uuid("primary_asset_id"),
  identityStatus: text("identity_status").notNull(),
  identityEvidence: jsonb("identity_evidence").notNull().default({}),
  preferredMappingId: uuid("preferred_mapping_id"),
  selectionLocked: boolean("selection_locked").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const securityListings = pgTable("security_listings", {
  id: uuid("id").primaryKey().defaultRandom(),
  securityId: uuid("security_id").notNull(),
  ticker: text("ticker").notNull(),
  mic: text("mic"),
  name: text("name").notNull(),
  quoteCurrency: text("quote_currency").notNull(),
  quoteUnit: text("quote_unit").notNull().default("major"),
  unitMultiplier: numeric("unit_multiplier", { precision: 38, scale: 18 })
    .notNull()
    .default("1"),
  timezone: text("timezone"),
  active: boolean("active").notNull().default(true),
  validFrom: date("valid_from"),
  validTo: date("valid_to"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const providerMappings = pgTable("provider_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id").notNull(),
  provider: text("provider").notNull(),
  providerSymbol: text("provider_symbol").notNull(),
  providerExchange: text("provider_exchange"),
  feedScope: text("feed_scope").notNull().default("eod"),
  verificationStatus: text("verification_status").notNull(),
  evidence: jsonb("evidence").notNull().default({}),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const marketPrices = pgTable("market_prices", {
  id: uuid("id").primaryKey().defaultRandom(),
  mappingId: uuid("mapping_id").notNull(),
  kind: text("kind").notNull().default("eod"),
  open: numeric("open", { precision: 38, scale: 18 }),
  high: numeric("high", { precision: 38, scale: 18 }),
  low: numeric("low", { precision: 38, scale: 18 }),
  close: numeric("close", { precision: 38, scale: 18 }).notNull(),
  adjustedClose: numeric("adjusted_close", { precision: 38, scale: 18 }),
  volume: numeric("volume", { precision: 38, scale: 8 }),
  currency: text("currency").notNull(),
  unitMultiplier: numeric("unit_multiplier", { precision: 38, scale: 18 })
    .notNull()
    .default("1"),
  marketDate: date("market_date").notNull(),
  sourceTimestamp: timestamp("source_timestamp", { withTimezone: true }),
  timePrecision: text("time_precision").notNull().default("date"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  adjustmentBasis: text("adjustment_basis").notNull().default("raw"),
  metadata: jsonb("metadata").notNull().default({}),
});
export const marketDataState = pgTable("market_data_state", {
  securityId: uuid("security_id").notNull(),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  errorClass: text("error_class"),
  provider: text("provider"),
  providerCode: text("provider_code"),
  message: text("message"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export const marketDataJobs = pgTable("market_data_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  securityId: uuid("security_id").notNull(),
  jobType: text("job_type").notNull(),
  mappingRevision: integer("mapping_revision"),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  failure: jsonb("failure"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

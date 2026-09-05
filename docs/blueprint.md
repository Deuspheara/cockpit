# Finance Cockpit — Codex Build Blueprint

> Working title only. Do not spend time on naming or branding. Build the product.

## 0. Your role

You are Codex acting as the senior engineer responsible for creating this project end-to-end.

Do not stop after scaffolding, writing architecture notes, or producing mock screens. Build a working vertical slice that can run locally, build on iOS, and deploy to a personal VPS with Docker Compose.

Priorities, in this exact order:

1. Correct financial data model.
2. Read-only safety for connected crypto accounts.
3. Clear, native-feeling iOS UX.
4. Simple and readable code.
5. Reliable self-hosting.
6. Fast perceived performance.
7. AI assistance that uses deterministic tools instead of directly mutating data.
8. Extensibility only where it is already justified by the product.

Use KISS. Prefer boring, explicit code over clever abstractions. Avoid enterprise architecture, generic repositories for every table, event buses, CQRS, microservices, dependency-injection frameworks, excessive protocols, or speculative abstractions.

If there is a choice between 40 lines of obvious code and 10 lines of magical code, prefer the obvious code.

---

# 1. Product goal

Build a private personal-finance iOS application that gives one user a clean global overview of investments.

The first version focuses on investments:

- Hyperliquid — automatic, strictly read-only.
- dYdX — automatic, strictly read-only.
- Public crypto wallets — automatic token balances only in V1.
- Stocks / ETF / PEA / brokerage accounts — explicit manual positions and transactions, with AI-assisted screenshot onboarding.
- Recurring manual investment rules.
- Historical portfolio valuation.
- Global AI chat as a secondary utility for entering, correcting, reconciling, and organizing data.
- A Bots area prepared for paper-trading jobs on the VPS. Do not implement live trading in V1.

The architecture must later be able to support:

- DeFi positions.
- Cash / bank accounts.
- Real estate and other assets.
- Additional exchanges.
- Additional market-data providers.
- Live bots in a separate security boundary.

But do not implement those future features prematurely.

---

# 2. Non-negotiable product principles

## 2.1 No magic balances

Never allow a manual account to be represented only by an opaque value such as:

```text
PEA = €18,500
```

Every displayed account total must be explainable by explicit lines:

- positions,
- cash positions,
- transactions,
- or externally observed provider positions.

Examples:

```text
CW8       18.23 shares
WPEA      40 shares
EUR Cash  €842.13
```

The account total is derived from these lines.

If cost basis is unknown, say it is unknown. Never invent acquisition prices or historical transactions to make the math work.

## 2.2 Provenance everywhere

Every important financial value must have a source.

Examples:

- `manual`
- `screenshot`
- `recurring_rule`
- `hyperliquid`
- `dydx`
- `evm_wallet`
- `agent`
- `system`

The UI should be able to answer:

> Where did this number come from and when was it last updated?

## 2.3 External crypto connections are read-only

The portfolio backend must never require:

- a seed phrase,
- a private key,
- an exchange trading key,
- a wallet signing request.

Hyperliquid and dYdX V1 integrations use public account/address data only.

The portfolio backend must not implement Hyperliquid exchange/trading endpoints.

The public-wallet integration must only query balances/prices.

## 2.4 AI understands intent; application code owns truth

Never allow the model to:

- write SQL,
- call arbitrary HTTP endpoints,
- mutate tables directly,
- invent missing financial facts,
- silently replace reconciled values.

The model calls small typed tools. Those tools call normal application services. Financial mutations use change sets and deterministic validation.

## 2.5 Historical edits are first-class

The user must be able to correct the past.

Examples:

- Stop a recurring purchase from June onward.
- Change a recurring amount from €500 to €700 starting in September.
- Remove a wrongly generated July occurrence.
- Detach one occurrence from a recurring series.
- Correct a transaction found months later.
- Undo an AI-applied change.

Do not design recurring rules as immutable cron strings that cannot explain their history.

---

# 3. Stable technology baseline

Use stable production releases, not beta SDKs.

## iOS

- Swift 6.3.
- Xcode 26.x stable toolchain.
- Deployment target: iOS 26.0 unless the existing local environment requires a lower target.
- SwiftUI.
- Swift Charts.
- Swift Observation / `@Observable`.
- Swift Concurrency / async-await.
- URLSession.
- Security framework / Keychain.
- PhotosUI for screenshot selection.
- Swift Testing for new tests where practical.

Do not add third-party iOS dependencies unless there is a concrete reason.

In particular, do not use:

- Alamofire,
- a third-party chart library,
- a third-party design system,
- a Redux-style state framework,
- a third-party Keychain wrapper.

Use the platform.

## Server

- Node.js 24 LTS.
- TypeScript in strict mode.
- Fastify 5.
- PostgreSQL 18.x stable.
- Redis 8.x stable.
- Drizzle ORM for schema + migrations, with readable SQL when SQL is clearer.
- Pino structured logging through Fastify.
- Vitest for backend tests.
- Docker Compose.
- Caddy 2.x as TLS reverse proxy.

Use the Node built-in `fetch` for external HTTP calls. Do not add Axios.

Package manager: use npm and commit `package-lock.json` unless the repository already uses another package manager.

Pin production dependencies through the lockfile. Pin Docker image major/minor versions deliberately; do not use `latest`.

---

# 4. Repository layout

Create a single repository:

```text
finance-cockpit/
├── ios/
│   ├── project.yml
│   ├── FinanceCockpit/
│   │   ├── App/
│   │   ├── Core/
│   │   │   ├── Networking/
│   │   │   ├── Security/
│   │   │   ├── Cache/
│   │   │   ├── Formatting/
│   │   │   └── Design/
│   │   ├── Models/
│   │   ├── Features/
│   │   │   ├── Portfolio/
│   │   │   ├── Account/
│   │   │   ├── Activity/
│   │   │   ├── Imports/
│   │   │   ├── Agent/
│   │   │   ├── Bots/
│   │   │   └── Settings/
│   │   ├── Resources/
│   │   └── PreviewContent/
│   └── FinanceCockpitTests/
│
├── server/
│   ├── src/
│   │   ├── app.ts
│   │   ├── server.ts
│   │   ├── config.ts
│   │   ├── db/
│   │   ├── shared/
│   │   └── modules/
│   │       ├── auth/
│   │       ├── accounts/
│   │       ├── assets/
│   │       ├── portfolio/
│   │       ├── ledger/
│   │       ├── recurring/
│   │       ├── reconciliation/
│   │       ├── imports/
│   │       ├── agent/
│   │       ├── snapshots/
│   │       ├── integrations/
│   │       │   ├── hyperliquid/
│   │       │   ├── dydx/
│   │       │   └── alchemy/
│   │       └── bots/
│   ├── migrations/
│   ├── test/
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
│
├── deploy/
│   ├── Caddyfile
│   └── backup.sh
│
├── compose.yaml
├── .env.example
├── .gitignore
├── Makefile
├── README.md
└── docs/
    ├── architecture.md
    ├── data-model.md
    └── security.md
```

Use XcodeGen for the simple iOS project so Codex can create and reproduce the Xcode project from `ios/project.yml`. Keep XcodeGen usage minimal. The application source itself must not depend on XcodeGen at runtime.

---

# 5. Backend architecture rules

Use feature modules, not textbook clean-architecture ceremony.

A normal module can contain:

```text
accounts/
├── routes.ts
├── service.ts
├── repo.ts
├── schemas.ts
└── types.ts
```

Not every module needs every file.

Rules:

- Routes handle HTTP concerns.
- Services contain business rules.
- Repositories contain non-trivial DB queries.
- Small obvious DB queries may stay in the service if extracting them makes the code harder to read.
- External-provider mapping belongs in provider adapters.
- No global singleton magic.
- No dependency injection framework.
- Construct dependencies explicitly in `createApp()`.
- Domain services receive the DB/Redis/config they need.

Create a small error hierarchy only if it makes responses clearer:

```text
AppError
ValidationError
NotFoundError
ConflictError
ExternalProviderError
UnauthorizedError
```

Return API errors in a stable shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable message",
    "details": {}
  }
}
```

Never leak stack traces or provider secrets to the iOS client.

---

# 6. Financial precision rules

Money and asset quantities must never use JavaScript floating-point arithmetic for authoritative calculations.

Use PostgreSQL `numeric`, and use decimal arithmetic in TypeScript.

Recommended DB precision:

```text
numeric(38, 18)
```

JSON API rules:

- Encode authoritative quantities and money values as decimal strings.
- Decode them into Swift `Decimal`.
- Do not send important monetary values as JSON floating point numbers.
- Store timestamps in UTC.
- Send timestamps as ISO-8601.
- Format values in the iOS layer using the user's locale.

Example:

```json
{
  "quantity": "18.230000000000000000",
  "marketValue": "9483.120000000000000000",
  "currency": "EUR"
}
```

---

# 7. Core domain model

Use UUID primary keys.

The exact SQL may evolve while implementing, but preserve the domain semantics below.

## 7.1 `api_tokens`

Single-user device authentication.

Fields:

- `id`
- `name`
- `token_hash`
- `created_at`
- `last_used_at`
- `revoked_at`

Never store the raw API token.

## 7.2 `accounts`

Represents where assets are held.

Fields:

- `id`
- `name`
- `asset_class`: `crypto | equities | cash | other`
- `source_type`: `manual | hyperliquid | dydx | evm_wallet`
- `institution` nullable
- `base_currency`
- `external_address` nullable
- `external_subaccount` nullable
- `metadata` JSONB
- `sort_order`
- `is_archived`
- `created_at`
- `updated_at`

Examples:

- Hyperliquid
- dYdX
- Ledger
- PEA
- CTO

Do not put a manually typed total balance on this table.

## 7.3 `assets`

Canonical asset registry.

Fields:

- `id`
- `asset_type`: `crypto | equity | etf | cash | perp | other`
- `symbol`
- `name`
- `quote_currency`
- `chain` nullable
- `contract_address` nullable
- `external_ids` JSONB
- `created_at`
- `updated_at`

Do not assume a ticker alone is globally unique.

## 7.4 `transactions`

Explicit ledger events for manual data and normalized provider activity.

Fields:

- `id`
- `account_id`
- `asset_id` nullable where appropriate
- `type`
- `occurred_at`
- `quantity` nullable
- `unit_price` nullable
- `currency`
- `gross_amount` nullable
- `fee_amount` nullable
- `notes` nullable
- `source`
- `external_id` nullable
- `recurrence_occurrence_id` nullable
- `transfer_group_id` nullable
- `is_voided`
- `metadata` JSONB
- `created_at`
- `updated_at`

Initial transaction types:

```text
BUY
SELL
DEPOSIT
WITHDRAWAL
TRANSFER_IN
TRANSFER_OUT
FEE
INCOME
FUNDING
ADJUSTMENT
```

Keep quantities positive. The transaction type determines direction. This is easier to read and audit than mixing signed quantities with semantic transaction types.

Use a uniqueness constraint where possible for provider events:

```text
(source, account_id, external_id)
```

Provider sync must be idempotent.

## 7.5 `recurring_rules`

Represents expected recurring financial behavior.

Fields:

- `id`
- `series_id`
- `account_id`
- `asset_id` nullable
- `transaction_type`
- `input_mode`: `quantity | cash_amount`
- `quantity` nullable
- `cash_amount` nullable
- `currency`
- `cadence`: `weekly | monthly | yearly`
- `interval`
- `weekday` nullable
- `day_of_month` nullable
- `start_on`
- `end_on` nullable
- `auto_post`
- `enabled`
- `supersedes_rule_id` nullable
- `created_at`
- `updated_at`

Do not start with arbitrary cron expressions for investment rules. A simple typed recurrence model is easier to validate and edit correctly.

### Rule versioning

When a recurrence changes from a date forward:

1. End the previous rule immediately before the effective date.
2. Create a new rule with the same `series_id`.
3. Set `supersedes_rule_id`.
4. Preserve history.

Do not mutate the historical meaning of the old rule.

## 7.6 `recurring_occurrences`

Fields:

- `id`
- `rule_id`
- `due_at`
- `status`: `planned | posted | skipped | detached`
- `transaction_id` nullable
- `created_at`
- `updated_at`

Unique on `(rule_id, due_at)`.

Default `auto_post = false`.

Important rule:

- If a recurrence says "invest €500", do not invent the quantity that was actually purchased.
- Generate a planned occurrence and wait for confirmation/reconciliation.
- If a recurrence states an exact quantity, it can only auto-post when the user explicitly enables `auto_post`.

## 7.7 `holding_observations`

This is essential.

A screenshot may prove that an account currently contains 18.23 shares without proving how they were acquired.

Do not invent transactions. Store an observation.

Fields:

- `id`
- `account_id`
- `asset_id`
- `observed_at`
- `quantity`
- `unit_price` nullable
- `market_value` nullable
- `currency`
- `cost_basis` nullable
- `unrealized_pnl` nullable
- `realized_pnl` nullable
- `side` nullable
- `entry_price` nullable
- `leverage` nullable
- `liquidation_price` nullable
- `source`
- `confidence` nullable
- `import_session_id` nullable
- `external_id` nullable
- `metadata` JSONB
- `created_at`

For connected providers, latest provider observations are authoritative for current positions.

For manual accounts, observations are reconciliation evidence against the ledger.

## 7.8 `price_quotes`

Fields:

- `id`
- `asset_id`
- `quoted_at`
- `price`
- `currency`
- `source`
- `metadata` JSONB

Manual equity quotes may come from screenshots in V1.

The UI must visibly indicate stale prices.

## 7.9 `import_sessions`

Fields:

- `id`
- `account_id` nullable
- `status`: `collecting | needs_input | ready_for_review | applied | cancelled | failed`
- `summary` nullable
- `model` nullable
- `created_at`
- `updated_at`

## 7.10 `import_extractions`

Persist structured extraction, not the screenshot itself by default.

Fields:

- `id`
- `import_session_id`
- `artifact_index`
- `extraction` JSONB
- `created_at`

## 7.11 `reconciliation_items`

Fields:

- `id`
- `import_session_id` nullable
- `account_id`
- `asset_id`
- `expected_quantity` nullable
- `observed_quantity` nullable
- `delta_quantity` nullable
- `status`: `open | accepted | ignored | resolved`
- `proposed_action` JSONB nullable
- `change_set_id` nullable
- `created_at`
- `updated_at`

## 7.12 `change_sets`

All financially meaningful AI mutations should flow through this table.

Fields:

- `id`
- `kind`
- `title`
- `summary`
- `status`: `draft | applied | rejected | undone`
- `operations` JSONB
- `inverse_operations` JSONB nullable
- `created_by`: `user | agent | reconciliation | system`
- `created_at`
- `applied_at` nullable
- `undone_at` nullable

Applying a change set must happen in one PostgreSQL transaction.

## 7.13 `audit_log`

Fields:

- `id`
- `actor`: `user | agent | sync | system`
- `action`
- `entity_type`
- `entity_id` nullable
- `change_set_id` nullable
- `before` JSONB nullable
- `after` JSONB nullable
- `created_at`

Keep this simple and useful for debugging/undo.

## 7.14 `sync_runs`

Fields:

- `id`
- `account_id`
- `provider`
- `status`: `running | success | partial | failed`
- `cursor` JSONB nullable
- `error_message` nullable
- `started_at`
- `finished_at` nullable

## 7.15 Portfolio valuation snapshots

Use aligned valuation batches so global charts are easy and fast.

### `valuation_batches`

- `id`
- `captured_at`
- `base_currency`
- `created_at`

### `account_valuations`

- `batch_id`
- `account_id`
- `total_value`
- `net_contributions` nullable
- `realized_pnl` nullable
- `unrealized_pnl` nullable
- `currency`

A global value is the sum of the account valuations in one batch.

Do not try to reconstruct every chart from raw transaction history on every request.

---

# 8. Position calculation rules

Create one portfolio projection service that returns a normalized `PositionView` regardless of source.

Conceptually:

```ts
type PositionView = {
  assetId: string;
  symbol: string;
  name: string;
  assetType: string;
  quantity: DecimalString;
  price?: DecimalString;
  marketValue?: DecimalString;
  currency: string;
  costBasis?: DecimalString;
  unrealizedPnl?: DecimalString;
  realizedPnl?: DecimalString;
  side?: "long" | "short";
  entryPrice?: DecimalString;
  leverage?: DecimalString;
  liquidationPrice?: DecimalString;
  source: string;
  observedAt?: string;
  stale: boolean;
};
```

Rules:

### Manual accounts

- Current expected quantity comes from non-voided ledger transactions.
- Latest observation can be compared to expected quantity.
- An observation does not silently overwrite the ledger.
- If there is no complete ledger yet, an explicit latest observation may be shown as the current position, clearly marked as observed/imported.
- Incomplete cost basis means PnL is unavailable, not guessed.

### Connected external accounts

- Latest provider observation is authoritative for current holdings.
- Provider fills/transactions are activity/history.
- Never require private keys to calculate positions.

---

# 9. Reconciliation engine

Build deterministic reconciliation before adding complex AI behavior.

Example:

```text
Expected from ledger: 32.20 CW8
Observed in screenshot: 30.20 CW8
Difference: -2.00 CW8
```

Produce a reconciliation item.

The application can suggest:

```text
Possible missing SELL of 2 CW8
```

But do not apply it automatically.

Use asset-aware tolerance so tiny decimal noise does not create false mismatches.

The agent may ask:

> I found 2 fewer CW8 than expected. Did you sell 2 shares, or is there another explanation?

A confirmed answer can produce a change set.

---

# 10. Recurrence editing semantics

Support these user intents explicitly:

1. Edit only this occurrence.
2. Skip only this occurrence.
3. Detach this occurrence from the series.
4. Change the series from a given date forward.
5. Stop the series at a given date.
6. Edit the entire series.
7. Correct past generated transactions.

For "from this date forward", split/version the series.

If a change affects historical posted transactions, always create a preview change set.

Example preview:

```text
Recurring CW8

Before
Jan–Aug: €500 / month

After
Jan–May: €500 / month
Jun onward: €700 / month

Affected historical items: 3
Portfolio quantity change: -1.24 shares
```

The preview must show real calculated effects, not only prose from the LLM.

---

# 11. Hyperliquid integration

Implement a dedicated read-only adapter.

Use the public Info API only.

Do not implement any call to the exchange/trading endpoint in the portfolio service.

Store only the public address.

Initial sync should retrieve enough public information for:

- perpetual account state,
- spot balances,
- current positions,
- account value,
- fills/activity,
- historical portfolio data when useful,
- subaccounts when present.

Relevant public Info request types include:

```text
clearinghouseState
spotClearinghouseState
userFills / userFillsByTime
portfolio
subAccounts
```

Use provider cursors/timestamps to avoid repeatedly importing the same history.

Handle provider limits and backoff.

Do not poll aggressively. This is a personal portfolio, not an HFT terminal.

Recommended behavior:

- user-triggered refresh: immediate,
- worker sync: about every 2 minutes for enabled connected accounts,
- Redis short cache: 15–30 seconds,
- valuation snapshots: every 15 minutes.

Normalize provider data into the application's own DTOs. Do not leak Hyperliquid response shapes into SwiftUI.

---

# 12. dYdX integration

Use the public Indexer HTTP API with wallet address + subaccount number.

Read-only operations should cover:

- subaccount state,
- perpetual positions,
- asset positions,
- fills,
- transfers when useful,
- historical PnL when useful.

No signing or trading key is required for the portfolio integration.

Normalize everything into the same account/position/activity model used by Hyperliquid.

Keep the dYdX adapter isolated so API changes do not affect portfolio-domain code.

---

# 13. Public wallet integration — V1

V1 requirement: token balances only, not DeFi positions.

Use Alchemy Portfolio API behind an adapter when `ALCHEMY_API_KEY` is configured.

Default supported networks for V1:

- Ethereum mainnet,
- Base,
- Arbitrum One.

The user enters only a public address.

Retrieve:

- native token balances,
- ERC-20 token balances,
- token metadata,
- prices when returned by the provider.

Do not use wallet/signing APIs.

The adapter must handle partial network failures and clearly mark a sync as partial instead of pretending the missing chain had a zero balance.

If `ALCHEMY_API_KEY` is missing, the app should gracefully disable public-wallet auto-import and explain the required server configuration.

Design the provider interface so a different indexer can be added later.

Do not implement DeFi protocol parsing in V1.

---

# 14. Manual equities / ETF accounts

Do not add fragile broker scraping or unofficial bank login flows.

V1 workflow:

- manual transaction entry,
- manual position observation,
- screenshot import,
- AI-assisted reconciliation,
- recurring rules,
- manual/screenshot price quotes.

A PEA can therefore be represented with explicit lines even if the full transaction history is unavailable initially.

Example:

```text
PEA
├── CW8       18.23 shares · observed Aug 31
├── WPEA      40 shares · observed Aug 31
└── EUR Cash  €842.13 · observed Aug 31
```

If history is later imported, reconcile it against these observations.

---

# 15. Screenshot import and onboarding

This is a core feature, not a generic OCR button.

## 15.1 UX flow

1. User chooses "Import screenshot".
2. User picks one or more screenshots.
3. App creates an import session.
4. Server sends the image(s) to a vision-capable OpenRouter model.
5. Model returns structured candidates.
6. Deterministic validator checks missing/ambiguous fields.
7. If needed, assistant asks a focused question or requests another screenshot.
8. More screenshots can be appended to the same session.
9. Data is merged/reconciled.
10. User sees a final review grouped by account and position/transaction.
11. Applying the review creates a change set and then persists the data.

## 15.2 Image handling

Privacy-oriented defaults:

- Images are uploaded over HTTPS.
- Validate MIME type and image magic bytes.
- Limit upload size.
- Do not accept arbitrary remote image URLs from the user.
- Do not store the original screenshot long-term by default.
- Keep it only as long as required for the OpenRouter request.
- Persist structured extraction + model metadata, not the image bytes.

On iOS:

- Prefer PNG for screenshots when size is reasonable because text remains sharp.
- If too large, resize conservatively and compress without making small financial text unreadable.
- Never resize blindly to a tiny thumbnail.

## 15.3 Extraction schema

Create a typed schema similar to:

```ts
type ImportExtraction = {
  likelyInstitution?: string;
  likelyAccountName?: string;
  capturedAt?: string;
  currency?: string;
  positions: Array<{
    symbol?: string;
    name?: string;
    isin?: string;
    quantity?: string;
    unitPrice?: string;
    marketValue?: string;
    averageCost?: string;
    currency?: string;
    confidence: number;
    evidence?: string;
  }>;
  transactions: Array<{
    type?: "BUY" | "SELL" | "DEPOSIT" | "WITHDRAWAL" | "FEE";
    symbol?: string;
    name?: string;
    occurredAt?: string;
    quantity?: string;
    unitPrice?: string;
    amount?: string;
    fee?: string;
    currency?: string;
    confidence: number;
  }>;
  missingInformation: string[];
  ambiguities: string[];
};
```

The model's output is a candidate, not authoritative data.

## 15.4 Never hallucinate history

If a screenshot shows only:

```text
CW8 — 18.23 shares — €9,483
```

then store an observation if the user confirms it.

Do not invent eighteen historical BUY transactions.

If PnL requires cost basis, show:

```text
Cost basis incomplete
```

and let the onboarding ask for transaction history or another screenshot.

---

# 16. OpenRouter agent architecture

Use OpenRouter from the server only.

No OpenRouter key is compiled into the iOS app.

Environment configuration:

```text
OPENROUTER_API_KEY=
OPENROUTER_MODEL_PRIMARY=
OPENROUTER_MODEL_VISION=
```

Do not hardcode the business logic to a specific model vendor.

The user intentionally wants to use strong models. Optimize for correctness and tool use rather than minimizing every token.

Use direct HTTP via `fetch`; do not add a large agent framework for V1.

OpenRouter supports multimodal inputs and tool/function calling; build a small explicit tool loop yourself.

## 16.1 Agent loop

Conceptually:

```text
User message
  ↓
Load a small amount of relevant finance context
  ↓
Call model with typed tools
  ↓
Execute requested READ tools
  ↓
Return tool results to model
  ↓
If mutation requested: create deterministic proposal/change set
  ↓
Return explanation + change-set ID
```

Set limits:

- max tool iterations per user request,
- request timeout,
- maximum context rows,
- maximum image count/size,
- maximum generated change-set operations.

A runaway tool loop must terminate cleanly.

## 16.2 Agent tools

Implement small typed tools.

### Read tools

Examples:

```text
get_portfolio_overview
list_accounts
get_account
list_positions
list_transactions
list_recurring_rules
get_recurring_rule
list_recurring_occurrences
find_assets
get_reconciliation_items
get_stale_accounts
get_import_session
```

Read tools can run without confirmation.

### Low-risk direct write tools

Only simple reversible metadata changes may execute immediately, with audit + undo support.

Examples:

```text
rename_account
update_account_note
archive_empty_manual_account
```

Be conservative.

### Financial mutation proposal tools

These do not directly mutate the final financial state.

Examples:

```text
propose_create_transaction
propose_update_transaction
propose_void_transaction
propose_create_recurring_rule
propose_change_recurring_rule_from_date
propose_stop_recurring_rule
propose_skip_occurrence
propose_detach_occurrence
propose_apply_reconciliation
propose_create_account_with_positions
```

These produce a `change_set`.

## 16.3 Tool security

The agent has no tool for:

- SQL,
- shell commands,
- arbitrary URL fetches,
- reading environment variables,
- reading API secrets,
- executing crypto trades,
- wallet signing.

Do not expose secrets in agent context.

---

# 17. Global AI chat UX

The AI is not the home screen and not the main navigation tab.

It is a secondary global utility accessible from a subtle toolbar button, for example an SF Symbol such as `sparkles` or another restrained system icon.

Use cases:

```text
"Add these positions from this screenshot."
"I stopped my recurring CW8 investment in June."
"From September it changed from €500 to €700."
"Why doesn't this screenshot match my PEA?"
"Which accounts are stale?"
"Correct the July purchase; it was 3 shares, not 2."
"Show me what changed in my crypto accounts this week."
```

The chat should display tool/action cards inline when useful:

```text
Found recurring rule
CW8 · €500 monthly

Proposed change
Stop from 5 Jun 2026
3 historical generated events affected

[Review changes]
```

Do not make the interface look like a generic chatbot pasted into a finance app.

---

# 18. Change-set behavior and confirmation policy

Use risk-based confirmation.

## No preview required

- Read actions.
- Rename account.
- Update notes/labels.
- Other metadata-only reversible edits.

Show a short Undo affordance when appropriate.

## Preview required

- Creating/deleting/editing financial transactions.
- Retrospective recurring-rule changes.
- Bulk operations.
- Reconciliation that changes holdings/history.
- Deleting data with financial impact.

A change-set review screen must show deterministic before/after data.

The LLM explanation is supplementary; it is not the diff.

---

# 19. API design

Prefix all application endpoints with:

```text
/api/v1
```

Keep endpoints boring and REST-like.

## 19.1 Health / session

```text
GET  /health
GET  /api/v1/session
```

## 19.2 Portfolio

Prefer a coarse dashboard endpoint to minimize mobile round trips:

```text
GET /api/v1/portfolio/dashboard?scope=global&range=1m
GET /api/v1/portfolio/dashboard?scope=crypto&range=1m
GET /api/v1/portfolio/dashboard?scope=equities&range=1m
```

Response should contain enough for the main screen:

- headline total,
- selected-period change,
- chart points,
- allocation,
- account rows,
- freshness metadata.

Do not make the iOS home screen issue ten requests just to render.

## 19.3 Accounts

```text
GET    /api/v1/accounts
POST   /api/v1/accounts
GET    /api/v1/accounts/:id
PATCH  /api/v1/accounts/:id
POST   /api/v1/accounts/:id/sync
GET    /api/v1/accounts/:id/detail?range=1m
```

Archive instead of destructive delete when an account contains history.

## 19.4 Transactions

```text
GET    /api/v1/transactions
POST   /api/v1/transactions
PATCH  /api/v1/transactions/:id
DELETE /api/v1/transactions/:id
```

`DELETE` should normally void a financial transaction rather than erase its audit history.

## 19.5 Recurring

```text
GET  /api/v1/recurring-rules
POST /api/v1/recurring-rules
GET  /api/v1/recurring-rules/:id
POST /api/v1/recurring-rules/:id/change-from-date
POST /api/v1/recurring-rules/:id/stop
POST /api/v1/recurring-occurrences/:id/skip
POST /api/v1/recurring-occurrences/:id/detach
```

## 19.6 Imports

```text
POST /api/v1/imports
GET  /api/v1/imports/:id
POST /api/v1/imports/:id/screenshots
POST /api/v1/imports/:id/message
POST /api/v1/imports/:id/prepare-change-set
```

Use multipart uploads for screenshots.

## 19.7 Change sets

```text
GET  /api/v1/change-sets/:id
POST /api/v1/change-sets/:id/apply
POST /api/v1/change-sets/:id/reject
POST /api/v1/change-sets/:id/undo
```

Make apply idempotent.

## 19.8 Agent

```text
POST /api/v1/agent/conversations
GET  /api/v1/agent/conversations/:id
POST /api/v1/agent/conversations/:id/messages
```

A message may include text and screenshots. Screenshot attachments should reuse the import pipeline rather than duplicate extraction logic.

V1 may use non-streaming responses to keep the implementation simple. Structure the service so SSE can be added later without rewriting the agent/domain layers.

---

# 20. iOS application architecture

Use native SwiftUI with a small explicit app environment.

Example:

```swift
@MainActor
@Observable
final class AppEnvironment {
    let api: APIClient
    let session: SessionStore
    let cache: AppCache
}
```

Use feature-specific observable models where state is non-trivial.

Example:

```swift
@MainActor
@Observable
final class PortfolioModel {
    var state: LoadState<PortfolioDashboard>
    var scope: PortfolioScope
    var range: PortfolioRange

    func load() async { ... }
    func refresh() async { ... }
}
```

Rules:

- Views render state and dispatch intent.
- Networking does not live directly inside view bodies.
- Avoid protocol-per-class ceremony.
- Use actors only where concurrency/isolation is useful.
- Use async/await instead of callback wrappers.
- Avoid Combine unless a system API genuinely needs it.
- Use `NavigationStack`.
- Use standard `TabView` for the bottom app navigation.

---

# 21. iOS navigation

Bottom app navigation:

```text
Portfolio    Activity    Bots    Settings
```

Use native `TabView` and SF Symbols.

Do not put `Global / Crypto / Actions / Other` in the bottom tab bar.

Inside Portfolio, use a top content scope selector:

```text
Global    Crypto    Actions    Other
```

Initial screens:

```text
Portfolio
  ├── Global
  ├── Crypto
  ├── Actions
  └── Other

Global / category
  └── Account
       └── Position / activity detail
```

Hierarchy:

```text
Global → category → account → positions/activity
```

---

# 22. UI design direction

The app must look like an iOS finance application, not a cross-platform dashboard squeezed onto a phone.

## 22.1 General visual language

Use:

- system typography,
- SF Symbols,
- system spacing conventions,
- native navigation bars,
- semantic system backgrounds,
- native materials sparingly,
- Dynamic Type,
- dark and light mode,
- `monospacedDigit()` for amounts that update,
- native haptics for meaningful selections/actions,
- simple transitions.

Do not use:

- web-dashboard cards everywhere,
- heavy borders,
- neon crypto-terminal aesthetics,
- tiny dense tables,
- excessive gradients,
- glass blur on every surface,
- giant decorative headings,
- random shadows.

The financial data is the visual focus.

## 22.2 Grok-inspired top tabs

For the `Global / Crypto / Actions / Other` selector, take inspiration from the compact content-tab treatment used in modern Grok iOS interfaces:

- horizontally arranged labels,
- compact height,
- strong selected state,
- subtle native material or restrained capsule/indicator,
- no large old-style segmented-control chrome,
- smooth selection transition,
- horizontal scrolling if future categories exceed the width,
- preserve native iOS touch targets.

Implement a reusable `PortfolioScopePicker` in SwiftUI.

Use `matchedGeometryEffect` only if it makes the selection movement cleaner. Do not build a large custom paging framework.

## 22.3 Finance-chart inspiration

For charts, take inspiration from polished iOS finance apps such as Copilot/Delta and Apple's own chart interaction patterns:

- large readable value above the chart,
- understated line,
- subtle area fill,
- period selector directly below,
- interactive scrubbing,
- selected date/value shown while dragging,
- chart should feel responsive rather than decorative.

Use Swift Charts only.

---

# 23. Portfolio Global screen

Build this first and make it excellent.

Conceptual layout:

```text
Portfolio                                      [AI]

Global     Crypto     Actions     Other
──────

€73,420.18
+€1,240.31 · +1.72%                      1M

[ interactive portfolio chart ]

1D    1W    1M    3M    1Y    ALL

Allocation
Crypto                                     42%
Actions                                    38%
Other                                      20%

Accounts

CRYPTO
Hyperliquid                            €18,241
Ledger                                 €10,620
dYdX                                    €2,140

ACTIONS
PEA                                    €27,840
CTO                                     €4,030
```

This is a conceptual information hierarchy, not a request for bordered cards around every section.

## Headline

Show:

- current portfolio value,
- absolute change for selected range,
- percentage change for selected range.

The period selection must drive both the chart and headline delta.

## Allocation

Use a compact allocation presentation. Start simple with rows + percentage; do not force a donut chart if it reduces readability.

## Accounts

Group by category.

Each row:

- icon/monogram,
- name,
- optional freshness/source subtitle,
- current value,
- optional selected-period delta.

Tap pushes account detail.

---

# 24. Category screens

`Crypto` and `Actions` use the same screen component configured by scope.

At top:

- category value,
- selected-period performance,
- chart.

Then a small mode selector:

```text
Accounts    Assets
```

Default to `Accounts`.

Accounts mode answers:

> Where is my money?

Assets mode answers:

> What do I own across accounts?

Do not duplicate separate screen implementations for Crypto and Actions unless their data genuinely diverges.

---

# 25. Account detail screen

Information order:

1. Account name/source/freshness.
2. Current value.
3. Performance/PnL when available.
4. Chart.
5. Positions.
6. Recent activity.

Concept:

```text
‹ Crypto                              Hyperliquid

€18,241.82
+$2,103.42 · +13.03%

Balance     Returns
───────

[ chart ]

Positions

BTC-PERP
Long 0.082 BTC                         €9,122
+14.4%

HYPE
183.42 HYPE                            €5,420
+8.2%

USDC                                     €3,699

Recent activity
Today       Funding                     -$2.18
Yesterday   BTC fill                  +0.01 BTC
```

For manual accounts, show source/freshness:

```text
Last reconciled Aug 31
Source: screenshot
```

If return cannot be calculated:

```text
Return unavailable — incomplete cost basis
```

Do not fake it.

---

# 26. Swift Charts implementation requirements

Create reusable components:

```text
PortfolioValueChart
ChartRangePicker
ChartScrubOverlay
```

Ranges:

```text
1D
1W
1M
3M
1Y
ALL
```

Features:

- `LineMark`.
- Optional subtle `AreaMark` gradient.
- Drag/scrub selection using native Swift Charts selection APIs where possible.
- `RuleMark` / point indicator for current scrub selection.
- Selected value and timestamp update above the chart.
- VoiceOver descriptions.
- No hardcoded screen widths.
- Do not animate every incoming data point.
- Smooth animation only when changing scope/range if it remains readable.

For the Global chart, provide a secondary option later for `Portfolio Value` vs `Net Invested`, but do not clutter the first milestone. The data model must support `net_contributions` now.

---

# 27. Activity screen

Provide a unified chronological activity feed.

Sources can include:

- manual transactions,
- screenshot-created transactions,
- recurring occurrences,
- Hyperliquid fills/funding,
- dYdX fills/transfers,
- reconciliation actions.

Filters:

- All
- Account
- Asset class
- Source

External provider events are read-only.

Manual events may be edited/voided.

Use source badges subtly; do not turn every row into a colored pill collection.

---

# 28. Manual entry UX

Provide a clear `+` action from Portfolio/Activity.

Options:

```text
Import screenshot
Add account
Add transaction
Add position observation
Add recurring investment
Connect Hyperliquid
Connect dYdX
Connect public wallet
```

Manual transaction form should expose explicit fields and good defaults.

Do not ask for irrelevant fields.

Example BUY:

- account,
- asset,
- date/time,
- quantity,
- unit price,
- currency,
- fee optional,
- notes optional.

---

# 29. Fast perceived performance

The app is private and small, so optimize sensibly rather than prematurely.

## Server

- Redis cache assembled portfolio dashboard responses for roughly 15 seconds.
- Cache provider metadata/prices with appropriate short TTLs.
- Invalidate relevant dashboard keys after writes/syncs.
- Add DB indexes for account/date/provider external IDs.
- Avoid N+1 queries.
- Build coarse endpoints for screens.
- Use provider time cursors for incremental sync.

## iOS

Implement a tiny local JSON cache actor for the last successful screen payloads.

On screen open:

1. Render last cached dashboard immediately if present.
2. Start server refresh.
3. Replace with fresh response.
4. Show stale timestamp when appropriate.

Do not build a complex offline sync engine in V1.

The backend remains source of truth.

---

# 30. Authentication for a private one-user app

Do not build OAuth, user registration, email/password reset, organizations, roles, or multi-tenancy.

Use a long random bearer token per device.

## Server behavior

Create a CLI command such as:

```text
npm run token:create -- --name "My iPhone"
```

It should:

1. Generate at least 32 random bytes.
2. Print the raw token once.
3. Store only a SHA-256 hash in `api_tokens`.
4. Allow tokens to be revoked/rotated later.

Incoming request:

```text
Authorization: Bearer <token>
```

Hash the received token and look up an active matching token.

Update `last_used_at` asynchronously / without creating unnecessary DB contention.

## iOS behavior

- First launch asks for server URL and token.
- Store token in Keychain.
- Store server URL in app preferences.
- Provide "Test connection".
- Provide logout/remove credentials.

A QR pairing flow can be added later. Do not delay V1 for it.

---

# 31. Server security baseline

This is a private VPS project, but do the basics correctly.

Required:

- HTTPS via Caddy.
- API token auth.
- PostgreSQL not exposed publicly.
- Redis not exposed publicly.
- OpenRouter key server-side only.
- Alchemy key server-side only.
- `.env` excluded from git.
- `.env.example` contains names, never secrets.
- Docker services run as non-root where practical.
- Request body limits.
- Multipart image size limits.
- MIME/magic-byte validation.
- Security headers with Fastify helmet.
- Reasonable API rate limit.
- Parameterized DB access through Drizzle/driver.
- Structured logging with secret redaction.
- No provider private key fields in the portfolio DB schema.
- Never log bearer tokens.
- Never log full OpenRouter request bodies when images or financial context are present.

CORS is not required for the native app. Keep browser exposure closed unless a web frontend is intentionally added later.

---

# 32. Docker Compose deployment

Create a production-friendly but simple `compose.yaml` with:

```text
caddy
api
worker
postgres
redis
```

Do not expose PostgreSQL or Redis host ports.

Suggested image lines at creation time should use stable pinned releases, for example:

```text
node:24-bookworm-slim
postgres:18-alpine
redis:8-alpine
caddy:2-alpine
```

Use exact stable tags available when implementing rather than `latest`.

Use named volumes:

```text
postgres_data
redis_data
caddy_data
caddy_config
```

`api` and `worker` may use the same server image with different commands.

Example responsibilities:

```text
api     -> HTTP requests + agent/imports
worker  -> provider sync + recurring occurrence materialization + valuation snapshots
```

Add health checks.

The API should listen internally on port 3000.

Caddy should be the only public-facing service.

---

# 33. Caddy

Use an environment-driven domain.

Conceptual Caddyfile:

```text
{$APP_DOMAIN} {
    encode zstd gzip
    reverse_proxy api:3000
}
```

Document DNS requirements.

For local/VPS IP testing before a domain is available, document an HTTP-only development compose override rather than weakening production TLS configuration.

---

# 34. Worker scheduling

Keep it simple.

A single worker process can run small scheduled tasks. Do not add Kafka, RabbitMQ, Temporal, BullMQ, or Kubernetes.

Use a small scheduler library or straightforward timers with PostgreSQL/Redis locks.

Suggested jobs:

```text
Every ~2 min   Sync enabled Hyperliquid/dYdX/wallet accounts
Every 15 min   Create aligned valuation batch
Daily          Materialize upcoming recurring occurrences
Daily          Cleanup expired transient import files
```

Also materialize recurrence occurrences lazily when a relevant endpoint is read so a missed worker run cannot permanently lose an occurrence.

Use a lock so accidental double worker instances do not duplicate jobs.

All jobs must be idempotent.

---

# 35. Backups

Create `deploy/backup.sh` and `make backup`.

Use `pg_dump` in a compressed format.

Document a basic restore command.

Do not back up Redis as the authoritative store; Redis is cache/coordination only.

Do not put raw API tokens or `.env` content into normal database backups.

Document that the user should copy database backups off the VPS periodically.

---

# 36. Redis responsibilities

Redis is optional infrastructure for speed/coordination, never the source of truth.

Use it for:

- short dashboard cache,
- provider metadata/price cache,
- worker locks,
- lightweight rate limiting if useful.

Do not store authoritative portfolio state only in Redis.

The app should still function, more slowly, if Redis is temporarily unavailable where practical.

---

# 37. Bots area and security boundary

The main finance application should already have a `Bots` tab because this is part of the user's intended workflow, but V1 must remain paper-only.

## V1 Bots scope

Provide:

- bot records,
- enabled/disabled state,
- schedule,
- allocated paper capital,
- run history,
- paper PnL fields,
- error state,
- last run / next run.

Tables can be simple:

```text
bots
bot_runs
paper_orders
```

Do not create a generic trading platform.

A bot runner interface may look like:

```ts
interface PaperStrategy {
  id: string;
  evaluate(context: StrategyContext): Promise<PaperDecision[]>;
}
```

It is acceptable for the first working milestone to have infrastructure + a no-trade/heartbeat sample strategy proving scheduled execution and run history.

## Future live trading boundary

Document, but do not implement, the future boundary:

```text
Portfolio API
  NO TRADING KEYS
        │
        └── read-only data

Separate bot worker / compose profile
  dedicated trading credential
  limited capital
  no access to main wallet seed phrase
```

Never add a main-wallet private key field "for later".

Never allow the AI finance agent to execute trading tools.

---

# 38. Settings screen

Keep it utilitarian.

Sections:

## Server

- server URL,
- connection status,
- last successful sync,
- test connection.

## Integrations

- Hyperliquid accounts,
- dYdX accounts,
- public wallets,
- manual accounts.

## AI

Show server-reported status only:

- OpenRouter configured: yes/no,
- primary model name,
- vision model name.

Do not reveal the API key.

## Data

- force refresh,
- export JSON/CSV later,
- diagnostics,
- app version.

---

# 39. Environment variables

Create `.env.example` similar to:

```dotenv
# Public deployment
APP_DOMAIN=finance.example.com
APP_BASE_URL=https://finance.example.com
PORT=3000
LOG_LEVEL=info
TZ=Europe/Paris

# Database
POSTGRES_DB=finance
POSTGRES_USER=finance
POSTGRES_PASSWORD=change-me
DATABASE_URL=postgresql://finance:change-me@postgres:5432/finance

# Redis
REDIS_URL=redis://redis:6379

# AI
OPENROUTER_API_KEY=
OPENROUTER_MODEL_PRIMARY=
OPENROUTER_MODEL_VISION=

# Optional public-wallet indexer
ALCHEMY_API_KEY=
ALCHEMY_NETWORKS=eth-mainnet,base-mainnet,arb-mainnet

# Runtime
MAX_UPLOAD_MB=12
DASHBOARD_CACHE_SECONDS=15
PROVIDER_SYNC_SECONDS=120
VALUATION_INTERVAL_MINUTES=15
```

Do not add dozens of flags before they are needed.

---

# 40. Main server services

Implement clear services instead of giant route handlers.

At minimum:

```text
AuthService
AccountService
PortfolioService
LedgerService
RecurringService
ReconciliationService
ImportService
AgentService
ChangeSetService
SnapshotService
SyncService
```

Provider adapters:

```text
HyperliquidAdapter
DydxAdapter
AlchemyPortfolioAdapter
```

No inheritance hierarchy is needed. Plain objects/functions/classes are fine.

---

# 41. Provider adapter contract

Use a tiny interface such as:

```ts
interface ReadOnlyAccountProvider {
  readonly kind: string;

  syncAccount(account: Account): Promise<ProviderSyncResult>;
}
```

`ProviderSyncResult` should return normalized:

- positions/observations,
- transactions/activity,
- account metadata,
- cursor,
- warnings/partial failures.

Do not force providers into methods they do not support.

Do not create a huge universal exchange SDK abstraction.

---

# 42. Portfolio API DTO

Create a DTO that matches screen needs.

Example shape:

```ts
type PortfolioDashboard = {
  scope: "global" | "crypto" | "equities" | "other";
  range: "1d" | "1w" | "1m" | "3m" | "1y" | "all";
  currency: string;
  value: string;
  absoluteChange?: string;
  percentChange?: string;
  asOf: string;
  chart: Array<{
    at: string;
    value: string;
    netContributions?: string;
  }>;
  allocation: Array<{
    key: string;
    label: string;
    value: string;
    percentage: string;
  }>;
  accounts: Array<{
    id: string;
    name: string;
    assetClass: string;
    sourceType: string;
    value: string;
    absoluteChange?: string;
    percentChange?: string;
    asOf?: string;
    stale: boolean;
  }>;
};
```

Mirror this cleanly in Swift `Codable` types.

---

# 43. Local iOS cache

Do not use SwiftData just to cache API responses in V1.

Use a small `AppCache` actor that stores selected `Codable` responses under Application Support.

Example keys:

```text
portfolio-global-1m
portfolio-crypto-1m
account-<id>-1m
```

Cache is disposable.

Auth token remains in Keychain, never in this cache.

---

# 44. Empty/loading/error states

Treat these as product UI, not afterthoughts.

## Initial empty portfolio

Show a calm onboarding screen:

```text
Your portfolio is empty

Connect a read-only crypto account or add positions manually.

[Connect Hyperliquid]
[Import screenshot]
[Add manually]
```

## Loading

If cached data exists, keep it visible and show a subtle refresh state.

Avoid full-screen spinners after the first successful load.

## Provider error

Keep last known values visible with a stale state:

```text
Hyperliquid
€18,241
Last updated 18 min ago
Refresh failed
```

Do not turn a temporary provider error into a fake zero balance.

---

# 45. Accessibility and formatting

Required:

- Dynamic Type.
- VoiceOver labels on charts and amount changes.
- Minimum touch target sizes.
- Do not communicate gain/loss by color alone.
- Respect Reduce Motion.
- Locale-aware number formatting.
- User's display currency starts as EUR but is not hardcoded throughout the domain.
- Use `monospacedDigit()` where numeric alignment improves readability.

---

# 46. Logging and diagnostics

Use structured logs.

Useful fields:

```text
requestId
accountId
provider
syncRunId
importSessionId
changeSetId
agentConversationId
```

Redact:

- Authorization header,
- API tokens,
- OpenRouter key,
- Alchemy key,
- uploaded image bodies,
- model messages containing full financial context unless explicit debug mode is locally enabled.

Add a small diagnostics endpoint or settings screen showing:

- API version,
- DB reachable,
- Redis reachable,
- worker last heartbeat,
- provider config yes/no,
- AI config yes/no.

Do not expose secrets.

---

# 47. Testing strategy

Do not aim for arbitrary coverage percentages. Test financial behavior and integration boundaries.

## Backend unit tests

Must cover:

- BUY/SELL quantity projection.
- Voided transaction handling.
- Recurring occurrence generation.
- Rule split from effective date.
- Skip/detach occurrence.
- Reconciliation delta.
- Change-set apply and undo.
- Decimal precision.
- Provider idempotency mapping.
- Partial provider failure handling.
- Agent tool authorization boundaries.

## Backend integration tests

Use a real PostgreSQL test DB where feasible.

Must cover:

- token authentication,
- create manual account + transaction,
- dashboard projection,
- recurring edit transactionality,
- screenshot extraction fixture -> review -> apply,
- duplicate provider event import does not duplicate transactions.

Mock external providers at the HTTP boundary.

## iOS tests

At minimum:

- Decimal DTO decoding.
- Portfolio range behavior.
- formatting.
- URL construction/auth header.
- selected view-model state transitions.

Use SwiftUI previews with realistic fixtures for every major screen.

---

# 48. Seed/demo mode for development

Create a dev-only seed command.

Example data:

```text
Hyperliquid       €18,241
Ledger            €10,620
dYdX               €2,140
PEA               €27,840
CTO                €4,030
```

Positions:

```text
BTC
ETH
HYPE
USDC
CW8
WPEA
EUR Cash
```

Include:

- a recurring CW8 rule,
- one skipped occurrence,
- one reconciliation mismatch,
- 90 days of valuation snapshots,
- activity events.

This exists only for previews/local development. Production must start empty.

---

# 49. Makefile / developer commands

Provide concise commands:

```text
make dev
make up
make down
make logs
make migrate
make seed
make token
make test
make backup
make ios-generate
```

The README should make the happy path obvious.

---

# 50. README deployment flow

Document the exact VPS path.

Expected flow:

```text
1. Install Docker + Docker Compose plugin.
2. Clone repository.
3. Copy .env.example to .env.
4. Set APP_DOMAIN, database password, optional provider/API keys.
5. Point DNS to VPS.
6. docker compose build
7. docker compose up -d
8. run migrations
9. create iPhone API token
10. enter server URL + token in iOS app
```

Also document:

- update procedure,
- backup command,
- restore procedure,
- log command,
- token revoke/rotate command.

---

# 51. Implementation phases

Implement in this order. Do not attempt every future feature simultaneously.

## Phase 1 — repository + backend foundation

Deliver:

- repository structure,
- TypeScript strict config,
- Fastify app,
- config validation,
- PostgreSQL + migrations,
- Redis connection,
- auth token CLI/middleware,
- Dockerfile,
- Compose,
- Caddy,
- health endpoint,
- tests running.

Acceptance:

```text
make up
```

starts the stack and:

```text
GET /health
```

returns healthy.

## Phase 2 — manual finance core

Deliver:

- accounts,
- assets,
- transactions,
- position projection,
- valuation snapshots,
- portfolio dashboard endpoint,
- recurring rules/occurrences,
- reconciliation core,
- change sets + undo,
- seed fixtures.

Acceptance:

A seeded portfolio returns correct global/category/account values.

## Phase 3 — native iOS shell + portfolio

Deliver:

- XcodeGen project,
- connection onboarding,
- Keychain auth token,
- bottom tabs,
- Grok-inspired portfolio scope picker,
- Global screen,
- category screen,
- account detail,
- Swift Charts interactions,
- local response cache,
- refresh/error states.

Acceptance:

The app launches against the Docker backend and renders seeded data with functional navigation/chart range selection.

## Phase 4 — read-only crypto integrations

Deliver:

- Hyperliquid adapter,
- dYdX adapter,
- Alchemy public-wallet adapter,
- account connect forms,
- manual sync,
- worker sync,
- idempotency,
- stale/error states.

Acceptance:

A public address can be configured without any signing/private key and current positions appear in the app.

## Phase 5 — screenshot onboarding

Deliver:

- Photos picker,
- multipart upload,
- OpenRouter vision extraction,
- import session state machine,
- deterministic validation,
- follow-up question flow,
- additional screenshot flow,
- final review,
- change set apply,
- reconciliation.

Acceptance:

A realistic brokerage screenshot fixture can create explicit position observations after user review, without inventing missing history.

## Phase 6 — global finance agent

Deliver:

- chat sheet/screen,
- conversations/messages,
- typed read tools,
- financial proposal tools,
- change-set cards,
- review/apply flow,
- audit log,
- safety limits.

Acceptance:

The user can type:

```text
I stopped my recurring CW8 investment in June.
```

and receive a deterministic proposed recurrence change with affected events before applying it.

## Phase 7 — Activity + Bots shell

Deliver:

- unified Activity tab,
- filters,
- paper-only Bot records/runs,
- cron worker plumbing,
- Bots overview UI,
- no live trading.

Acceptance:

A disabled-by-default sample paper/heartbeat bot can run on schedule and show its run history without possessing a trading key.

---

# 52. Definition of done for V1

V1 is done when all of these are true:

## Finance

- Global portfolio total is derived from explicit positions/observations.
- Crypto and equities category views work.
- Account drill-down works.
- Manual transactions work.
- Recurring rules work.
- Past recurrence changes are versioned correctly.
- Reconciliation can detect a holdings mismatch.
- Unknown cost basis remains unknown.

## Crypto

- Hyperliquid uses public read-only data.
- dYdX uses public read-only data.
- Public EVM wallet support works when Alchemy is configured.
- No seed phrase/private key/trading credential is accepted by the portfolio API.

## AI

- Screenshot import works through OpenRouter.
- Multiple screenshots can be added to one onboarding session.
- Missing data produces focused follow-up questions.
- Global agent can read finance data via tools.
- Financial writes produce change sets.
- Agent cannot access secrets or trading functions.

## iOS

- Native SwiftUI look.
- Global/Crypto/Actions scope selector feels compact and modern.
- Swift Charts are interactive.
- Dark/light mode work.
- Cached dashboard appears quickly.
- Stale provider data is clearly marked.

## Deployment

- One `docker compose up -d` starts the production services after configuration.
- HTTPS works through Caddy.
- DB/Redis are not public.
- Token auth works.
- Backup/restore is documented.

---

# 53. Explicit non-goals for V1

Do not implement:

- multi-user accounts,
- social login,
- bank credential scraping,
- Plaid/open-banking integration,
- automatic broker authorization,
- DeFi protocol positions,
- NFTs,
- tax reporting,
- financial advice/recommendations,
- news feeds,
- social features,
- live trading,
- wallet signing,
- seed phrase storage,
- exchange private keys in the portfolio API,
- arbitrary agent shell/web access,
- complex realtime WebSocket architecture,
- Kubernetes,
- microservices.

---

# 54. Code-quality constraints for Codex

Follow these while implementing.

## TypeScript

- `strict: true`.
- No `any` unless isolated around an untyped third-party response and immediately validated/mapped.
- Validate external provider responses before trusting important fields.
- Use named domain types for money/quantity strings.
- Keep functions short when separation improves comprehension, not just to satisfy a metric.
- Avoid generic utility dumping grounds.
- Keep provider-specific parsing inside provider modules.
- Prefer domain names over abbreviations.

## Swift

- Prefer structs for DTO/value types.
- Prefer `@Observable` feature models.
- `@MainActor` UI models.
- No `ObservableObject`/Combine unless required by compatibility.
- No force unwraps in production paths.
- No giant 1,000-line SwiftUI views.
- Extract reusable view components after repetition appears, not before.
- Keep formatting helpers centralized.
- Keep API DTOs separate from view-specific derived state when useful.

## Database

- Migrations committed.
- Foreign keys.
- Relevant uniqueness constraints.
- Relevant indexes.
- Financial deletes usually become void/archive operations.
- Never rely on Redis for correctness.

---

# 55. UX implementation constraints for Codex

Do not interpret "modern" as adding more decoration.

The desired feel is:

```text
native iOS
fast
quiet
precise
high-information but not dense
finance-first
```

Use whitespace and hierarchy rather than boxes.

Use a card only when the grouping genuinely benefits from a contained surface.

Prefer:

```text
Section title
Row
Row
Row
```

instead of:

```text
Card
  Card
    Row
```

For amounts:

- most important value = large title/rounded style,
- secondary deltas = smaller semantic text,
- row values = aligned/trailing,
- avoid excessive decimal places in UI,
- retain full precision in data.

---

# 56. Important financial correctness cases

Before declaring the project complete, manually/test verify these cases.

## Case A — opaque total prohibited

Attempt to create a manual account with only `total = 10000`.

Expected:

The domain/API rejects this as an unsupported manual balance representation. The user must add explicit cash/position lines.

## Case B — screenshot without history

Screenshot says:

```text
CW8 18.23 shares €9,483
```

Expected:

- create/offer a holding observation,
- do not invent purchases,
- PnL marked unavailable if average cost missing.

## Case C — recurring amount change

Rule:

```text
€500 CW8 monthly Jan onward
```

User says:

```text
From June it became €700.
```

Expected:

- old rule ends before June effective occurrence,
- new rule starts in June,
- same series ID,
- historical effects previewed before changing posted events.

## Case D — recurring rule left running too long

User says:

```text
I actually stopped this in April.
```

Expected:

- future planned occurrences removed/skipped appropriately,
- generated historical posted events after April are listed in change-set preview,
- no silent deletion.

## Case E — provider outage

Hyperliquid temporarily fails.

Expected:

- last known account value remains visible,
- stale timestamp appears,
- no zero balance inserted.

## Case F — duplicate sync

Same dYdX fill arrives twice.

Expected:

One normalized transaction only.

## Case G — agent hallucination

User asks:

```text
What did I pay for these shares?
```

and cost basis is not stored.

Expected:

Agent states that the information is missing and may ask for another screenshot/history. It does not infer a fake purchase price from current market value.

---

# 57. First Codex execution instructions

When starting from an empty repository:

1. Create the directory structure.
2. Create `docs/architecture.md` with a concise summary of the architecture from this blueprint.
3. Implement Phase 1 completely.
4. Run the backend tests.
5. Bring Docker Compose up and verify health.
6. Implement Phase 2.
7. Seed demo data and verify dashboard math with tests.
8. Generate the iOS project and implement Phase 3.
9. Build the iOS project with `xcodebuild` if running on macOS.
10. Continue through later phases only after the earlier vertical slice works.

Do not spend the first pass creating placeholder files for every future feature.

A directory should exist because code is being added to it, not because a diagram mentioned it.

---

# 58. Required final output from Codex

When the implementation pass is complete, provide a concise report containing:

```text
Implemented
- ...

Architecture decisions
- ...

How to run locally
- ...

How to deploy to VPS
- ...

How to generate a device token
- ...

How to configure Hyperliquid/dYdX/wallet accounts
- ...

How to configure OpenRouter
- ...

Tests/builds run
- ...

Known V1 limitations
- ...
```

Do not claim something is working unless it was implemented and, where possible, built/tested.

---

# 59. Product north star

The final application should feel like this:

> Open the iPhone app and immediately understand the state of all investment accounts. Drill into Crypto, Actions, then a specific account. Every number has a clear source. Connected crypto data is read-only. Manual assets are explicit lines, not magic totals. Screenshots make data entry fast. Recurring investments can be corrected retroactively. A global AI assistant can organize and repair data through typed tools without becoming the main interface or obtaining trading power.

If an implementation choice conflicts with that statement, prefer the statement.

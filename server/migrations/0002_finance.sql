CREATE TYPE asset_class AS ENUM ('crypto','equities','cash','other');
CREATE TYPE source_type AS ENUM ('manual','hyperliquid','dydx','evm_wallet');
CREATE TYPE asset_type AS ENUM ('crypto','equity','etf','cash','perp','other');
CREATE TYPE transaction_type AS ENUM ('BUY','SELL','DEPOSIT','WITHDRAWAL','TRANSFER_IN','TRANSFER_OUT','FEE','INCOME','FUNDING','ADJUSTMENT');
CREATE TABLE accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, asset_class asset_class NOT NULL,
 source_type source_type NOT NULL, institution text, base_currency text NOT NULL,
 external_address text, external_subaccount integer, metadata jsonb NOT NULL DEFAULT '{}',
 sort_order integer NOT NULL DEFAULT 0, is_archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (source_type='manual' OR external_address IS NOT NULL)
);
CREATE TABLE assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_type asset_type NOT NULL, symbol text NOT NULL,
 name text NOT NULL, quote_currency text NOT NULL, chain text, contract_address text,
 external_ids jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX assets_contract ON assets(chain,lower(contract_address)) WHERE contract_address IS NOT NULL;
CREATE TABLE recurring_rules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), series_id uuid NOT NULL, account_id uuid NOT NULL REFERENCES accounts(id),
 asset_id uuid REFERENCES assets(id), transaction_type transaction_type NOT NULL,
 input_mode text NOT NULL CHECK (input_mode IN ('quantity','cash_amount')),
 quantity numeric(38,18), cash_amount numeric(38,18), currency text NOT NULL,
 cadence text NOT NULL CHECK (cadence IN ('weekly','monthly','yearly')), interval integer NOT NULL DEFAULT 1 CHECK (interval > 0),
 weekday integer CHECK (weekday BETWEEN 0 AND 6), day_of_month integer CHECK (day_of_month BETWEEN 1 AND 31),
 start_on date NOT NULL, end_on date, auto_post boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true,
 supersedes_rule_id uuid REFERENCES recurring_rules(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (end_on IS NULL OR end_on >= start_on),
 CHECK ((input_mode='quantity' AND quantity > 0 AND cash_amount IS NULL) OR (input_mode='cash_amount' AND cash_amount > 0 AND quantity IS NULL)),
 CHECK (NOT auto_post OR input_mode='quantity')
);
CREATE INDEX recurring_rules_series ON recurring_rules(series_id,start_on);
CREATE TABLE recurring_occurrences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rule_id uuid NOT NULL REFERENCES recurring_rules(id), due_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','posted','skipped','detached')), transaction_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(rule_id,due_at)
);
CREATE TABLE transactions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id), asset_id uuid REFERENCES assets(id),
 type transaction_type NOT NULL, occurred_at timestamptz NOT NULL, quantity numeric(38,18) CHECK(quantity > 0),
 unit_price numeric(38,18) CHECK(unit_price >= 0), currency text NOT NULL, gross_amount numeric(38,18) CHECK(gross_amount >= 0),
 fee_amount numeric(38,18) CHECK(fee_amount >= 0), notes text, source text NOT NULL, external_id text,
 recurrence_occurrence_id uuid REFERENCES recurring_occurrences(id), transfer_group_id uuid, is_voided boolean NOT NULL DEFAULT false,
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source,account_id,external_id), CHECK (asset_id IS NOT NULL AND quantity IS NOT NULL)
);
ALTER TABLE recurring_occurrences ADD CONSTRAINT occurrence_transaction_fk FOREIGN KEY(transaction_id) REFERENCES transactions(id);
CREATE INDEX transactions_account_date ON transactions(account_id,occurred_at);
CREATE UNIQUE INDEX transactions_occurrence ON transactions(recurrence_occurrence_id) WHERE recurrence_occurrence_id IS NOT NULL AND NOT is_voided;
CREATE TABLE holding_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id), asset_id uuid NOT NULL REFERENCES assets(id),
 observed_at timestamptz NOT NULL, quantity numeric(38,18) NOT NULL CHECK(quantity >= 0), unit_price numeric(38,18) CHECK(unit_price >= 0),
 market_value numeric(38,18), currency text NOT NULL, cost_basis numeric(38,18), unrealized_pnl numeric(38,18), realized_pnl numeric(38,18),
 side text CHECK(side IN ('long','short')), entry_price numeric(38,18), leverage numeric(38,18), liquidation_price numeric(38,18),
 source text NOT NULL, confidence numeric(5,4) CHECK(confidence BETWEEN 0 AND 1), import_session_id uuid, external_id text,
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observations_latest ON holding_observations(account_id,asset_id,observed_at DESC);
CREATE TABLE price_quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_id uuid NOT NULL REFERENCES assets(id), quoted_at timestamptz NOT NULL,
 price numeric(38,18) NOT NULL CHECK(price >= 0), currency text NOT NULL, source text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX price_quotes_latest ON price_quotes(asset_id,quoted_at DESC);
CREATE TABLE change_sets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, title text NOT NULL, summary text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','applied','rejected','undone')),
 operations jsonb NOT NULL, inverse_operations jsonb, created_by text NOT NULL CHECK(created_by IN ('user','agent','reconciliation','system')),
 created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz, undone_at timestamptz
);
CREATE TABLE reconciliation_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), import_session_id uuid, account_id uuid NOT NULL REFERENCES accounts(id),
 asset_id uuid NOT NULL REFERENCES assets(id), expected_quantity numeric(38,18), observed_quantity numeric(38,18), delta_quantity numeric(38,18),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','accepted','ignored','resolved')), proposed_action jsonb,
 change_set_id uuid REFERENCES change_sets(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reconciliation_open ON reconciliation_items(account_id,asset_id) WHERE status='open';
CREATE TABLE audit_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor text NOT NULL CHECK(actor IN ('user','agent','sync','system')),
 action text NOT NULL, entity_type text NOT NULL, entity_id uuid, change_set_id uuid REFERENCES change_sets(id),
 before jsonb, after jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE valuation_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), captured_at timestamptz NOT NULL, base_currency text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(captured_at,base_currency)
);
CREATE TABLE account_valuations (
 batch_id uuid NOT NULL REFERENCES valuation_batches(id), account_id uuid NOT NULL REFERENCES accounts(id),
 total_value numeric(38,18) NOT NULL, net_contributions numeric(38,18), realized_pnl numeric(38,18), unrealized_pnl numeric(38,18),
 currency text NOT NULL, PRIMARY KEY(batch_id,account_id)
);

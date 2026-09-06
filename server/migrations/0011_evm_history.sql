-- Existing snapshots remain complete; new captures explicitly describe coverage.
ALTER TABLE account_valuations ADD COLUMN complete boolean NOT NULL DEFAULT true;
ALTER TABLE account_valuations ADD COLUMN coverage jsonb NOT NULL DEFAULT '{}';
CREATE TABLE evm_history_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','paused','complete','partial','failed')),
 phase text NOT NULL DEFAULT 'discovery', cursor jsonb NOT NULL DEFAULT '{}',
 end_at timestamptz NOT NULL DEFAULT date_trunc('day',now()), days_done integer NOT NULL DEFAULT 0,
 request_day date NOT NULL DEFAULT CURRENT_DATE, requests_used integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(), error text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE evm_history_cache (
 key text PRIMARY KEY, value jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX evm_history_cache_expiry ON evm_history_cache(expires_at);
CREATE TABLE evm_balance_history (
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, network text NOT NULL,
 token text NOT NULL, at timestamptz NOT NULL, block_number text NOT NULL,
 quantity numeric(38,18), price numeric(38,18), price_at timestamptz,
 issue text, source text NOT NULL DEFAULT 'alchemy',
 PRIMARY KEY(account_id,network,token,at)
);
CREATE TABLE evm_account_history (
 account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, at timestamptz NOT NULL,
 value numeric(38,18) NOT NULL, currency text NOT NULL DEFAULT 'USD',
 complete boolean NOT NULL, coverage jsonb NOT NULL, source text NOT NULL DEFAULT 'alchemy_dated_balances',
 PRIMARY KEY(account_id,at)
);

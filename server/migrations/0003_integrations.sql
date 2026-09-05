CREATE TABLE sync_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES accounts(id), provider text NOT NULL,
 status text NOT NULL CHECK(status IN ('running','success','partial','failed')), cursor jsonb, error_message text,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX sync_runs_account ON sync_runs(account_id,started_at DESC);
CREATE UNIQUE INDEX sync_runs_running ON sync_runs(account_id) WHERE status='running';
CREATE TABLE fx_quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), base_currency text NOT NULL, quote_currency text NOT NULL,
 rate numeric(38,18) NOT NULL CHECK(rate>0), quoted_at timestamptz NOT NULL, source text NOT NULL,
 UNIQUE(base_currency,quote_currency,quoted_at,source)
);
CREATE UNIQUE INDEX assets_provider_identity ON assets((external_ids->>'providerKey')) WHERE external_ids ? 'providerKey';

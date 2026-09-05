CREATE TABLE provider_account_history (
 account_id uuid NOT NULL REFERENCES accounts(id),at timestamptz NOT NULL,
 resolution text NOT NULL CHECK(resolution IN ('hourly','daily')),
 equity numeric(38,18) NOT NULL,total_pnl numeric(38,18) NOT NULL,
 net_transfers numeric(38,18) NOT NULL,currency text NOT NULL,source text NOT NULL,
 retrieved_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(account_id,at,resolution,source)
);
CREATE INDEX provider_account_history_time ON provider_account_history(account_id,at DESC);

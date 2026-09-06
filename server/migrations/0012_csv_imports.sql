ALTER TABLE accounts ADD COLUMN provider text, ADD COLUMN connection_type text, ADD COLUMN provider_account_key text, ADD COLUMN last_imported_at timestamptz;
CREATE INDEX accounts_provider_identity ON accounts(provider,provider_account_key) WHERE provider IS NOT NULL;
CREATE TABLE csv_import_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), creator_token_id uuid NOT NULL REFERENCES api_tokens(id),
 provider text NOT NULL, filename text NOT NULL, parser_version text NOT NULL,
 status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','completed','completed_with_warnings','cancelled','expired','failed')),
 revision integer NOT NULL DEFAULT 1, staged jsonb, preview jsonb NOT NULL, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', completed_at timestamptz
);
CREATE INDEX csv_import_expiry ON csv_import_batches(expires_at) WHERE status='preview';
CREATE TABLE csv_import_accounts (
 batch_id uuid NOT NULL REFERENCES csv_import_batches(id), account_id uuid NOT NULL REFERENCES accounts(id),
 imported_rows integer NOT NULL, duplicate_rows integer NOT NULL, PRIMARY KEY(batch_id,account_id)
);
ALTER TABLE transactions ADD COLUMN provider text, ADD COLUMN import_batch_id uuid REFERENCES csv_import_batches(id),
 ADD COLUMN content_hash text, ADD COLUMN net_cash_amount numeric(38,18), ADD COLUMN tax_amount numeric(38,18) CHECK(tax_amount>=0);
CREATE UNIQUE INDEX transactions_provider_identity ON transactions(account_id,provider,external_id) WHERE provider IS NOT NULL;

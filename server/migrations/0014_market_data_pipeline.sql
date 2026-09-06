CREATE TABLE securities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 isin text NOT NULL UNIQUE CHECK(isin ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'),
 name text NOT NULL,
 asset_type asset_type NOT NULL,
 primary_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
 identity_status text NOT NULL DEFAULT 'identity_pending'
   CHECK(identity_status IN ('identity_pending','identity_resolved','identity_not_found','identity_ambiguous')),
 identity_evidence jsonb NOT NULL DEFAULT '{}',
 preferred_mapping_id uuid,
 selection_locked boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE assets ADD COLUMN security_id uuid REFERENCES securities(id) ON DELETE SET NULL;
CREATE INDEX assets_security ON assets(security_id) WHERE security_id IS NOT NULL;

INSERT INTO securities(isin,name,asset_type)
SELECT isin,
  (array_agg(name ORDER BY created_at,id))[1],
  CASE WHEN count(DISTINCT asset_type)=1 THEN (array_agg(asset_type ORDER BY created_at,id))[1] ELSE 'other'::asset_type END
FROM (
  SELECT id,name,asset_type,created_at,upper(trim(external_ids->>'isin')) AS isin
  FROM assets
  WHERE external_ids ? 'isin' AND upper(trim(external_ids->>'isin')) ~ '^[A-Z]{2}[A-Z0-9]{9}[0-9]$'
) existing
GROUP BY isin;

UPDATE assets a SET security_id=s.id
FROM securities s
WHERE upper(trim(a.external_ids->>'isin'))=s.isin;

UPDATE securities s SET primary_asset_id=(
  SELECT a.id FROM assets a WHERE a.security_id=s.id ORDER BY a.created_at,a.id LIMIT 1
);

CREATE TABLE security_listings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 security_id uuid NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
 ticker text NOT NULL,
 mic text,
 name text NOT NULL,
 quote_currency text NOT NULL CHECK(quote_currency ~ '^[A-Z]{3}$'),
 quote_unit text NOT NULL DEFAULT 'major' CHECK(quote_unit IN ('major','minor')),
 unit_multiplier numeric(38,18) NOT NULL DEFAULT 1 CHECK(unit_multiplier > 0),
 timezone text,
 active boolean NOT NULL DEFAULT true,
 valid_from date,
 valid_to date,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);
CREATE UNIQUE INDEX security_listings_identity ON security_listings(security_id,ticker,coalesce(mic,''),quote_currency);

CREATE TABLE provider_mappings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 listing_id uuid NOT NULL REFERENCES security_listings(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('eodhd')),
 provider_symbol text NOT NULL,
 provider_exchange text,
 feed_scope text NOT NULL DEFAULT 'eod' CHECK(feed_scope IN ('eod')),
 verification_status text NOT NULL
   CHECK(verification_status IN ('candidate','verified','rejected')),
 evidence jsonb NOT NULL DEFAULT '{}',
 verified_at timestamptz,
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,provider_symbol)
);

ALTER TABLE securities ADD CONSTRAINT securities_preferred_mapping_fk
  FOREIGN KEY(preferred_mapping_id) REFERENCES provider_mappings(id) ON DELETE SET NULL;

CREATE TABLE market_prices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 mapping_id uuid NOT NULL REFERENCES provider_mappings(id) ON DELETE CASCADE,
 kind text NOT NULL DEFAULT 'eod' CHECK(kind IN ('eod')),
 open numeric(38,18) CHECK(open >= 0),
 high numeric(38,18) CHECK(high >= 0),
 low numeric(38,18) CHECK(low >= 0),
 close numeric(38,18) NOT NULL CHECK(close >= 0),
 adjusted_close numeric(38,18) CHECK(adjusted_close >= 0),
 volume numeric(38,8) CHECK(volume >= 0),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 unit_multiplier numeric(38,18) NOT NULL DEFAULT 1 CHECK(unit_multiplier > 0),
 market_date date NOT NULL,
 source_timestamp timestamptz,
 time_precision text NOT NULL DEFAULT 'date' CHECK(time_precision IN ('date','instant')),
 fetched_at timestamptz NOT NULL DEFAULT now(),
 adjustment_basis text NOT NULL DEFAULT 'raw' CHECK(adjustment_basis IN ('raw')),
 metadata jsonb NOT NULL DEFAULT '{}',
 UNIQUE(mapping_id,kind,market_date,adjustment_basis)
);
CREATE INDEX market_prices_latest ON market_prices(mapping_id,market_date DESC,fetched_at DESC);

CREATE TABLE market_data_state (
 security_id uuid NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
 stage text NOT NULL CHECK(stage IN ('selection','latest_price','history','fx')),
 status text NOT NULL,
 error_class text CHECK(error_class IN (
   'configuration_error','authentication_error','not_entitled','rate_limited',
   'quota_exhausted','provider_unavailable','invalid_provider_data','fx_missing',
   'corporate_action_review'
 )),
 provider text,
 provider_code text,
 message text,
 last_attempt_at timestamptz,
 last_success_at timestamptz,
 next_retry_at timestamptz,
 metadata jsonb NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(security_id,stage)
);

CREATE TABLE market_data_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 security_id uuid NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
 job_type text NOT NULL CHECK(job_type IN ('resolve','refresh_latest','backfill_history')),
 mapping_revision integer,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 failure jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX market_data_jobs_due ON market_data_jobs(status,next_attempt_at,created_at);
CREATE UNIQUE INDEX market_data_jobs_active ON market_data_jobs(security_id,job_type)
  WHERE status IN ('queued','running');

INSERT INTO market_data_jobs(security_id,job_type)
SELECT DISTINCT a.security_id,'resolve'
FROM assets a
WHERE a.security_id IS NOT NULL AND (
  EXISTS(SELECT 1 FROM transactions t WHERE t.asset_id=a.id AND NOT t.is_voided)
  OR EXISTS(SELECT 1 FROM holding_observations h WHERE h.asset_id=a.id)
)
ON CONFLICT DO NOTHING;

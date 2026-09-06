ALTER TABLE securities
  ADD COLUMN verification_revision integer NOT NULL DEFAULT 1 CHECK(verification_revision > 0);

ALTER TABLE provider_mappings
  ADD COLUMN verification_revision integer NOT NULL DEFAULT 1 CHECK(verification_revision > 0);

CREATE TABLE provider_call_budgets (
 provider text NOT NULL,
 budget_day date NOT NULL,
 used_calls integer NOT NULL DEFAULT 0 CHECK(used_calls >= 0),
 blocked_until timestamptz,
 block_reason text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,budget_day)
);

CREATE INDEX provider_call_budgets_blocked
  ON provider_call_budgets(provider,blocked_until)
  WHERE blocked_until IS NOT NULL;

CREATE TABLE provider_work_leases (
 provider text NOT NULL,
 work_type text NOT NULL,
 owner text NOT NULL,
 lease_until timestamptz NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,work_type)
);

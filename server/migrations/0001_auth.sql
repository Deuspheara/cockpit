CREATE TABLE api_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 token_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz, revoked_at timestamptz
);
CREATE TABLE worker_heartbeat (id integer PRIMARY KEY CHECK (id = 1), seen_at timestamptz NOT NULL);

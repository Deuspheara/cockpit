CREATE TABLE bots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL,strategy text NOT NULL DEFAULT 'heartbeat' CHECK(strategy='heartbeat'),
 enabled boolean NOT NULL DEFAULT false,schedule_minutes integer NOT NULL DEFAULT 60 CHECK(schedule_minutes BETWEEN 1 AND 10080),
 allocated_paper_capital numeric(38,18) NOT NULL CHECK(allocated_paper_capital>=0),currency text NOT NULL,
 last_run_at timestamptz,next_run_at timestamptz,error_message text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bot_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bot_id uuid NOT NULL REFERENCES bots(id),scheduled_for timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('running','success','failed')),paper_pnl numeric(38,18),order_count integer NOT NULL DEFAULT 0,
 error_message text,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,UNIQUE(bot_id,scheduled_for)
);
CREATE TABLE paper_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bot_run_id uuid NOT NULL REFERENCES bot_runs(id),asset_id uuid NOT NULL REFERENCES assets(id),
 side text NOT NULL CHECK(side IN ('BUY','SELL')),quantity numeric(38,18) NOT NULL CHECK(quantity>0),
 price numeric(38,18) NOT NULL CHECK(price>=0),currency text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);

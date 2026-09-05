ALTER TABLE agent_conversations ADD COLUMN request_id uuid UNIQUE;
CREATE TABLE agent_runs (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL UNIQUE, text text NOT NULL, context jsonb NOT NULL DEFAULT '[]', pending jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_attempts (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
 conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
 request_id uuid NOT NULL UNIQUE, status text NOT NULL CHECK(status IN ('running','completed','interrupted','failed')),
 cancel_requested boolean NOT NULL DEFAULT false, lease_until timestamptz NOT NULL DEFAULT now()+interval '30 seconds',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX agent_one_active ON agent_attempts(conversation_id) WHERE status='running';
ALTER TABLE agent_messages ADD COLUMN run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE;
ALTER TABLE agent_messages ADD COLUMN attempt_id uuid REFERENCES agent_attempts(id) ON DELETE CASCADE;
ALTER TABLE agent_messages ADD COLUMN status text NOT NULL DEFAULT 'completed';
CREATE UNIQUE INDEX agent_attempt_message ON agent_messages(attempt_id) WHERE role='assistant';
CREATE UNIQUE INDEX agent_run_user ON agent_messages(run_id) WHERE role='user';
CREATE TABLE agent_events (
 id bigserial PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES agent_attempts(id) ON DELETE CASCADE,
 type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_event_replay ON agent_events(attempt_id,id);
CREATE UNIQUE INDEX agent_terminal_event ON agent_events(attempt_id) WHERE type IN ('run.completed','run.interrupted','run.error');
CREATE TABLE agent_tool_results (
 run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, key text NOT NULL, result jsonb NOT NULL,
 proposal_id uuid REFERENCES change_sets(id), PRIMARY KEY(run_id,key)
);

ALTER TABLE agent_messages ADD COLUMN ordinal bigserial;

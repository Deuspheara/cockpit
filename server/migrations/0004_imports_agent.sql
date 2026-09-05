CREATE TABLE import_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES accounts(id),
 status text NOT NULL DEFAULT 'collecting' CHECK(status IN ('collecting','needs_input','ready_for_review','applied','cancelled','failed')),
 summary text, model text, change_set_id uuid REFERENCES change_sets(id), revision integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE import_extractions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),import_session_id uuid NOT NULL REFERENCES import_sessions(id),artifact_index integer NOT NULL,
 extraction jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(import_session_id,artifact_index)
);
ALTER TABLE holding_observations ADD CONSTRAINT observation_import_fk FOREIGN KEY(import_session_id) REFERENCES import_sessions(id);
ALTER TABLE reconciliation_items ADD CONSTRAINT reconciliation_import_fk FOREIGN KEY(import_session_id) REFERENCES import_sessions(id);
CREATE TABLE agent_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
 role text NOT NULL CHECK(role IN ('user','assistant','tool')),content text NOT NULL,change_set_ids jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now()
);

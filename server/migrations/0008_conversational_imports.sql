ALTER TYPE asset_type ADD VALUE IF NOT EXISTS 'option';

ALTER TABLE holding_observations ALTER COLUMN quantity DROP NOT NULL;
ALTER TABLE holding_observations DROP CONSTRAINT IF EXISTS holding_observations_quantity_check;
ALTER TABLE holding_observations
  ADD CONSTRAINT holding_observations_quantity_check CHECK(quantity IS NULL OR quantity >= 0);

ALTER TABLE import_sessions
  ADD COLUMN conversation_id uuid REFERENCES agent_conversations(id),
  ADD COLUMN request_id uuid UNIQUE;
CREATE INDEX import_sessions_conversation ON import_sessions(conversation_id,created_at);

ALTER TABLE agent_messages
  ADD COLUMN kind text NOT NULL DEFAULT 'text' CHECK(kind IN ('text','screenshot_import')),
  ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';

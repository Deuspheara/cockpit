ALTER TABLE sync_runs DROP CONSTRAINT sync_runs_status_check;
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_status_check CHECK(status IN ('queued','running','success','partial','failed'));
ALTER TABLE sync_runs ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE sync_runs ALTER COLUMN started_at DROP NOT NULL;
ALTER TABLE sync_runs ALTER COLUMN started_at DROP DEFAULT;
DROP INDEX sync_runs_running;
CREATE UNIQUE INDEX sync_runs_running ON sync_runs(account_id) WHERE status IN ('queued','running');
ALTER TABLE agent_messages DROP CONSTRAINT agent_messages_kind_check;
ALTER TABLE agent_messages ADD CONSTRAINT agent_messages_kind_check CHECK(kind IN ('text','screenshot_import','import_result'));
UPDATE agent_messages SET kind='import_result',role='assistant',content='Screenshot import · Open result' WHERE kind='screenshot_import' AND metadata ? 'importSessionId';
CREATE UNIQUE INDEX agent_messages_import_result ON agent_messages((metadata->>'importSessionId')) WHERE kind='import_result';
CREATE TABLE import_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 import_session_id uuid NOT NULL REFERENCES import_sessions(id),
 request_id uuid NOT NULL, session_revision integer NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
 phase text NOT NULL DEFAULT 'queued' CHECK(phase IN ('queued','extracting','matching','estimating','finalizing','complete')),
 failure jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz, finished_at timestamptz,
 UNIQUE(import_session_id,request_id)
);
CREATE UNIQUE INDEX import_jobs_active ON import_jobs(import_session_id) WHERE status IN ('queued','running');
CREATE INDEX import_jobs_latest ON import_jobs(import_session_id,created_at DESC);

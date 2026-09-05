import type { Database } from "../../db/index.js";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors.js";
import type { ImportService } from "./service.js";
export type Screenshot = { bytes: Buffer; mime: string };
export function jobProgress(row: Record<string, unknown>) {
  const phases = ["extracting", "matching", "estimating", "finalizing"];
  const current = phases.indexOf(String(row.phase));
  return {
    ...row,
    progress: phases.map((id, index) => ({
      id,
      status:
        row.status === "completed" || index < current
          ? "completed"
          : index === current
            ? row.status
            : "pending",
    })),
  };
}
// Only this API process owns image buffers. Database rows contain progress, never images.
export class ImportJobs {
  private active = new Map<
    string,
    { images: Screenshot[]; controller: AbortController }
  >();
  constructor(
    private database: Database,
    private imports: ImportService,
  ) {}
  async expire() {
    await this.database
      .sql`UPDATE import_jobs SET status='failed',failure='{"code":"REUPLOAD_REQUIRED","message":"Re-upload required: the server restarted during processing.","retryable":true}',finished_at=now(),updated_at=now() WHERE status IN ('queued','running')`;
  }
  async get(sessionId: string, jobId: string) {
    const [job] = await this.database
      .sql`SELECT * FROM import_jobs WHERE id=${jobId} AND import_session_id=${sessionId}`;
    if (!job) throw new NotFoundError("Import job not found");
    return jobProgress(job);
  }
  async create(
    sessionId: string,
    requestId: string,
    revision: number,
    images: Screenshot[],
  ) {
    let retained = false;
    try {
      const job = await this.database.sql.begin(async (tx) => {
        const [session] =
          await tx`SELECT * FROM import_sessions WHERE id=${sessionId} FOR UPDATE`;
        if (!session) throw new NotFoundError("Import session not found");
        const [existing] =
          await tx`SELECT * FROM import_jobs WHERE import_session_id=${sessionId} AND request_id=${requestId}`;
        if (existing) return { row: existing, fresh: false };
        if (
          session.revision !== revision ||
          session.changeSetId ||
          ["applied", "cancelled"].includes(String(session.status))
        )
          throw new ConflictError("Import changed. Reload before uploading.");
        const [active] =
          await tx`SELECT id FROM import_jobs WHERE import_session_id=${sessionId} AND status IN ('queued','running')`;
        if (active) throw new ConflictError("An import is already processing");
        const [row] =
          await tx`INSERT INTO import_jobs(import_session_id,request_id,session_revision) VALUES(${sessionId},${requestId},${revision}) RETURNING *`;
        if (session.conversationId)
          await tx`INSERT INTO agent_messages(conversation_id,role,content,kind,metadata,status)
          VALUES(${String(session.conversationId)},'assistant','Screenshot import · Open result','import_result',${tx.json({ importSessionId: sessionId })},'completed')
          ON CONFLICT ((metadata->>'importSessionId')) WHERE kind='import_result' DO NOTHING`;
        return { row: row!, fresh: true };
      });
      if (job.fresh) {
        const controller = new AbortController();
        this.active.set(String(job.row.id), { images, controller });
        retained = true;
        setImmediate(() => {
          void this.run(sessionId, String(job.row.id), revision).catch(
            () => {},
          );
        });
      }
      return jobProgress(job.row);
    } finally {
      if (!retained) images.forEach((image) => image.bytes.fill(0));
    }
  }
  private async run(sessionId: string, jobId: string, revision: number) {
    const owned = this.active.get(jobId);
    if (!owned) return;
    try {
      const rows = await this.database
        .sql`UPDATE import_jobs SET status='running',phase='extracting',started_at=now(),updated_at=now() WHERE id=${jobId} AND status='queued' RETURNING id`;
      if (!rows.length) return;
      await this.imports.extract(sessionId, owned.images, undefined, {
        id: jobId,
        revision,
        signal: owned.controller.signal,
        phase: async (phase) => {
          owned.controller.signal.throwIfAborted();
          const rows = await this.database
            .sql`UPDATE import_jobs SET phase=${phase},updated_at=now() WHERE id=${jobId} AND status='running' RETURNING id`;
          if (!rows.length) throw new ConflictError("Import cancelled");
        },
      });
    } catch (error) {
      const failure =
        error instanceof AppError
          ? { code: error.code, message: error.message, retryable: true }
          : {
              code: "IMPORT_FAILED",
              message: "Screenshot processing failed. Re-upload to retry.",
              retryable: true,
            };
      await this.database
        .sql`UPDATE import_jobs SET status='failed',failure=${this.database.sql.json(failure)},finished_at=now(),updated_at=now() WHERE id=${jobId} AND status IN ('queued','running')`;
    } finally {
      this.release(jobId);
    }
  }
  private release(id: string) {
    const owned = this.active.get(id);
    owned?.controller.abort();
    owned?.images.forEach((image) => image.bytes.fill(0));
    this.active.delete(id);
  }
  async cancel(sessionId: string, jobId: string) {
    await this.get(sessionId, jobId);
    await this.database
      .sql`UPDATE import_jobs SET status='cancelled',finished_at=now(),updated_at=now() WHERE id=${jobId} AND status IN ('queued','running')`;
    this.release(jobId);
    return this.get(sessionId, jobId);
  }
  async close() {
    for (const id of this.active.keys()) this.release(id);
    await this.expire();
  }
}

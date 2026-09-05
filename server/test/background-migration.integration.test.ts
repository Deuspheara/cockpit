import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { connectDatabase } from "../src/db/index.js";
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)(
  "background job migration from the previous schema",
  () => {
    it("preserves legacy runs and converts screenshot messages into unique result links", async () => {
      if (!url?.endsWith("/finance_test"))
        throw new Error("Dedicated test DB required");
      const db = connectDatabase(url);
      const namespace = `migration_${randomUUID().replaceAll("-", "")}`;
      const directory = new URL("../migrations/", import.meta.url);
      try {
        await db.sql.begin(async (tx) => {
          await tx.unsafe(`CREATE SCHEMA ${namespace}`);
          await tx.unsafe(`SET LOCAL search_path TO ${namespace},public`);
          for (const name of (await readdir(directory))
            .filter((name) => name.endsWith(".sql") && name < "0009")
            .sort()) {
            await tx.unsafe(await readFile(new URL(name, directory), "utf8"));
          }
          const [account] =
            await tx`INSERT INTO accounts(name,asset_class,source_type,base_currency,external_address) VALUES('Existing wallet','crypto','evm_wallet','EUR','0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') RETURNING id`;
          const [run] =
            await tx`INSERT INTO sync_runs(account_id,provider,status,cursor) VALUES(${account!.id},'evm_wallet','success','{"page":1}') RETURNING id,started_at`;
          const [conversation] =
            await tx`INSERT INTO agent_conversations DEFAULT VALUES RETURNING id`;
          const [session] =
            await tx`INSERT INTO import_sessions(conversation_id) VALUES(${conversation!.id}) RETURNING id`;
          await tx`INSERT INTO agent_messages(conversation_id,role,content,kind,metadata) VALUES(${conversation!.id},'user','Screenshot attached','screenshot_import',${tx.json({ importSessionId: session!.id })})`;
          await tx.unsafe(
            await readFile(
              new URL("0009_background_jobs.sql", directory),
              "utf8",
            ),
          );
          const [retained] =
            await tx`SELECT status,cursor,started_at FROM sync_runs WHERE id=${run!.id}`;
          expect(retained).toMatchObject({
            status: "success",
            cursor: { page: 1 },
            startedAt: run!.startedAt,
          });
          const messages =
            await tx`SELECT kind,role,metadata FROM agent_messages`;
          expect(messages).toHaveLength(1);
          expect(messages[0]).toMatchObject({
            kind: "import_result",
            role: "assistant",
            metadata: { importSessionId: session!.id },
          });
          const [queued] =
            await tx`INSERT INTO sync_runs(account_id,provider,status) VALUES(${account!.id},'evm_wallet','queued') RETURNING started_at,created_at`;
          expect(queued!.startedAt).toBeNull();
          expect(queued!.createdAt).toBeInstanceOf(Date);
          const requestId = randomUUID();
          const [job] =
            await tx`INSERT INTO import_jobs(import_session_id,request_id,session_revision) VALUES(${session!.id},${requestId},0) RETURNING status,phase`;
          expect(job).toMatchObject({ status: "queued", phase: "queued" });
          await tx.unsafe(`DROP SCHEMA ${namespace} CASCADE`);
        });
      } finally {
        await db.close();
      }
    });
  },
);

import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { readConfig } from "../src/config.js";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { ChangeSetService } from "../src/modules/changes/service.js";
import { ImportService } from "../src/modules/imports/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "persisted conversational screenshot → correction → review → apply → undo",
  () => {
    let db: ReturnType<typeof connectDatabase>,
      imports: ImportService,
      changes: ChangeSetService;
    let sessionId: string;
    beforeAll(async () => {
      if (!url || !new URL(url).pathname.endsWith("/finance_test"))
        throw new Error("Dedicated test DB required");
      await migrate(url);
      db = connectDatabase(url);
      changes = new ChangeSetService(db);
      const transport: typeof fetch = async (input, init) => {
        expect(String(input)).toBe(
          "https://openrouter.ai/api/v1/chat/completions",
        );
        const request = JSON.parse(String(init?.body)) as {
          messages: { content: unknown }[];
          response_format: { type: string };
        };
        expect(request.response_format.type).toBe("json_schema");
        const content = {
          likelyAccountName: "Broker screenshot",
          currency: "EUR",
          capturedAt: null,
          positions: [
            {
              symbol: "CW8",
              name: "MSCI World ETF",
              quantity: "18.23",
              marketValue: "9483",
              currency: "EUR",
              confidence: 0.98,
            },
          ],
          transactions: [],
          missingInformation: [],
          ambiguities: [],
        };
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(content) } }],
          }),
          { status: 200 },
        );
      };
      const model = new OpenRouterClient(
        readConfig({
          ...process.env,
          DATABASE_URL: url,
          OPENROUTER_API_KEY: "fixture-key",
          OPENROUTER_MODEL_VISION: "fixture-vision",
        }),
        transport,
      );
      imports = new ImportService(db, model, changes);
      const [conversation] =
        await db.sql`INSERT INTO agent_conversations DEFAULT VALUES RETURNING id`;
      const requestId = randomUUID();
      const created = await imports.create(
        undefined,
        String(conversation!.id),
        requestId,
      );
      const replayed = await imports.create(
        undefined,
        String(conversation!.id),
        requestId,
      );
      expect(replayed.id).toBe(created.id);
      sessionId = created.id;
    });
    afterAll(async () => {
      await db.sql`TRUNCATE accounts,assets,import_sessions CASCADE`;
      await db.close();
    });
    it("keeps images transient, persists one compact result link, and infers the date", async () => {
      const session = await imports.extract(sessionId, {
        bytes: Buffer.from("fixture screenshot bytes"),
        mime: "image/png",
      });
      expect(session.status).toBe("ready_for_review");
      expect(session.extraction?.capturedAtInferred).toBe(true);
      expect(session.warnings).toContain(
        "Observation date was inferred from the upload date.",
      );
      const rows =
        await db.sql`SELECT extraction FROM import_extractions WHERE import_session_id=${sessionId}`;
      expect(JSON.stringify(rows)).not.toContain(
        Buffer.from("fixture screenshot bytes").toString("base64"),
      );
      const messages =
        await db.sql`SELECT kind,metadata FROM agent_messages WHERE metadata->>'importSessionId'=${sessionId}`;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.kind).toBe("import_result");
      expect(await db.sql`SELECT id FROM accounts`).toHaveLength(0);
    });
    it("uses revision-checked edits then creates only observations after inline review", async () => {
      const original = await imports.get(sessionId);
      const session = await imports.update(sessionId, original.revision, {
        capturedAt: "2026-08-31T00:00:00Z",
        positions: [
          {
            candidateId: original.extraction!.positions[0]!.candidateId!,
            quantity: "18.23",
          },
        ],
      });
      expect(session.extraction?.capturedAtInferred).toBe(false);
      await expect(
        imports.update(sessionId, original.revision, {
          likelyAccountName: "Stale correction",
        }),
      ).rejects.toThrow("changed");
      const draft = await imports.prepare(sessionId);
      expect(draft.operations.some((o) => o.table === "transactions")).toBe(
        false,
      );
      expect(
        draft.operations.find((o) => o.table === "holding_observations")?.after
          ?.costBasis,
      ).toBeNull();
      await changes.apply(draft.id);
      expect((await imports.get(sessionId)).status).toBe("applied");
      expect(
        (await new PortfolioService(db).dashboard("global", "1m")).value,
      ).toBe("9483.000000000000000000");
      expect(await db.sql`SELECT id FROM transactions`).toHaveLength(0);
      await changes.apply(draft.id, true);
      expect(
        (await new PortfolioService(db).dashboard("global", "1m")).value,
      ).toBe("0.000000000000000000");
    });
  },
);

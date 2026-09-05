import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { readConfig } from "../src/config.js";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { ChangeSetService } from "../src/modules/changes/service.js";
import { ImportService } from "../src/modules/imports/service.js";
import { PortfolioService } from "../src/modules/portfolio/service.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "screenshot fixture → clarification → review → apply",
  () => {
    let db: ReturnType<typeof connectDatabase>,
      imports: ImportService,
      changes: ChangeSetService;
    let sessionId: string;
    let calls = 0;
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
        calls++;
        const content = {
          likelyAccountName: "Broker screenshot",
          currency: "EUR",
          capturedAt: calls === 1 ? null : "2026-08-31T00:00:00Z",
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
      sessionId = (await imports.create()).id;
    });
    afterAll(async () => {
      await db.sql`TRUNCATE accounts,assets,import_sessions CASCADE`;
      await db.close();
    });
    it("keeps images transient and blocks review while date is missing", async () => {
      const session = await imports.extract(sessionId, {
        bytes: Buffer.from("fixture screenshot bytes"),
        mime: "image/png",
      });
      expect(session.status).toBe("needs_input");
      await expect(imports.prepare(sessionId)).rejects.toThrow(
        "Resolve missing",
      );
      const rows =
        await db.sql`SELECT extraction FROM import_extractions WHERE import_session_id=${sessionId}`;
      expect(JSON.stringify(rows)).not.toContain(
        Buffer.from("fixture screenshot bytes").toString("base64"),
      );
      expect(await db.sql`SELECT id FROM accounts`).toHaveLength(0);
    });
    it("uses an explicit follow-up answer then creates only observations after review", async () => {
      const session = await imports.extract(
        sessionId,
        undefined,
        "Observed on August 31, 2026.",
      );
      expect(session.status).toBe("ready_for_review");
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

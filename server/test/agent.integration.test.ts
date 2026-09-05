import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { connectDatabase } from "../src/db/index.js";
import { readConfig } from "../src/config.js";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { AgentService } from "../src/modules/agent/service.js";
import { AgentTools } from "../src/modules/agent/tools.js";
import { AccountService } from "../src/modules/accounts/service.js";
import { AssetService } from "../src/modules/assets/service.js";
import { ChangeSetService } from "../src/modules/changes/service.js";
import { RecurringService } from "../src/modules/recurring/service.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("agent authorization and proposal workflow", () => {
  let db: ReturnType<typeof connectDatabase>,
    tools: AgentTools,
    changes: ChangeSetService,
    ruleId: string;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/finance_test"))
      throw new Error("Dedicated test DB required");
    await migrate(url);
    db = connectDatabase(url);
    changes = new ChangeSetService(db);
    tools = new AgentTools(db, changes);
    const accountId = (
      await new AccountService(db).create({
        name: "Agent test",
        sourceType: "manual",
        assetClass: "equities",
      })
    ).id;
    const assetId = (
      await new AssetService(db).create({
        symbol: "CW8",
        name: "CW8",
        assetType: "etf",
        quoteCurrency: "EUR",
      })
    ).id;
    const draft = await changes.proposeRule({
      accountId,
      assetId,
      transactionType: "BUY",
      inputMode: "cash_amount",
      cashAmount: "500",
      currency: "EUR",
      cadence: "monthly",
      startOn: "2026-01-01",
    });
    await changes.apply(draft.id);
    ruleId = draft.operations[0]!.id;
  });
  afterAll(async () => {
    await db.sql`TRUNCATE accounts,assets,agent_conversations CASCADE`;
    await db.close();
  });
  it("never exposes SQL, arbitrary HTTP, secrets, applying proposals, or trading", async () => {
    const names = tools.definitions().map((t) => t.function.name);
    for (const forbidden of [
      "execute_sql",
      "fetch_url",
      "read_env",
      "apply_change_set",
      "trade",
      "sign_transaction",
      "constructor",
      "__proto__",
    ]) {
      expect(names).not.toContain(forbidden);
      await expect(tools.execute(forbidden, {})).rejects.toThrow(
        "not available",
      );
    }
  });
  it("rejects untyped/malicious financial arguments", async () => {
    await expect(
      tools.execute("propose_create_transaction", {
        sql: "DELETE FROM accounts",
        quantity: 0.1,
      }),
    ).rejects.toThrow();
  });
  it("turns a stop intent into a deterministic draft without applying it", async () => {
    let iteration = 0;
    const transport: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: unknown }[];
      };
      expect(String(request.messages[0]?.content)).toContain(
        "Never infer acquisition cost",
      );
      iteration++;
      const call = (name: string, args: unknown) => ({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: `call-${iteration}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
          },
        ],
      });
      return new Response(
        JSON.stringify(
          iteration === 1
            ? call("get_recurring_rule", { ruleId })
            : iteration === 2
              ? call("list_recurring_occurrences", { ruleId })
              : iteration === 3
                ? call("propose_stop_recurring_rule", {
                    ruleId,
                    effectiveOn: "2026-06-01",
                  })
                : {
                    choices: [
                      {
                        message: {
                          content:
                            "Review the proposed stop from June 1, 2026. It has not been applied.",
                        },
                      },
                    ],
                  },
        ),
      );
    };
    const service = new AgentService(
      db,
      new OpenRouterClient(
        readConfig({
          ...process.env,
          DATABASE_URL: url,
          OPENROUTER_API_KEY: "fixture",
          OPENROUTER_MODEL_PRIMARY: "fixture",
        }),
        transport,
      ),
      tools,
    );
    const conversation = await service.create();
    const answer = await service.message(
      String(conversation.id),
      "I stopped my recurring CW8 investment in June 2026.",
    );
    const ids = answer.changeSetIds as string[];
    expect(ids).toHaveLength(1);
    const draft = await changes.get(ids[0]!);
    expect(draft.status).toBe("draft");
    expect(draft.createdBy).toBe("agent");
    expect(draft.operations[0]?.after?.endOn).toBe("2026-05-31");
    expect((await new RecurringService(db).get(ruleId)).endOn).toBeNull();
  });
});

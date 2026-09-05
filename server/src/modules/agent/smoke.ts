/** Synthetic compatibility check: no portfolio data, tool execution, or raw provider output. */
import { z } from "zod";
import { readConfig } from "../../config.js";
import { OpenRouterClient } from "./openrouter.js";
import { extractionSchema } from "../imports/schemas.js";
import { publicError } from "./stream.js";
const client = new OpenRouterClient(readConfig());
console.log(JSON.stringify({ capabilities: await client.compatibility() }));
let failed = false;
for (const kind of ["chat", "vision"] as const) {
  try {
    if (kind === "chat") {
      let length = 0;
      const result = await client.stream(
        [
          {
            role: "user",
            content:
              "Compatibility test only. Call list_accounts with empty arguments. Do not produce any other content.",
          },
        ],
        {
          signal: AbortSignal.timeout(60000),
          tools: [
            {
              type: "function",
              function: {
                name: "list_accounts",
                description:
                  "Synthetic capability check. This tool will not be executed.",
                parameters: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            },
          ],
        },
        async (text) => {
          length += text.length;
        },
      );
      if (result.tool_calls?.[0]?.function.name !== "list_accounts")
        throw new Error("Tool response missing");
      console.log(
        JSON.stringify({
          check: kind,
          status: "passed",
          toolCallReceived: true,
          textCharacters: length,
        }),
      );
    } else {
      const image =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1sAAAAASUVORK5CYII=";
      const result = await client.complete(
        [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Synthetic compatibility test. This image contains no financial data. Return empty positions and transactions; do not invent records. Use null for unknown fields.",
              },
              { type: "image_url", image_url: { url: image } },
            ],
          },
        ],
        {
          vision: true,
          timeoutMs: 60000,
          responseFormat: {
            type: "json_schema",
            json_schema: {
              name: "finance_import",
              strict: true,
              schema: z.toJSONSchema(extractionSchema),
            },
          },
        },
      );
      const extraction = extractionSchema.parse(
        JSON.parse(result.content ?? ""),
      );
      console.log(
        JSON.stringify({
          check: kind,
          status: "passed",
          schemaValidated: true,
          positions: extraction.positions.length,
          transactions: extraction.transactions.length,
        }),
      );
    }
  } catch (error) {
    failed = true;
    console.log(
      JSON.stringify({
        check: kind,
        status: "failed",
        error: publicError(error),
      }),
    );
  }
}
process.exitCode = failed ? 1 : 0;

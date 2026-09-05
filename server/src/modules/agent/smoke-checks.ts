/** Synthetic compatibility check: no portfolio data, tool execution, or raw provider output. */
import { z } from "zod";
import type { OpenRouterClient } from "./openrouter.js";
import { extractionSchema } from "../imports/schemas.js";
import { publicError } from "./stream.js";
export const smokeImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJklEQVR4nO3NMQ0AAAwDoPo33arYsQQMkB6LQCAQCAQCgUAg+BIMi1X0pjxKe0gAAAAASUVORK5CYII=";
const probeSchema = z.object({ ok: z.literal(true) }).strict();

export async function runSmokeChecks(
  client: Pick<OpenRouterClient, "stream" | "complete" | "compatibility">,
  diagnose = false,
  report: (result: Record<string, unknown>) => void = (result) =>
    console.log(JSON.stringify(result)),
) {
  report({ capabilities: await client.compatibility() });
  let failed = false;
  const checks = [
    "chat",
    "vision",
    ...(diagnose
      ? ["vision.image_only", "vision.schema_only", "vision.image_schema"]
      : []),
  ];
  for (const kind of checks) {
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
        report({
          check: kind,
          status: "passed",
          toolCallReceived: true,
          textCharacters: length,
        });
      } else {
        const fullSchema = kind === "vision";
        const schema = fullSchema ? extractionSchema : probeSchema;
        const useImage = kind !== "vision.schema_only";
        const useSchema = kind !== "vision.image_only";
        const result = await client.complete(
          [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: fullSchema
                    ? "Synthetic compatibility test. This image contains no financial data. Return all required fields, empty positions and transactions; do not invent records. Use null for unknown fields."
                    : 'Synthetic compatibility test. Return {"ok":true}. Do not describe the image.',
                },
                ...(useImage
                  ? [{ type: "image_url", image_url: { url: smokeImage } }]
                  : []),
              ],
            },
          ],
          {
            vision: true,
            timeoutMs: 60000,
            responseFormat: useSchema
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: fullSchema ? "finance_import" : "compatibility_probe",
                    strict: true,
                    schema: z.toJSONSchema(schema),
                  },
                }
              : undefined,
          },
        );
        if (!result.content?.trim())
          throw new Error("Empty synthetic response");
        const value: unknown = useSchema ? JSON.parse(result.content) : null;
        if (useSchema) schema.parse(value);
        if (fullSchema) {
          // Zod defaults are useful for stored imports, but must not make {} pass this strict-output check.
          if (
            !value ||
            typeof value !== "object" ||
            Object.keys(extractionSchema.shape).some(
              (key) => !Object.hasOwn(value, key),
            )
          )
            throw new Error("Required extraction fields missing");
          const extraction = extractionSchema.parse(value);
          if (extraction.positions.length || extraction.transactions.length)
            throw new Error(
              "Synthetic blank image must not produce financial records",
            );
        }
        report({ check: kind, status: "passed", schemaValidated: useSchema });
      }
    } catch (error) {
      failed = true;
      report({ check: kind, status: "failed", error: publicError(error) });
    }
  }
  return !failed;
}

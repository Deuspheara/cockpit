import { z } from "zod";
import { AppError } from "../../shared/errors.js";
import type { Config } from "../../config.js";
export const modelMessageSchema = z.object({
  role: z.literal("assistant").optional(),
  content: z.string().nullable().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .max(12)
    .optional(),
});
export type ModelMessage = z.infer<typeof modelMessageSchema>;
export class OpenRouterClient {
  constructor(
    private config: Config,
    private transport: typeof fetch = fetch,
  ) {}
  get visionModel() {
    return this.config.OPENROUTER_MODEL_VISION;
  }
  get primaryModel() {
    return this.config.OPENROUTER_MODEL_PRIMARY;
  }
  async complete(
    messages: unknown[],
    options: {
      vision?: boolean;
      responseFormat?: unknown;
      tools?: unknown[];
      timeoutMs?: number;
    } = {},
  ): Promise<ModelMessage> {
    const model = options.vision ? this.visionModel : this.primaryModel;
    if (!this.config.OPENROUTER_API_KEY || !model)
      throw new AppError(
        "NOT_CONFIGURED",
        `Configure OpenRouter ${options.vision ? "vision" : "primary"} model and API key on the server`,
        503,
      );
    let response: Response;
    try {
      response = await this.transport(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.OPENROUTER_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0,
            max_tokens: 12000,
            provider: { require_parameters: true },
            ...(options.responseFormat
              ? { response_format: options.responseFormat }
              : {}),
            ...(options.tools
              ? { tools: options.tools, parallel_tool_calls: false }
              : {}),
          }),
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(60000, options.timeoutMs ?? 60000)),
          ),
          redirect: "error",
        },
      );
    } catch {
      throw new AppError(
        "AI_UNAVAILABLE",
        "The model request failed or timed out",
        502,
      );
    }
    if (!response.ok)
      throw new AppError(
        "AI_UNAVAILABLE",
        `The model provider returned HTTP ${response.status}`,
        502,
      );
    const parsed = z
      .object({
        choices: z.array(z.object({ message: modelMessageSchema })).min(1),
      })
      .safeParse(await response.json());
    if (!parsed.success)
      throw new AppError(
        "AI_INVALID_RESPONSE",
        "The model returned an invalid response",
        502,
      );
    return parsed.data.choices[0]!.message;
  }
}

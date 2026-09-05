import { z } from "zod";
import { SSEParser, aiError } from "./stream.js";
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
    const response = await this.request(messages, options);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
      )
        throw aiError(504);
      throw new AppError(
        "AI_INVALID_RESPONSE",
        "The model returned an invalid response",
        502,
        { retryable: true },
      );
    }
    const parsed = z
      .object({
        choices: z.array(z.object({ message: modelMessageSchema })).min(1),
      })
      .safeParse(body);
    if (!parsed.success)
      throw new AppError(
        "AI_INVALID_RESPONSE",
        "The model returned an invalid response",
        502,
        { retryable: true },
      );
    return parsed.data.choices[0]!.message;
  }
  private async request(
    messages: unknown[],
    options: {
      vision?: boolean;
      responseFormat?: unknown;
      tools?: unknown[];
      timeoutMs?: number;
      signal?: AbortSignal;
      stream?: boolean;
    },
  ) {
    const model = options.vision ? this.visionModel : this.primaryModel;
    if (!this.config.OPENROUTER_API_KEY || !model)
      throw new AppError(
        "NOT_CONFIGURED",
        "Configure the OpenRouter model and API key on the server",
        503,
      );
    let response: Response;
    try {
      response = await this.transport(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.OPENROUTER_API_KEY}`,
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: 12000,
            provider: { require_parameters: true },
            ...(options.stream ? { stream: true } : {}),
            ...(options.tools ? { tools: options.tools } : {}),
            ...(options.responseFormat
              ? { response_format: options.responseFormat }
              : {}),
          }),
          signal:
            options.signal ??
            AbortSignal.timeout(
              Math.max(1, Math.min(60000, options.timeoutMs ?? 60000)),
            ),
        },
      );
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw aiError(
        error instanceof Error && error.name === "TimeoutError" ? 504 : 502,
      );
    }
    if (!response.ok)
      throw aiError(
        response.status,
        await response.json().catch(() => null),
        response.headers.get("retry-after"),
      );
    return response;
  }
  async stream(
    messages: unknown[],
    options: { tools?: unknown[]; signal: AbortSignal },
    delta: (text: string) => Promise<void>,
  ): Promise<ModelMessage> {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(aiError(504)), 60000);
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(aiError(504)), 60000);
    };
    const signal = AbortSignal.any([options.signal, controller.signal]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.request(messages, {
        ...options,
        signal,
        stream: true,
      });
      if (!response.body) throw aiError(502);
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parser = new SSEParser();
      const calls = new Map<
        number,
        {
          id: string;
          type: "function";
          function: { name: string; arguments: string };
        }
      >();
      let content = "",
        done = false,
        finish: string | null = null;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        reset();
        for (const frame of parser.feed(
          decoder.decode(chunk.value, { stream: true }),
        )) {
          if (frame.data === "[DONE]") {
            done = true;
            break;
          }
          let value;
          try {
            value = JSON.parse(frame.data);
          } catch {
            throw new AppError(
              "AI_INVALID_RESPONSE",
              "The model sent an invalid streaming frame",
              502,
            );
          }
          if (value.error)
            throw aiError(Number(value.error.code) || 502, value);
          const choice = value.choices?.find(
            (c: { index?: number }) => (c.index ?? 0) === 0,
          );
          if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          if (finish === "error") throw aiError(502);
          const part = choice.delta;
          if (typeof part?.content === "string" && part.content) {
            content += part.content;
            if (content.length > 60000)
              throw new AppError(
                "AI_LIMIT",
                "The response reached its text limit",
                502,
              );
            await delta(part.content);
          }
          for (const item of part?.tool_calls ?? []) {
            if (
              !Number.isInteger(item.index) ||
              item.index < 0 ||
              item.index >= 12
            )
              throw new AppError(
                "AI_INVALID_RESPONSE",
                "The model returned an invalid tool index",
                502,
              );
            const call = calls.get(item.index) ?? {
              id: "",
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (item.id) call.id += item.id;
            if (item.function?.name) call.function.name += item.function.name;
            if (item.function?.arguments)
              call.function.arguments += item.function.arguments;
            if (call.id.length > 256 || call.function.name.length > 128)
              throw new AppError(
                "AI_INVALID_RESPONSE",
                "The model returned an oversized tool identifier",
                502,
              );
            if (call.function.arguments.length > 64000)
              throw new AppError(
                "AI_INVALID_RESPONSE",
                "Tool arguments exceeded the size limit",
                502,
              );
            calls.set(item.index, call);
          }
        }
      }
      if (!done || !finish)
        throw new AppError(
          "AI_INTERRUPTED",
          "The model connection ended before completion. Retry to continue.",
          502,
          { retryable: true },
        );
      if (finish !== "stop" && finish !== "tool_calls")
        throw new AppError(
          "AI_LIMIT",
          "The model stopped before completing the response. Retry or ask a narrower question.",
          502,
          { retryable: true },
        );
      const tool_calls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call);
      if (
        tool_calls.some((c) => !c.id || !c.function.name) ||
        (finish === "tool_calls" && !tool_calls.length)
      )
        throw new AppError(
          "AI_INVALID_RESPONSE",
          "The model returned an incomplete tool call",
          502,
        );
      return modelMessageSchema.parse({
        content,
        ...(tool_calls.length ? { tool_calls } : {}),
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw error instanceof AppError ? error : aiError(502);
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
    }
  }
  async compatibility() {
    const inspect = async (model: string, vision: boolean) => {
      if (!model) return { configured: false, compatible: false };
      try {
        const response = await this.transport(
          `https://openrouter.ai/api/v1/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`,
          { signal: AbortSignal.timeout(10000), redirect: "error" },
        );
        if (!response.ok) throw new Error("Capability lookup failed");
        const data = (await response.json()).data;
        const required = vision
          ? ["max_tokens", "response_format", "structured_outputs"]
          : ["max_tokens", "tools"];
        const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
        return {
          configured: true,
          compatible:
            endpoints.some((e: { supported_parameters?: string[] }) =>
              required.every((p) => e.supported_parameters?.includes(p)),
            ) &&
            (!vision ||
              data?.architecture?.input_modalities?.includes("image")),
          requiredParameters: required,
          note: "Public capabilities only; account provider restrictions and credits can still prevent routing.",
        };
      } catch {
        return {
          configured: true,
          compatible: null,
          note: "Public capability lookup unavailable.",
        };
      }
    };
    return {
      primary: await inspect(this.primaryModel, false),
      vision: await inspect(this.visionModel, true),
    };
  }
}

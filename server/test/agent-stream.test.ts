import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { SSEParser, aiError } from "../src/modules/agent/stream.js";
import { readConfig } from "../src/config.js";
const config = readConfig({
  DATABASE_URL: "postgresql://test:test@localhost/finance_test",
  REDIS_URL: "redis://localhost",
  OPENROUTER_API_KEY: "secret-key",
  OPENROUTER_MODEL_PRIMARY: "openai/gpt-5.6-sol",
  OPENROUTER_MODEL_VISION: "openai/gpt-5.6-sol",
});
const frame = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (const b of bytes) c.enqueue(new Uint8Array([b]));
        c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
afterEach(() => vi.useRealTimers());
describe("OpenRouter streaming contract", () => {
  it("handles arbitrary UTF-8 fragmentation, comments, empty choices and repeated finish reasons", async () => {
    const transport = vi.fn(async () =>
      response(
        ": heartbeat\r\n\r\n" +
          frame({ content: "€ hello" }) +
          'data: {"choices":[]}\n\n' +
          frame({}, "stop") +
          frame({}, "stop") +
          "data: [DONE]\n\n",
      ),
    );
    const deltas: string[] = [];
    const answer = await new OpenRouterClient(config, transport).stream(
      [],
      { signal: new AbortController().signal },
      async (t) => {
        deltas.push(t);
      },
    );
    expect(answer.content).toBe("€ hello");
    expect(deltas).toEqual(["€ hello"]);
    const body = JSON.parse(
      String(
        (transport.mock.calls[0] as unknown as [unknown, RequestInit])[1].body,
      ),
    );
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("parallel_tool_calls");
    expect(body.provider.require_parameters).toBe(true);
  });
  it("assembles interleaved tool argument deltas by index", async () => {
    const text =
      frame({
        tool_calls: [
          {
            index: 1,
            id: "b",
            function: { name: "list_accounts", arguments: "{" },
          },
          {
            index: 0,
            id: "a",
            function: { name: "get_account", arguments: '{"account' },
          },
        ],
      }) +
      frame(
        {
          tool_calls: [
            { index: 0, function: { arguments: 'Id":"123"}' } },
            { index: 1, function: { arguments: "}" } },
          ],
        },
        "tool_calls",
      ) +
      "data: [DONE]\n\n";
    const answer = await new OpenRouterClient(config, async () =>
      response(text),
    ).stream([], { signal: new AbortController().signal }, async () => {});
    expect(answer.tool_calls?.map((c) => [c.id, c.function.arguments])).toEqual(
      [
        ["a", '{"accountId":"123"}'],
        ["b", "{}"],
      ],
    );
  });
  it("parses multiline SSE data and split CRLF without premature dispatch", () => {
    const parser = new SSEParser();
    expect(parser.feed("id: 4\revent: tool.updated\r\ndata: {\n")).toEqual([]);
    expect(parser.feed('data: "x":1}\n\n')).toEqual([
      { id: "4", event: "tool.updated", data: '{\n"x":1}' },
    ]);
  });
  it.each([
    ["data: invalid\n\n", "AI_INVALID_RESPONSE"],
    [frame({ content: "partial" }), "AI_INTERRUPTED"],
    [frame({}, "length") + "data: [DONE]\n\n", "AI_LIMIT"],
    [
      'data: {"error":{"code":402,"message":"secret provider body"}}\n\n',
      "AI_CREDITS",
    ],
  ])("rejects malformed, incomplete and failed streams", async (text, code) => {
    await expect(
      new OpenRouterClient(config, async () => response(text)).stream(
        [],
        { signal: new AbortController().signal },
        async () => {},
      ),
    ).rejects.toMatchObject({ code });
  });
  it.each([
    [401, "AI_AUTHENTICATION"],
    [402, "AI_CREDITS"],
    [404, "AI_UNSUPPORTED_PARAMETERS"],
    [429, "AI_RATE_LIMIT"],
    [502, "AI_PROVIDER_FAILURE"],
    [504, "AI_TIMEOUT"],
  ])("maps safe errors for %s", async (status, code) => {
    const error = aiError(
      Number(status),
      {
        error: {
          message: "secret-key unsupported parameters",
          metadata: { key: "private" },
        },
      },
      "999",
    );
    expect(error.code).toBe(code);
    expect(JSON.stringify(error)).not.toMatch(/secret-key|private/);
    expect(error.details).toMatchObject({ retryAfterSeconds: 300 });
    await expect(
      new OpenRouterClient(
        config,
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Filter by Parameters" } }),
            { status: Number(status) },
          ),
      ).complete([]),
    ).rejects.toMatchObject({ code });
  });
  it("propagates cancellation to the provider and distinguishes idle timeout", async () => {
    const transport: typeof fetch = async (_url, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () =>
          reject(init!.signal!.reason),
        ),
      );
    const controller = new AbortController();
    const promise = new OpenRouterClient(config, transport).stream(
      [],
      { signal: controller.signal },
      async () => {},
    );
    controller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
    vi.useFakeTimers();
    const timed = new OpenRouterClient(config, transport).stream(
      [],
      { signal: new AbortController().signal },
      async () => {},
    );
    const assertion = expect(timed).rejects.toMatchObject({
      code: "AI_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(60001);
    await assertion;
  });
  it("retains schema and tools on nonstreaming requests", async () => {
    let body: Record<string, unknown> = {};
    const client = new OpenRouterClient(config, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
      );
    });
    await client.complete([], {
      vision: true,
      responseFormat: { type: "json_schema" },
      tools: [],
    });
    expect(body).toMatchObject({
      model: "openai/gpt-5.6-sol",
      response_format: { type: "json_schema" },
      tools: [],
      provider: { require_parameters: true },
    });
  });
});

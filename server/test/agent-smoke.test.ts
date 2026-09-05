import { describe, it, expect, vi } from "vitest";
import { inflateSync } from "node:zlib";
import {
  runSmokeChecks,
  smokeImage,
} from "../src/modules/agent/smoke-checks.js";
import { extractionSchema } from "../src/modules/imports/schemas.js";
import { aiError } from "../src/modules/agent/stream.js";
import { OpenRouterClient } from "../src/modules/agent/openrouter.js";
import { readConfig } from "../src/config.js";

const config = readConfig({
  DATABASE_URL: "postgresql://test:test@localhost/finance_test",
  REDIS_URL: "redis://localhost",
  OPENROUTER_API_KEY: "secret-key",
  OPENROUTER_MODEL_PRIMARY: "openai/gpt-5.6-sol",
  OPENROUTER_MODEL_VISION: "openai/gpt-5.6-sol",
});
function client() {
  return {
    compatibility: vi.fn(async () => ({})),
    stream: vi.fn(async () => ({
      tool_calls: [
        {
          id: "synthetic",
          type: "function" as const,
          function: { name: "list_accounts", arguments: "{}" },
        },
      ],
    })),
    complete: vi.fn(async () => ({
      content: JSON.stringify(extractionSchema.parse({})),
    })),
  };
}
describe("synthetic compatibility checks", () => {
  it("uses a valid PNG with correct checksums and complete RGB scanlines", () => {
    const png = Buffer.from(smokeImage.split(",")[1]!, "base64");
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const idat: Buffer[] = [];
    let width = 0,
      height = 0;
    for (let offset = 8; offset < png.length; ) {
      const size = png.readUInt32BE(offset);
      const type = png.toString("ascii", offset + 4, offset + 8);
      const data = png.subarray(offset + 8, offset + 8 + size);
      let crc = 0xffffffff;
      for (const b of png.subarray(offset + 4, offset + 8 + size)) {
        crc ^= b;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      expect((crc ^ 0xffffffff) >>> 0).toBe(
        png.readUInt32BE(offset + 8 + size),
      );
      if (type === "IHDR") {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        expect([...data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
      }
      if (type === "IDAT") idat.push(data);
      offset += size + 12;
    }
    expect(width).toBe(32);
    expect(height).toBe(32);
    const pixels = inflateSync(Buffer.concat(idat));
    expect(pixels.length).toBe(height * (1 + width * 3));
    for (let row = 0; row < height; row++) {
      expect(pixels[row * (1 + width * 3)]).toBe(0);
      expect(
        pixels
          .subarray(row * (1 + width * 3) + 1, (row + 1) * (1 + width * 3))
          .every((b) => b === 255),
      ).toBe(true);
    }
  });
  it("makes only two calls by default and rejects incomplete strict output", async () => {
    const c = client();
    const report = vi.fn();
    expect(await runSmokeChecks(c, false, report)).toBe(true);
    expect(c.complete).toHaveBeenCalledTimes(1);
    expect(c.stream).toHaveBeenCalledTimes(1);
    c.complete.mockResolvedValue({ content: "{}" });
    expect(await runSmokeChecks(c, false, report)).toBe(false);
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ check: "vision", status: "failed" }),
    );
  });
  it("does not report invented financial lines as a successful blank-image check", async () => {
    const c = client();
    c.complete.mockResolvedValue({
      content: JSON.stringify(
        extractionSchema.parse({
          positions: [{ confidence: 1, symbol: "FAKE" }],
        }),
      ),
    });
    expect(await runSmokeChecks(c, false, () => {})).toBe(false);
  });
  it("isolates image/schema requests without fallback or leaking failed provider metadata", async () => {
    const bodies: Record<string, any>[] = [];
    const transport: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/endpoints"))
        return Response.json({ data: {} });
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (body.stream)
        return new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"list_accounts","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
        );
      if (body.response_format?.json_schema.name === "finance_import")
        return Response.json(
          {
            error: {
              message:
                "No endpoints found that can handle the requested parameters.",
              metadata: { secret: "sensitive-provider" },
            },
          },
          { status: 404 },
        );
      return Response.json({
        choices: [
          { message: { content: body.response_format ? '{"ok":true}' : "OK" } },
        ],
      });
    };
    const reports: Record<string, unknown>[] = [];
    expect(
      await runSmokeChecks(new OpenRouterClient(config, transport), true, (r) =>
        reports.push(r),
      ),
    ).toBe(false);
    expect(bodies).toHaveLength(5);
    expect(reports.slice(1).map((r) => [r.check, r.status])).toEqual([
      ["chat", "passed"],
      ["vision", "failed"],
      ["vision.image_only", "passed"],
      ["vision.schema_only", "passed"],
      ["vision.image_schema", "passed"],
    ]);
    expect(bodies[2]).not.toHaveProperty("response_format");
    expect(bodies[2]!.messages[0].content).toHaveLength(2);
    expect(bodies[3]!.messages[0].content).toHaveLength(1);
    expect(bodies[4]!.messages[0].content).toHaveLength(2);
    for (const body of bodies) {
      expect(body.provider).toEqual({ require_parameters: true });
      expect(body.model).toBe(config.OPENROUTER_MODEL_VISION);
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("parallel_tool_calls");
      if (body.response_format)
        expect(body.response_format.json_schema.strict).toBe(true);
    }
    expect(reports[2]!.error).toMatchObject({
      code: "AI_UNSUPPORTED_PARAMETERS",
      upstreamStatus: 404,
    });
    expect(JSON.stringify(reports)).not.toMatch(
      /secret-key|sensitive-provider|metadata/,
    );
  });
  it("keeps diagnostic failures unsuccessful even when other checks pass", async () => {
    const c = client();
    c.complete.mockRejectedValue(aiError(402));
    expect(await runSmokeChecks(c, true, () => {})).toBe(false);
    expect(c.complete).toHaveBeenCalledTimes(4);
  });
  it("reports failed public metadata lookups as unknown", async () => {
    const result = await new OpenRouterClient(
      config,
      async () => new Response("{}", { status: 503 }),
    ).compatibility();
    expect(result.vision.compatible).toBeNull();
    expect(result.primary.compatible).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { readImageBytes } from "../src/modules/imports/images.js";
describe("transient multipart buffer ownership", () => {
  it("clears multipart chunks after copying the validated-size upload", async () => {
    const chunks = [Buffer.from("one"), Buffer.from("two")];
    async function* stream() {
      yield* chunks;
    }
    const bytes = await readImageBytes(stream(), 6);
    expect(bytes.toString()).toBe("onetwo");
    expect(chunks.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
      true,
    );
    bytes.fill(0);
  });
  it("clears chunks when uploads exceed limits or their stream fails", async () => {
    for (const fail of [false, true]) {
      const chunk = Buffer.from("private image");
      async function* stream() {
        yield chunk;
        if (fail) throw new Error("disconnected");
      }
      await expect(readImageBytes(stream(), fail ? 100 : 2)).rejects.toThrow();
      expect(chunk.every((byte) => byte === 0)).toBe(true);
    }
  });
});

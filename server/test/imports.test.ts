import { describe, it, expect } from "vitest";
import {
  extractionSchema,
  mergeExtractions,
  validateExtraction,
} from "../src/modules/imports/schemas.js";
import { validateImage } from "../src/modules/imports/images.js";
const position = {
  symbol: "CW8",
  quantity: "18.23",
  marketValue: "9483",
  currency: "EUR",
  confidence: 0.98,
};
describe("screenshot evidence validation", () => {
  it("asks for the observation date and never converts holdings into transactions", () => {
    const extraction = extractionSchema.parse({ positions: [position] });
    expect(validateExtraction(extraction)).toContain(
      "On what date were these positions observed?",
    );
    expect(extraction.transactions).toEqual([]);
    expect(extraction.positions[0]?.averageCost).toBeNull();
  });
  it("deduplicates repeated screenshots but flags conflicting quantities and dates", () => {
    const first = extractionSchema.parse({
      capturedAt: "2026-08-31T00:00:00Z",
      positions: [position],
    });
    const repeated = mergeExtractions(first, first);
    expect(repeated.positions).toHaveLength(1);
    const conflicting = mergeExtractions(
      first,
      extractionSchema.parse({
        capturedAt: "2026-09-01T00:00:00Z",
        positions: [{ ...position, quantity: "16.23" }],
      }),
    );
    expect(
      validateExtraction(conflicting).some((q) =>
        q.includes("conflicting observations"),
      ),
    ).toBe(true);
    expect(
      validateExtraction(conflicting).some((q) =>
        q.includes("different observation dates"),
      ),
    ).toBe(true);
  });
  it("rejects mismatched magic bytes, remote text and oversized image bodies", () => {
    expect(() =>
      validateImage(
        Buffer.from("https://example.com/image.png"),
        "image/png",
        1000,
      ),
    ).toThrow("matching image bytes");
    expect(() => validateImage(Buffer.alloc(100), "image/png", 10)).toThrow(
      "allowed size",
    );
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1200, 16);
    png.writeUInt32BE(2600, 20);
    expect(() => validateImage(png, "image/png", 1000)).not.toThrow();
    expect(() => validateImage(png, "image/jpeg", 1000)).toThrow();
  });
});

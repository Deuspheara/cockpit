import { describe, it, expect } from "vitest";
import { readConfig } from "../src/config.js";
import { hashToken } from "../src/modules/auth/service.js";
import { randomBytes } from "node:crypto";
describe("configuration and credentials", () => {
  it("requires database and Redis URLs", () => {
    expect(() => readConfig({})).toThrow();
  });
  it("rejects unreasonable upload and sync limits", () => {
    expect(() =>
      readConfig({
        DATABASE_URL: "postgres://localhost/finance",
        REDIS_URL: "redis://localhost",
        MAX_UPLOAD_MB: "200",
      }),
    ).toThrow();
    expect(() =>
      readConfig({
        DATABASE_URL: "postgres://localhost/finance",
        REDIS_URL: "redis://localhost",
        PROVIDER_SYNC_SECONDS: "1",
      }),
    ).toThrow();
  });
  it("hashes 256-bit credentials deterministically without storing plaintext", () => {
    const token = randomBytes(32).toString("base64url");
    expect(token).toHaveLength(43);
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });
});

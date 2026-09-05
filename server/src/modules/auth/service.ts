import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../db/index.js";
import { apiTokens } from "../../db/schema.js";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export class AuthService {
  constructor(private database: Database) {}
  async create(name: string) {
    const token = randomBytes(32).toString("base64url");
    const [record] = await this.database.db
      .insert(apiTokens)
      .values({ name, tokenHash: hashToken(token) })
      .returning({ id: apiTokens.id });
    return { id: record!.id, token };
  }
  async authenticate(header?: string): Promise<boolean> {
    if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return false;
    const [token] = await this.database.db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.tokenHash, hashToken(header.slice(7))),
          isNull(apiTokens.revokedAt),
        ),
      )
      .limit(1);
    if (!token) return false;
    await this.database.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(apiTokens.id, token.id),
          sql`(${apiTokens.lastUsedAt} IS NULL OR ${apiTokens.lastUsedAt} < now() - interval '5 minutes')`,
        ),
      );
    return true;
  }
  async revoke(id: string) {
    return this.database.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(eq(apiTokens.id, id))
      .returning({ id: apiTokens.id });
  }
}

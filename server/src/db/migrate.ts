import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connectDatabase } from "./index.js";
import { readConfig } from "../config.js";
export async function migrate(url: string) {
  const { sql, close } = connectDatabase(url);
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(64023001)`;
      await tx`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
      const directory = fileURLToPath(
        new URL("../../migrations/", import.meta.url),
      );
      for (const name of (await readdir(directory))
        .filter((n) => n.endsWith(".sql"))
        .sort()) {
        const existing =
          await tx`SELECT name FROM schema_migrations WHERE name = ${name}`;
        if (!existing.length) {
          await tx.unsafe(await readFile(`${directory}/${name}`, "utf8"));
          await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
        }
      }
    });
  } finally {
    await close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  await migrate(readConfig().DATABASE_URL);

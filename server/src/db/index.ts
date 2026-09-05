import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
export function connectDatabase(url: string) {
  // Drizzle changes postgres-js serializers. Keep its small pool separate from native SQL queries.
  const sql = postgres(url, {
    onnotice: () => {},
    max: 8,
    idle_timeout: 20,
    connect_timeout: 5,
    transform: { column: { from: postgres.toCamel } },
    types: {
      dateOnly: {
        to: 1082,
        from: [1082],
        serialize: (value: string) => value,
        parse: (value: string) => value,
      },
    },
  });
  const ormSql = postgres(url, {
    onnotice: () => {},
    max: 2,
    idle_timeout: 20,
    connect_timeout: 5,
  });
  return {
    sql,
    db: drizzle(ormSql, { schema }),
    close: async () => {
      await Promise.all([sql.end(), ormSql.end()]);
    },
  };
}
export type Database = ReturnType<typeof connectDatabase>;

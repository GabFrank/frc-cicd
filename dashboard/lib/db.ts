import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  __frcSqlite?: Database.Database;
};

const dbPath = process.env.DB_PATH ?? "./dev.db";

const sqlite = globalForDb.__frcSqlite ?? new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("busy_timeout = 5000");

if (!globalForDb.__frcSqlite) {
  globalForDb.__frcSqlite = sqlite;
}

export const db = drizzle(sqlite, { schema });
export { schema };

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
import { COMPONENTS, CHANNELS, INSTANCES } from "./config";

const dbPath = process.env.DB_PATH ?? "./dev.db";
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite, { schema });

function applySchema() {
  const sqlPath = path.join(process.cwd(), "drizzle", "0000_init.sql");
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Missing migration file: ${sqlPath}`);
  }
  const sql = fs.readFileSync(sqlPath, "utf8");
  sqlite.exec(sql);
}

async function main() {
  console.log(`[migrate] DB: ${dbPath}`);
  applySchema();
  console.log("[migrate] schema ok");

  for (const c of COMPONENTS) {
    const existing = db.select().from(schema.components).where(eq(schema.components.slug, c.slug)).all();
    if (existing.length === 0) {
      db.insert(schema.components).values({
        slug: c.slug,
        displayName: c.displayName,
        repoFullName: c.repoFullName,
        kind: c.kind,
      }).run();
    } else {
      db.update(schema.components)
        .set({ displayName: c.displayName, repoFullName: c.repoFullName, kind: c.kind })
        .where(eq(schema.components.slug, c.slug))
        .run();
    }
  }

  const allComponents = db.select().from(schema.components).all();
  const bySlug = new Map(allComponents.map((c) => [c.slug, c]));

  for (const [slug, chs] of Object.entries(CHANNELS)) {
    const comp = bySlug.get(slug);
    if (!comp) continue;
    for (const ch of chs) {
      const existing = db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.componentId, comp.id))
        .all()
        .filter((row) => row.name === ch.name);
      if (existing.length === 0) {
        db.insert(schema.channels).values({
          componentId: comp.id,
          name: ch.name,
          branch: ch.branch,
        }).run();
      }
    }
  }

  const allChannels = db.select().from(schema.channels).all();
  const channelByCompName = new Map(allChannels.map((c) => [`${c.componentId}:${c.name}`, c]));

  for (const inst of INSTANCES) {
    const comp = bySlug.get(inst.componentSlug);
    if (!comp) continue;
    const ch = inst.channelName ? channelByCompName.get(`${comp.id}:${inst.channelName}`) : undefined;
    const existing = db.select().from(schema.instances).where(eq(schema.instances.name, inst.name)).all();
    const values = {
      kind: inst.kind,
      name: inst.name,
      displayName: inst.displayName,
      host: inst.host ?? null,
      port: inst.port ?? null,
      componentId: comp.id,
      channelId: ch?.id ?? null,
      company: inst.company ?? null,
      environment: inst.environment ?? null,
      notes: inst.notes ?? null,
      active: true,
    };
    if (existing.length === 0) {
      db.insert(schema.instances).values(values).run();
    } else {
      db.update(schema.instances).set(values).where(eq(schema.instances.name, inst.name)).run();
    }
  }

  console.log(
    `[migrate] seed ok: ${COMPONENTS.length} components, ${INSTANCES.length} instances`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

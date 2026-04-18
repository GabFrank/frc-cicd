import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { parseSucursalFromSlot, withClient } from "@/lib/pg";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DiscoveryItem {
  kind: "publication" | "subscription" | "slot";
  name: string;
  direction: string | null;
  notes: string | null;
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAuth();
  if (guard) return guard;

  const { id } = await params;
  const numId = Number(id);
  const server = db.select().from(schema.monitoredServers).where(eq(schema.monitoredServers.id, numId)).get();
  if (!server) return NextResponse.json({ error: "server not found" }, { status: 404 });

  if (!server.pgHost || !server.pgPort || !server.pgDatabase) {
    return NextResponse.json({ error: "PG endpoint incompleto" }, { status: 400 });
  }
  const user = server.pgUser ?? process.env.PG_USER ?? "";
  const password = server.pgPassword ?? process.env.PG_PASSWORD ?? "";
  if (!user) return NextResponse.json({ error: "Sin pg_user" }, { status: 400 });

  const discovered: DiscoveryItem[] = [];
  let connectError: string | null = null;

  try {
    await withClient(
      {
        host: server.pgHost,
        port: server.pgPort,
        user,
        password,
        database: server.pgDatabase,
        statementTimeoutMs: 8000,
      },
      async (c) => {
        const pubs = await c.query<{ pubname: string }>("SELECT pubname FROM pg_publication ORDER BY pubname");
        for (const p of pubs.rows) {
          discovered.push({ kind: "publication", name: p.pubname, direction: null, notes: null });
        }

        const slots = await c.query<{ slot_name: string; slot_type: string }>(
          "SELECT slot_name, slot_type FROM pg_replication_slots ORDER BY slot_name",
        );
        for (const s of slots.rows) {
          const parsed = parseSucursalFromSlot(s.slot_name);
          discovered.push({
            kind: "slot",
            name: s.slot_name,
            direction: parsed.direction,
            notes: `slot_type=${s.slot_type}`,
          });
        }

        try {
          const subs = await c.query<{ subname: string }>("SELECT subname FROM pg_subscription ORDER BY subname");
          for (const s of subs.rows) {
            const parsed = parseSucursalFromSlot(s.subname);
            discovered.push({
              kind: "subscription",
              name: s.subname,
              direction: parsed.direction,
              notes: null,
            });
          }
        } catch (err) {
          // pg_subscription requiere SUPERUSER o GRANT explícito
          console.warn(`[discover] pg_subscription denegado en ${server.nombre}`, err instanceof Error ? err.message : err);
        }
      },
    );
  } catch (e) {
    connectError = e instanceof Error ? e.message : String(e);
  }

  if (connectError) {
    return NextResponse.json({ error: connectError }, { status: 502 });
  }

  let inserted = 0;
  let updated = 0;
  for (const it of discovered) {
    const existing = db
      .select()
      .from(schema.expectedReplication)
      .all()
      .find((e) => e.serverId === numId && e.kind === it.kind && e.name === it.name);

    if (existing) {
      const newDirection = it.direction ?? existing.direction;
      const newNotes = existing.notes ?? it.notes;
      if (newDirection !== existing.direction || newNotes !== existing.notes) {
        db.update(schema.expectedReplication)
          .set({ direction: newDirection, notes: newNotes })
          .where(eq(schema.expectedReplication.id, existing.id))
          .run();
        updated += 1;
      }
    } else {
      db.insert(schema.expectedReplication).values({
        serverId: numId,
        kind: it.kind,
        name: it.name,
        direction: it.direction,
        notes: it.notes,
      }).run();
      inserted += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    discovered: discovered.length,
    inserted,
    updated,
    items: discovered,
  });
}

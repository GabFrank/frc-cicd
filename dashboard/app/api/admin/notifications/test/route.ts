import { NextRequest, NextResponse } from "next/server";
import { formatRecipientNumber, getEvolutionConfig, sendTextMessage } from "@/lib/notifier/evolution";
import { requireAuth } from "@/lib/admin-guard";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;
  const { apiKey } = getEvolutionConfig();
  if (!apiKey) return NextResponse.json({ error: "evolution_not_configured" }, { status: 400 });

  const body = await req.json();
  const targetId = Number(body.targetId);
  if (!Number.isFinite(targetId)) return NextResponse.json({ error: "missing targetId" }, { status: 400 });
  const target = db.select().from(schema.notificationTargets).where(eq(schema.notificationTargets.id, targetId)).get();
  if (!target) return NextResponse.json({ error: "target not found" }, { status: 404 });

  const text =
    body.text != null && String(body.text).trim() !== ""
      ? String(body.text)
      : "FRC DASHBOARD · PRUEBA DE NOTIFICACIÓN.\nSI RECIBISTE ESTE MENSAJE, EL CANAL WHATSAPP ESTÁ OK.";

  const number = formatRecipientNumber(target.jid);
  const res = await sendTextMessage({ number, text });
  return NextResponse.json(
    { ok: res.ok, status: res.status, data: res.data },
    { status: res.ok ? 200 : res.status || 500 },
  );
}

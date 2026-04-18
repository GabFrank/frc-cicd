import { NextRequest, NextResponse } from "next/server";
import { connectInstance, createInstance, getConnectionState, getEvolutionConfig, restartInstance } from "@/lib/notifier/evolution";
import { requireAuth } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAuth();
  if (guard) return guard;
  const { instanceName, apiKey } = getEvolutionConfig();
  if (!apiKey) {
    return NextResponse.json({ configured: false, instanceName, message: "EVOLUTION_API_KEY not set" });
  }
  const r = await getConnectionState();
  return NextResponse.json({ configured: true, instanceName, evolution: r });
}

export async function POST(req: NextRequest) {
  const guard = await requireAuth();
  if (guard) return guard;
  const { apiKey } = getEvolutionConfig();
  if (!apiKey) return NextResponse.json({ error: "evolution_not_configured" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "connect").toLowerCase();

  if (action === "connect") {
    const r = await connectInstance();
    return NextResponse.json(r);
  }
  if (action === "restart") {
    const r = await restartInstance();
    return NextResponse.json(r);
  }
  if (action === "create") {
    const { instanceName } = getEvolutionConfig();
    const r = await createInstance({
      instanceName: body.instanceName ?? instanceName,
      integration: body.integration ?? "WHATSAPP-BAILEYS",
      qrcode: body.qrcode !== false,
      token: body.token,
    });
    return NextResponse.json(r, { status: r.ok ? 201 : r.status || 500 });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

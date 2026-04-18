const DEFAULT_TIMEOUT_MS = 25_000;

function headers(apiKey: string): HeadersInit {
  return {
    apikey: apiKey,
    "Content-Type": "application/json",
  };
}

export function getEvolutionConfig() {
  const baseUrl = (process.env.EVOLUTION_API_URL ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY ?? "";
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME ?? "frc-alertas";
  return { baseUrl, apiKey, instanceName };
}

export async function evolutionFetchJson<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const { baseUrl, apiKey } = getEvolutionConfig();
  if (!apiKey) {
    return { ok: false, status: 0, data: { error: "EVOLUTION_API_KEY_MISSING" } as T };
  }
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        ...headers(apiKey),
        ...(init?.headers as Record<string, string>),
      },
    });
    const data = (await res.json().catch(() => ({}))) as T;
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

/** Número o JID tal como lo espera POST /message/sendText */
export function formatRecipientNumber(jid: string): string {
  const j = jid.trim();
  if (j.includes("@g.us")) return j;
  if (j.includes("@s.whatsapp.net")) return j.replace(/@s\.whatsapp\.net$/i, "");
  if (j.includes("@")) return j;
  return j.replace(/\D/g, "");
}

export async function sendTextMessage(args: { number: string; text: string }) {
  const { instanceName } = getEvolutionConfig();
  return evolutionFetchJson<{
    key?: { id?: string; remoteJid?: string };
    status?: string;
  }>(`/message/sendText/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({ number: args.number, text: args.text }),
  });
}

export async function getConnectionState() {
  const { instanceName } = getEvolutionConfig();
  return evolutionFetchJson<{ instance?: { instanceName?: string; state?: string } }>(
    `/instance/connectionState/${encodeURIComponent(instanceName)}`,
    { method: "GET" },
  );
}

export async function connectInstance() {
  const { instanceName } = getEvolutionConfig();
  return evolutionFetchJson<{ pairingCode?: string; code?: string; count?: number }>(
    `/instance/connect/${encodeURIComponent(instanceName)}`,
    { method: "GET" },
  );
}

export async function restartInstance() {
  const { instanceName } = getEvolutionConfig();
  return evolutionFetchJson(`/instance/restart/${encodeURIComponent(instanceName)}`, {
    method: "PUT",
  });
}

export async function createInstance(body: Record<string, unknown>) {
  return evolutionFetchJson(`/instance/create`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

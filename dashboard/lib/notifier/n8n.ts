export async function dispatchAlertWebhook(payload: unknown): Promise<boolean> {
  const url = process.env.N8N_ALERT_WEBHOOK_URL?.trim();
  if (!url) return true;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn("[n8n] webhook non-ok", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[n8n] webhook failed", e);
    return false;
  }
}

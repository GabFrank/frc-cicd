import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parse ISO/SQL timestamp asegurando interpretación UTC.
 * SQLite `CURRENT_TIMESTAMP` retorna "YYYY-MM-DD HH:MM:SS" sin TZ; JS lo interpreta
 * como local → diff negativo en TZ no-UTC. Si no tiene Z ni offset explícito,
 * agregamos Z para forzar UTC.
 */
function parseTs(iso: string): number {
  const trimmed = iso.trim();
  // Detectar si ya tiene TZ (Z al final o ±HH:MM)
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalized = hasTz
    ? trimmed.replace(" ", "T")
    : `${trimmed.replace(" ", "T")}Z`;
  return new Date(normalized).getTime();
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = parseTs(iso);
  if (Number.isNaN(then)) return iso;
  let diff = Date.now() - then;
  const sign = diff < 0 ? "+" : ""; // futuro → "+Xs" en vez de "-Xs"
  diff = Math.abs(diff);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sign}${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${sign}${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${sign}${hr}h`;
  const d = Math.round(hr / 24);
  return `${sign}${d}d`;
}

export function statusToPill(status: string | null | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "success":
    case "up":
    case "ok":
    case "completed":
      return "pill pill-ok";
    case "failure":
    case "down":
    case "error":
    case "errored":
      return "pill pill-err";
    case "in_progress":
    case "pending":
    case "queued":
    case "waiting":
      return "pill pill-warn";
    case "inactive":
    case "neutral":
      return "pill pill-neutral";
    default:
      return "pill pill-info";
  }
}

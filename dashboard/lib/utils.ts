import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const d = Math.round(hr / 24);
  return `${d}d`;
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

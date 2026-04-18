import type { Alert, NotificationRule, NotificationStateRow } from "../schema";
import { alertPayloadHash } from "./payload-hash";

export type SendDecision =
  | { action: "send"; eventKind: "fired" | "resend" }
  | { action: "skip"; reason: "quiet" | "throttle" | "noop" };

function parseHm(s: string | null | undefined): { h: number; m: number } | null {
  if (!s?.trim()) return null;
  const [a, b] = s.trim().split(":");
  const h = Number(a);
  const m = Number(b);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

/** Minutos desde medianoche en la zona dada. */
export function minutesNowInTimeZone(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hh * 60 + mm;
}

function minutesFromMidnight(hm: { h: number; m: number }): number {
  return hm.h * 60 + hm.m;
}

/** Rango quiet; cruce de medianoche si start > end. */
export function isInQuietWindow(
  now: Date,
  timeZone: string,
  quietStart: string | null | undefined,
  quietEnd: string | null | undefined,
): boolean {
  const start = parseHm(quietStart);
  const end = parseHm(quietEnd);
  if (!start || !end) return false;
  const nowM = minutesNowInTimeZone(now, timeZone);
  const a = minutesFromMidnight(start);
  const b = minutesFromMidnight(end);
  if (a === b) return false;
  if (a < b) return nowM >= a && nowM < b;
  return nowM >= a || nowM < b;
}

function severityRank(s: string): number {
  if (s === "critical") return 3;
  if (s === "warn") return 2;
  return 1;
}

export function shouldSendOpenAlert(args: {
  now: Date;
  timeZone: string;
  alert: Alert;
  rule: NotificationRule;
  state: NotificationStateRow | undefined;
}): SendDecision {
  const { now, timeZone, alert, rule, state } = args;

  const quiet = isInQuietWindow(now, timeZone, rule.quietStart, rule.quietEnd);
  if (quiet) {
    const bypass = rule.quietBypassCritical === true && alert.severity === "critical";
    if (!bypass) return { action: "skip", reason: "quiet" };
  }

  if (!state) {
    return { action: "send", eventKind: "fired" };
  }

  const curRank = severityRank(alert.severity);
  const prevRank = severityRank(state.lastSeverity);
  if (curRank > prevRank) {
    return { action: "send", eventKind: "resend" };
  }

  const hash = alertPayloadHash(alert);
  if (state.lastPayloadHash && hash !== state.lastPayloadHash) {
    return { action: "send", eventKind: "resend" };
  }

  const lastSent = new Date(state.lastSentAt).getTime();
  const intervalMs = Math.max(1, rule.resendIntervalMin) * 60_000;
  if (!Number.isFinite(lastSent)) {
    return { action: "send", eventKind: "resend" };
  }

  if (now.getTime() - lastSent >= intervalMs) {
    return { action: "send", eventKind: "resend" };
  }

  return { action: "skip", reason: "throttle" };
}

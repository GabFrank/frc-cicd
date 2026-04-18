import { createHash } from "node:crypto";
import type { Alert } from "../schema";

export function alertPayloadHash(alert: Pick<Alert, "severity" | "title" | "detail">): string {
  const raw = `${alert.severity}|${alert.title}|${alert.detail ?? ""}`;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

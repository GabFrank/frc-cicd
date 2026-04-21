import { createHash } from "node:crypto";
import type { Alert } from "../schema";

// El hash se usa en throttle para decidir si un resend es legítimo. Incluir
// `detail` rompe eso: kinds como host_unreachable embeden "hace N ciclos" en
// el detail y el contador crece cada tick → el hash cambia cada minuto y
// el throttle interpreta eso como "el evento mutó, re-notificar".
// Hasheamos solo severity+title — severity escalada sí amerita resend, y un
// cambio de title también (otro objeto afectado). El detail es para mostrar.
export function alertPayloadHash(alert: Pick<Alert, "severity" | "title">): string {
  const raw = `${alert.severity}|${alert.title}`;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

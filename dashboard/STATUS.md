# Estado del dashboard — implementado vs pendiente

Corte: **2026-04-20**. Resumen operativo de qué está hecho en `frc-cicd/dashboard/` y qué falta para cerrar el MVP y pasar a producción.

## Resumen

- **MVP de monitoreo: operativo.** Se puede correr localmente y ya está recibiendo datos reales (GitHub + health + replicación).
- **Falta probar end-to-end la entrega de notificaciones por WhatsApp** (Evolution API + n8n ya instalados como servicios, pero sin emparejar instancia ni validar envío).
- **Falta deploy en droplet** (Docker Compose + nginx + backup host).

---

## Implementado

### Infra base
- Next.js 15 App Router + TS + Tailwind + shadcn tokens propios.
- SQLite via `better-sqlite3` + Drizzle ORM. WAL + `busy_timeout=5000`.
- `iron-session` con usuario/password en env.
- Runner standalone de jobs con mutex **por job** (no global) — `jobs/runner.ts`.
- Migraciones idempotentes (`lib/migrate.ts`) aplicadas en boot: `0000_init` → `0001_server_registry` → `0002_*` → `0003_alert_lifecycle`.
- Snapshot + restore automático del registry (`config-snapshot.json`) — defensa anti-wipe.

### Jobs periódicos (todos en `jobs/`)
| Job | Período | Estado |
|---|---|---|
| `sync-github` | 5 min | ✅ Releases, workflow_runs, PRs, deployments para los 4 repos |
| `sync-health` | 1 min | ✅ HTTP `actuator/health` + `/info` + `/metrics/*` por `monitored_servers` activo (central + filiales vía ZeroTier) |
| `sync-replication` | 2 min | ✅ PG por `server_id`: slots, pubs, subs, `pg_stat_replication`, size, conexiones, **WAL LSN + lag bytes + subscription age + apply_error_count (PG15+)** |
| `evaluate-alerts` | 1 min | ✅ 11 reglas con state machine (abajo) |
| `notify-alerts` | 1 min | ✅ Lógica completa de routing (Evolution directo + n8n webhook). **Falta prueba real end-to-end** |

### Registry editable (`/dashboard/admin`)
- CRUD de `monitored_servers` (kind, empresa, nombre, IP, appPort, channel, pgHost/Port/User/Password).
- CRUD de `expected_replication` (publications / subscriptions / slots por nombre exacto).
- Autodescubrimiento ("Discover replication") para prellenar esperadas desde el PG vivo.
- Export / import JSON del registry (`/api/admin/export`, `/api/admin/import`).
- Botón refresh manual por servidor.
- **Snapshot automático** tras cada cambio + restore en boot si la DB se reinicializa.

### Alert lifecycle (F10)
- Estado en `alerts`: `pending` → `firing` → `resolving` → `resolved`.
- `alert_rule_config` editable por kind desde `/dashboard/admin/alertas`: `pending_cycles`, `resolving_cycles`, `enabled`, severidad default.
- Skip auto-resolve si el job dependiente está unhealthy (mitigación sync-crash).
- Fingerprints versionados con `promotion_epoch` — evita dedupe entre fires separados.
- 11 kinds activos: `filial_no_success`, `filial_stale`, `filial_failure`, `filial_rollback`, `central_down`, `pg_cluster_down`, `replication_problem`, `pg_connections_high` (disabled default), `replication_lag_high`, `replication_apply_error`, `replication_stale`.

### UI
| Página | Estado |
|---|---|
| `/login` | ✅ |
| `/dashboard` (Overview) | ✅ 4 cards interactivos (Servidores tile grid, CI/CD, Replicación top lag, Version drift) + sidebar Alertas + contadores resumen + modal de server al clic |
| `/dashboard/cicd` | ✅ Workflow runs + releases + PRs por repo |
| `/dashboard/central` | ✅ 4 instancias (health, latencia, version, heap, uptime, threads) |
| `/dashboard/filiales` | ✅ Grid desde registry, sección "huérfanas" aparte |
| `/dashboard/replicacion` | ✅ Por server: card resumen + modal con expected vs found (ok / inactive / missing) |
| `/dashboard/alertas` | ✅ Activas + recientemente resueltas + dialog de gestión (ack, resolve) |
| `/dashboard/admin` | ✅ Servers + expected + export/import |
| `/dashboard/admin/alertas` | ✅ Tabla editable de `alert_rule_config` |
| `/dashboard/notificaciones` | ✅ UI: instance (QR), targets, rules, log |
| `/tv` | ✅ Fixed 2x2 grid, sidebar readOnly, sin rotación, polling 30s con `placeholderData` |

### Notifications stack
- Compose raíz `frc-cicd/docker-compose.yml` con `include:` → dashboard + `notifications/`.
- `notifications/docker-compose.yml`: Evolution API + Postgres + Redis + n8n.
- `lib/notifier/`: `evolution.ts`, `n8n.ts`, `router.ts`, `formatter.ts`, `throttle.ts`, `payload-hash.ts`.
- Tablas: `notification_targets`, `notification_rules`, `notification_log`, `notification_state`.
- APIs: `/api/admin/notifications/{instance,targets,rules,log,test}`.
- Duración incluida en mensaje `resolved` (`formatDuration(promotedAt, resolvedAt)`).

---

## Pendiente — para cerrar el monitoreo

### Pruebas end-to-end (prioridad alta)
- [ ] **WhatsApp**: emparejar instancia Evolution (QR), dar de alta un target + regla, forzar una alerta de prueba, confirmar mensaje recibido.
- [ ] Validar flujo `firing → resolving → resolved` con pausa programada (bajar un servicio 2 min, restaurar, esperar `resolving_cycles`).
- [ ] Validar `replication_lag_high` / `replication_apply_error` con una subscription real trabada.
- [ ] Confirmar que `notification_state` suprime re-fires dentro de la misma promotion_epoch.

### Deploy droplet (prioridad alta)
- [ ] Copiar `/opt/frc-cicd/` al droplet, `docker compose up -d --build`.
- [ ] nginx vhost + certbot para `dashboard.frc.tld` (y subdominios `n8n.`, `evolution.` si se exponen).
- [ ] Cron host para `deploy/backup.sh` diario 03:15.
- [ ] Registrar **todas las filiales restantes** (hoy registradas ~algunas de 25+) vía `/dashboard/admin` o import JSON.
- [ ] Verificar conectividad ZeroTier desde droplet a cada filial en `app_port` y `pg_port`.

### Pulido
- [ ] Runbook operativo corto (`RUNBOOK.md`): cómo reiniciar runner, cómo purgar alertas zombie manualmente, cómo rotar `SESSION_SECRET`.
- [ ] Documentar los 11 kinds y qué hacer ante cada uno (qué mirar primero).
- [ ] Verificar que `sync_runs` no acumule filas sin cap (agregar retention 30 días si crece mucho).

---

## Pendiente — opcional / post-MVP

- **Correlación de alertas**: suprimir `replication_problem` si `pg_cluster_down` está firing en el mismo server.
- **Ventanas de silencio programadas** para maintenance (hoy se puede con `enabled=false` por regla, pero no temporal).
- **Escalamiento automático** (notificar a target secundario si el primario no ACK en X min).
- **F6 Heartbeat filial** custom (HMAC endpoint `POST /api/ingest/filial`) — solo si GitHub Deployments no alcanza.
- **Management actions**: disparar `Deploy` workflow / promover release desde la UI con audit log.
- **Auth multi-usuario** con roles (hoy: 1 par user/pass en env).
- **Retention / archivado** de `alerts`, `health_checks`, `replication_check_results` (hoy crecen sin tope).

---

## Convenciones internas (recordatorio)

- Jobs NO corren dentro del proceso Next. Viven en `runner.ts`.
- Polling client-side 30 s via TanStack Query con `placeholderData` (no flicker en TV).
- `/tv` es solo lectura, sin modales ni botones.
- Fingerprints de alertas incluyen `srv:{server_id}` — no colisionan con el modelo viejo.
- Passwords PG vacíos se omiten del connection config (no se pasan como string vacío).
- Timestamps SQLite `CURRENT_TIMESTAMP` son UTC sin TZ; `parseTs()` agrega `Z` antes de parsear.

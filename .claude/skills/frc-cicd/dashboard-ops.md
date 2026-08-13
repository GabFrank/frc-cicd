# Dashboard de monitoreo FRC — operación

Dashboard vivo en **http://172.25.0.172:3000**. Fase de observación tras el deploy on-prem. Equipo dev lo usa para cazar bugs. Stack: Next.js 15 + SQLite (Drizzle) + TanStack Query.

## Acceso al host

`ssh franco@172.25.0.172`. Credenciales en `.env`. El host también actúa como filial piloto Linux (multi-rol).

**Compose único del stack:** `/opt/frc-cicd/docker-compose.yml` (project `frc-cicd`, net `frc-net`). **8 servicios** (ver tabla completa en [hosts.md](hosts.md)):
- `dashboard` (`frc-dashboard`, `ghcr.io/gabfrank/frc-dashboard:latest`, host `0.0.0.0:3000`)
- `jobs` (`frc-dashboard-jobs`, misma imagen — **el que corre `notify-alerts` y sync**)
- `migrate` (one-shot Drizzle al boot)
- `evolution-api` (`evoapicloud/evolution-api:v2.3.7`, host `127.0.0.1:8090->8080`)
- `evolution-postgres` + `evolution-redis` (internos — la sesión WhatsApp vive en el postgres)
- `n8n` (`n8nio/n8n:1.75.2`, host `127.0.0.1:5678`) + `n8n-postgres` (interno)

> Nota histórica: versiones viejas de esta doc decían "5 servicios, evolution en 8080, un solo postgres". Falso — corregido 2026-07-09 tras scan real.

## Gotcha crítico — DOCKER_HOST override

La cuenta `franco` tiene residuos de Docker Desktop (`~/.docker/desktop/docker.sock` inexistente). **Cualquier comando `docker` o `docker compose` sin override falla** con:

```
Cannot connect to the Docker daemon at unix:///home/franco/.docker/desktop/docker.sock
```

**Fix obligatorio para todo comando docker:**

```bash
DOCKER_HOST=unix:///var/run/docker.sock docker <subcommand>
```

Ejemplo:
```bash
ssh franco@172.25.0.172 "DOCKER_HOST=unix:///var/run/docker.sock docker ps"
ssh franco@172.25.0.172 "DOCKER_HOST=unix:///var/run/docker.sock docker compose -f /opt/frc-cicd/docker-compose.yml ps"
```

Franco está en grupos `wheel` y `docker`, así que no requiere `sudo` siempre que el socket apunte al correcto.

## DB del dashboard

SQLite en **`/data/dash.db`** dentro del contenedor, montado desde el volumen **`frc-cicd_dash-data`**.

```
/data/
├── dash.db          (SQLite, WAL mode)
├── dash.db-wal
├── dash.db-shm
└── config-snapshot.json
```

**Tablas principales** (ver `dashboard/lib/schema.ts` para schema completo):

- `monitored_servers` — inventario de servers monitoreados. Guarda `ip`, `pg_port`,
  `pg_database`, `pg_user`, `pg_password`, `channel`, `sucursal_id`, `active`.
  (Versiones viejas de esta doc decían `servers` — **esa tabla no existe**, corregido 2026-08-13.)
- `alerts` — alertas generadas. Columna `kind` = tipo de evento.
- `alert_rule_config` — cicles de pending/resolving por kind (editable via UI admin).
- `notification_rules` — filtros por kind/severity/server. CSV de kinds en `alert_kinds_csv`.
- `notification_targets` — destinos WhatsApp (JID, nombre, active).
- `notification_log` — historial de envíos.
- `notification_state` — deduplicación por fingerprint+target.
- `deployments`, `releases` — sync desde GitHub.
- `expected_replication` — expected peer_server_id por server.
- `instance_runtime`, `replication_check_results` — ⚠️ **sin datos frescos** (ver abajo).

### ⚠️ No confiar en el dashboard para versión ni replicación (verificado 2026-08-13)

Dos tablas quedaron congeladas y **no reflejan el estado real**:

| Tabla | Último dato | Consecuencia |
|---|---|---|
| `instance_runtime` | jul-2026, columnas `version`/`build`/`git_commit` **vacías** | no sirve para saber qué versión corre un host |
| `replication_check_results` | 2026-07-09 | no sirve para saber si la replicación está sana |

**Fuentes confiables en su lugar:**

- **Versión de una filial** → los *deployments* de GitHub, que la propia filial reporta
  al terminar su `check-update`, con su health check:
  ```bash
  gh api repos/GabFrank/franco-system-backend-filial/deployments \
    --jq '.[] | "\(.created_at) \(.environment) \(.ref)"'
  # y el estado:
  gh api repos/.../deployments/<id>/statuses --jq '.[0].state'   # success + "Health check passed (HTTP 200)"
  ```
  Cubre incluso filiales que no están en `monitored_servers` (p. ej. filial 6 farmacia).
- **Salud de la replicación** → `pg_replication_slots` en central, directo por psql
  (ver [runbooks/replication.md](../runbooks/replication.md)).
- **Versión instalada en disco** → `cat /opt/frc-filial/.current-version` por SSH.

## Hack para correr SQL ad-hoc

**El contenedor `frc-dashboard` NO tiene sqlite3 binario.** Para queries manuales, montar el mismo volumen en un contenedor auxiliar que SÍ pueda instalarlo:

```bash
ssh franco@172.25.0.172 'DOCKER_HOST=unix:///var/run/docker.sock \
  docker run --rm --entrypoint sh -v frc-cicd_dash-data:/data postgres:16-alpine \
  -c "apk add --no-cache sqlite > /dev/null 2>&1 && sqlite3 -header /data/dash.db \"SELECT ...;\""'
```

**Por qué `postgres:16-alpine`:** la imagen ya está pulleada en el host (cache), tiene `apk`, y puede instalar `sqlite` CLI en segundos. La imagen `alpine` directa **no es pulleable** porque Docker Desktop residual causa `docker-credential-desktop: executable file not found`.

Alternativas cacheadas también válidas: `redis:7-alpine`.

**SQLite WAL mode permite lector externo concurrente con writer del dashboard.** UPDATE ad-hoc es seguro, visible al instante para el job `notify-alerts` (sin cache interno).

## API admin requiere auth

`/api/admin/*` exige cookie de sesión (iron-session). `curl` sin cookie → `{"error":"unauthorized"}`.

La UI de `/dashboard/notificaciones/rules` actualmente solo permite **toggle active** y **delete**. NO tiene editor de reglas. Para cambiar `alert_kinds_csv` u otros campos, ir por SQL directo (hack de arriba) o recrear la regla.

## Catálogo de alert_kinds

Definidos como strings en `dashboard/lib/jobs/evaluate-alerts.ts`:

**Infraestructura:**
- `central_down` — instancia central DOWN (3 health checks seguidos)
- `host_unreachable` — host no responde TCP. Severidad escalonada info→warn→critical (12h/24h)
- `host_down` — ≥2 instancias centrales en misma IP caídas (correlación)
- `pg_cluster_down` — cluster PG caído
- `pg_connections_high` — conexiones PG por encima de threshold

**Replicación:**
- `replication_problem` — slot/sub/pub faltante o inactivo
- `replication_lag_high` — lag de slot >100MB/1GB
- `replication_stale` — subscription sin mensajes >10min/1h
- `replication_batch` — ≥2 objetos de replicación con problemas (agregado)

**Filiales:**
- `filial_no_success` — filial sin deployment exitoso
- `filial_stale` — filial sin actualización >2h (hoy deshabilitado, threshold pendiente)
- `filial_failure` — último deploy falló
- `filial_rollback` — rollback en filial

**GitHub:**
- `github_pr_opened` — PR no-draft abierto en últimas 2h
- `github_release_alpha` — release en canal alpha
- `github_release_beta` — release en canal beta
- `github_release_stable` — release en canal stable
- `github_workflow_failed` — workflow fallido

Todos los `github_*` tienen `severity: info` y son one-shot (se auto-resuelven tras notificar). Bypasean el filtro `min_severity` de la regla.

## Config actual de notificación (2026-04-22)

Target único = grupo WhatsApp "FRC DEVELOPERS" via Evolution API.

Regla id=1 con `alert_kinds_csv` filtrando **todos menos** `github_release_alpha`. Alpha releases NO notifican (ruido alto); beta + stable sí.

Para silenciar otro kind: UPDATE sobre ese CSV en sqlite (ver hack arriba).

Para silenciar un kind globalmente (no solo en notificación sino en generación de alerta): UI admin → `alert_rule_config` → toggle `enabled` del kind.

## Deploy del dashboard

GitHub Actions build+push a `ghcr.io/gabfrank/frc-dashboard:latest`. Host on-prem:

```bash
ssh franco@172.25.0.172 "cd /opt/frc-cicd && DOCKER_HOST=unix:///var/run/docker.sock docker compose pull dashboard && DOCKER_HOST=unix:///var/run/docker.sock docker compose up -d dashboard"
```

Migraciones Drizzle corren al boot del contenedor. No hay rollback automático — si la migración rompe, hay que downgrade manual.

## Pendiente (deferred)

- Re-habilitar `filial_stale` tras calibrar threshold (hoy OFF por falsos positivos).
- Editor de reglas en UI (hoy solo toggle+delete).
- Normalizar pub/sub naming en filiales (ver [runbooks/replication.md](runbooks/replication.md)) para poder reactivar schedulers replicación.
- Migrar workflow `r0adkll/upload-google-play` del input `track` deprecado a `tracks`.

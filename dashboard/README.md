# frc-dashboard

Dashboard de monitoreo externo del SaaS **FRC Comercial** (Franco Systems ERP). Snapshot en vivo del estado CI/CD, versiones desplegadas, salud de los servidores centrales y estado de filiales.

> Plan de implementación completo: `../../.claude/plans/en-este-proyecto-expressive-gosling.md`.

## Stack

- **Next.js 15** App Router + TypeScript (SSR + API routes)
- **SQLite** + `better-sqlite3` + **Drizzle ORM** (archivo local, sin servidor DB externo)
- **Tailwind CSS** + **TanStack Query** (polling 30s client-side)
- **Octokit** (GitHub REST API)
- **iron-session** (auth simple user/pass)
- **Docker Compose** (2 contenedores: `dashboard` Next + `jobs` runner standalone, volumen SQLite compartido)

## Páginas

| Ruta | Qué muestra |
|---|---|
| `/dashboard` | Overview: versión por canal de los 4 componentes, contador de alertas, últimas syncs |
| `/dashboard/cicd` | Workflow runs, releases y PRs abiertos por repo |
| `/dashboard/filiales` | Grid de filiales: versión actual, último intento, historial reciente |
| `/dashboard/central` | Las 4 instancias del central: health, latencia, versión runtime (actuator/info), heap, uptime, threads, deployments recientes |
| `/dashboard/replicacion` | Por servidor monitoreado (central + filiales vía ZeroTier): estado PG, versión, tamaño DB, conexiones, latencia, y lista **expected vs found** de cada pub/sub/slot registrado en Admin |
| `/dashboard/admin` | CRUD de servidores monitoreados + replicación esperada (pub/sub/slot por nombre exacto, no heurística) |
| `/dashboard/alertas` | Alertas activas + recientemente resueltas |
| `/tv` | Vista fullscreen rotatoria para monitor de oficina |
| `/login` | Login con user/pass de `.env` |

## Arranque local

```bash
cd frc-cicd/dashboard
cp .env.example .env.local
# editar:
#   GITHUB_PAT=ghp_…              ← PAT con scope `repo`
#   SESSION_SECRET=…               ← string aleatorio ≥32 chars
#   AUTH_USER=admin
#   AUTH_PASS=secret
#   DB_PATH=./dev.db
#   PG_USER=franco                ← opcional, para monitoreo replicación
#   PG_PASSWORD=…
#   PG_CLUSTERS=5551:central-prod:alpha,farmacia,bodega,5552:central-beta:beta
npm install
npm run db:migrate                 # crea tablas + seed de componentes/instancias
npm run jobs:dev &                 # runner en background
npm run dev                        # Next en :3000
```

En <5 min el runner imprime `[runner] sync-github ok …` y la UI se puebla con datos reales.

### Verificación
```bash
curl -s http://localhost:3000/api/data/overview | jq '.components[].slug'
curl -s http://localhost:3000/api/data/filiales | jq '.[].displayName'
curl -XPOST http://localhost:3000/api/sync/github   # trigger manual
```

## Jobs periódicos

| Job | Frecuencia | Qué hace |
|---|---|---|
| `sync-github` | 5 min | Pull de releases / workflow_runs / PRs / deployments de los 4 repos, upsert en SQLite |
| `sync-health` | 1 min | `GET http://localhost:808{1..4}/actuator/health` a las instancias del central; si OK, enriquece con `/actuator/info` + `/actuator/metrics/*` (version, heap, uptime, threads) |
| `sync-replication` | 2 min | Itera **`monitored_servers`** (registrados en `/dashboard/admin`), conecta al PG endpoint declarado de cada uno (central por localhost, filiales vía ZeroTier), snapshotea `pg_replication_slots`, `pg_publication`, `pg_subscription`, `pg_stat_replication`, `pg_database_size`, `pg_stat_activity`, `empresarial.sucursal`, y compara contra `expected_replication` (pub/sub/slot por nombre exacto). Resultado por entrada: `ok` / `found · inactive` / `missing`. Usa `pg_user`/`pg_password` por servidor; cae a env `PG_USER`/`PG_PASSWORD` si están vacíos. |
| `evaluate-alerts` | 1 min | Reglas: filial sin update >2h, filial con último deploy `failure`, rollback detectado, central DOWN 3 checks seguidos, cluster PG DOWN, slot de replicación inactivo |

> **Los jobs NO corren dentro del proceso Next.** Viven en `jobs/runner.ts`, contenedor aparte que comparte volumen SQLite con el dashboard.

## Estructura

```
app/           Páginas Next (App Router) + API routes
lib/           db, schema, github, config, auth, utils
jobs/          runner.ts, sync-github.ts, sync-health.ts, evaluate-alerts.ts
components/    Nav, QueryProvider, PollQuery hook
drizzle/       0000_init.sql (schema)
deploy/        nginx.conf.example, backup.sh
```

## Deploy en droplet

Asumido: mismo droplet donde corre el backend central (Ubuntu, systemd, `nginx` nuevo a instalar).

**Opción A — solo dashboard** (sin WhatsApp): copiar solo `frc-cicd/dashboard/` y `docker compose up` dentro de esa carpeta.

**Opción B — dashboard + Evolution + n8n**: clonar el repo **frc-cicd** completo y usar el compose raíz:

```bash
# 1. Clonar frc-cicd en el droplet
ssh deploy@droplet
mkdir -p /opt/frc-cicd && cd /opt/frc-cicd
# copiar repo (incluye dashboard/ y notifications/)

# 2. Variables (dashboard + notifications)
cp notifications/.env.example notifications/.env
# editar GITHUB_PAT, SESSION_SECRET, AUTH_*, CENTRAL_BASE_URL, EVOLUTION_*, N8N_*

# 3. Build + up (desde la raíz frc-cicd)
docker compose --env-file dashboard/.env --env-file notifications/.env up -d --build
docker compose logs -f jobs

# 4. nginx + TLS (una sola vez)
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/frc-dashboard.conf
sudo ln -s ../sites-available/frc-dashboard.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dashboard.frc.tld

# 5. Backup automático del host (cron diario 03:15)
sudo cp deploy/backup.sh /usr/local/bin/frc-dash-backup.sh
sudo chmod +x /usr/local/bin/frc-dash-backup.sh
echo "15 3 * * * root /usr/local/bin/frc-dash-backup.sh" | sudo tee /etc/cron.d/frc-dash-backup
```

## Troubleshooting

| Síntoma | Diagnóstico | Fix |
|---|---|---|
| Overview vacío | `sync_runs` sin filas o con `ok=0` | `docker compose logs jobs`; verificar `GITHUB_PAT` válido y scope `repo` |
| `GitHub API rate limit exceeded` | Ritmo de sync muy alto | Subir `SYNC_GITHUB_INTERVAL_MS` (default 300000 = 5 min) |
| Central siempre DOWN | `CENTRAL_BASE_URL` mal seteado | En Docker debe ser `http://host.docker.internal` + `extra_hosts: host-gateway` |
| Filial sin datos | Scripts `check-update.sh` no están escribiendo deployments | Verificar `/opt/frc-filial/logs/update.log` en la filial y el PAT en `.github-token` |
| Login rechaza creds correctas | `SESSION_SECRET` distinto a la sesión emitida | Borrar cookie, login de nuevo; si persiste, revisar que ambos servicios comparten `.env` |
| SQLite "database is locked" | WAL bien, pero escritura concurrente extrema | Ya hay `busy_timeout=5000`. Si persiste, reducir frecuencia de jobs |

## Escalamiento futuro (fuera de MVP)

- **F6** — Heartbeat custom desde filiales + lectura de `pg_stat_subscription` para estado de replicación. Requiere endpoint `POST /api/ingest/filial` con HMAC y 1 línea extra en `check-update.sh`.
- **F8 (implementado)** — **Evolution API** + **n8n** opcional: carpeta [`../notifications/`](../notifications/) con compose propio; orquestación desde la raíz del repo con [`docker-compose.yml`](../docker-compose.yml) (`include`). El job `notify-alerts` (tras `evaluate-alerts`) envía por WhatsApp según reglas en DB; `N8N_ALERT_WEBHOOK_URL` dispara un webhook adicional. UI: `/dashboard/notificaciones`.
- **Management**: disparar deploys, aprobar promociones, rollback desde la UI. Fase posterior con permisos granulares y audit log.

## Seguridad

- El `GITHUB_PAT` tiene scope `repo` — no se expone al cliente, solo el runner y el API route `/api/sync/github` lo usan.
- Las cookies de sesión son `httpOnly` + `secure` en producción.
- `SESSION_SECRET` debe ser ≥32 chars. Rotar periódicamente invalida todas las sesiones vigentes.
- El dashboard solo se publica tras nginx con basic auth opcional para segundo factor.

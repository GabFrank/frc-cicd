# frc-cicd

Documentación, runbooks y scripts para la implementación de CI/CD en los **5 componentes** de **FRC Sistemas Informáticos** (Franco Systems ERP v3):

| Componente | Repo | Stack |
|---|---|---|
| **central** | `GabFrank/franco-system-backend-servidor` | Spring Boot **2.7.18** / target Java **11** / GraphQL / PostgreSQL. Corre sobre **JVM 17** en producción |
| **filial** | `GabFrank/franco-system-backend-filial` | Spring Boot 2.1.15 / Java 8 / GraphQL / PostgreSQL |
| **desktop** | `GabFrank/frc-sistemas-integrados-angular` | Angular 15 + Electron 22 |
| **mobile** | `GabFrank/frc-mobile` | Angular 15 + Ionic 6 + Capacitor 5. **En mantenimiento**, lo reemplaza `mobile-pwa` |
| **mobile-pwa** | `GabFrank/frc-mobile-pwa` (privado) | Angular 21 standalone zoneless + Material 21 + Apollo 4. Se despliega en **Cloudflare Pages** — ver [plan-cicd-mobile-pwa.md](plan-cicd-mobile-pwa.md) |

## Stack dashboard + WhatsApp (Docker)

Desde la raíz de **frc-cicd** (Compose v2.20+):

```bash
cp dashboard/.env.example dashboard/.env
cp notifications/.env.example notifications/.env
# editar dashboard/.env (GITHUB_PAT, SESSION_SECRET, AUTH_*, CENTRAL_BASE_URL, …)
# editar notifications/.env (EVOLUTION_*, N8N_*)

docker compose --env-file dashboard/.env --env-file notifications/.env up -d --build
```

Incluye `dashboard/` (Next + jobs + SQLite) y `notifications/` (Evolution API + n8n). Red Docker: `frc-net`. Detalle: [notifications/README.md](notifications/README.md) y [dashboard/README.md](dashboard/README.md).

## Contenido

- **`plan-implementacion-cicd.md`** — Plan maestro de implementación CI/CD
- **`plan-ejecucion-maestro.md`** — Plan de ejecución detallado con fases y tareas
- **`guia-desarrollo-cicd.md`** — Guía consolidada para desarrolladores (commits, PRs, releases, deploys, hotfix, Flyway)
- **`flujo-cicd-backend-central.md`** — Flujo específico del backend central
- **`runbook-migracion-central-beta.md`** — Runbook para migrar central al canal beta
- **`runbook-migracion-filial-linux-beta.md`** — Runbook para migrar filiales Linux al canal beta
- **`runbook-migracion-filial-windows-beta.md`** — Runbook para migrar filiales Windows al canal beta
- **`runbook-backfill-replica-bidireccional.md`** — Runbook para rellenar un gap de réplica lógica en el central sin que reboten los datos a la filial (origin trick)
- **`scripts/`** — Scripts de auto-update y arranque para filiales

## Flujo de ramas

```
feature/* --PR--> develop (alpha) --PR--> release/beta (beta) --PR--> master (stable)
hotfix/*  --PR--> master --> PR obligatorio a develop
```

## Modelo de deploy

| Componente | Mecanismo |
|---|---|
| central | GitHub Actions `workflow_dispatch` manual con aprobación |
| filial | Auto-update cada 15 min vía `check-update.sh` / `.ps1` |
| desktop | `electron-updater` auto-update con consentimiento del usuario |
| mobile | Bundle web automático vía CapacitorUpdater; APK manual vía Play Store |

---
name: frc-cicd
description: Conocimiento operativo del ecosistema FRC Sistemas Informáticos — CI/CD de los 4 repos del SaaS Franco Systems (central, filial, desktop, mobile), inventario de hosts on-prem, dashboard de monitoreo, runbooks reutilizables y gotchas aprendidos en producción. Invocá esta skill cuando la tarea toque cualquier host FRC, release, deploy, filial/central, dashboard, o selección de canal mobile.
---

# FRC CI/CD — skill del operador

Esta skill concentra lo que aprendí operando el sistema FRC Sistemas Informáticos (dominio interno: "Franco Systems ERP v3", también llamado frc-comercial + dashboard frc-cicd). La mayoría del conocimiento estable vive en sub-documentos de este directorio; el SKILL.md solo índice y convenciones transversales.

## Antes de tocar nada

1. **Esta skill es la fuente única del conocimiento durable.** Arquitectura, procedimientos, gotchas, convenciones. Si necesitás saber cómo opera algo, empieza acá.
2. **Secretos y credenciales viven en `.env`**, no en skill ni memoria. Path: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-cicd/.env`. Si necesitás un password SSH, token GitHub, URL de dashboard, etc., leé ahí. El archivo no se commitea (está en `.gitignore`).
   - Si encontrás información nueva que debería estar ahí (host nuevo, credencial de una filial que no estaba, etc.) **agregá la entrada**. El archivo es deliberadamente incremental.
   - **Login del usuario dev (prueba) de la app**: para ingresar a la app en un test (desktop o web) las credenciales están en **`frc-comercial/dev_user_cred.txt`** (`USER=` / `PASS=`). Vive en la carpeta paraguas `frc-comercial/` (no es repo git) → no se commitea. Nunca tipear/adivinar contraseñas ni volcar su contenido a chat/commits.
3. **Memoria del proyecto** (`/Users/gabfranck/.claude/projects/.../memory/MEMORY.md`) — **solo estado transitorio**: qué regla WhatsApp corre hoy, qué versión corre cada host, qué PRs están abiertos, pendientes operacionales vigentes. Léela para contexto actual. **No dupliques conocimiento durable ahí** — eso va en esta skill.
4. **CLAUDE.md de los repos** son fuentes de verdad convencional (flujo de branches, merge strategy, "lo que NUNCA hacer"). No lo contradigas.
5. **No te apoyes solo en memoria de tipo transitorio** — siempre corroborá con el sistema real antes de actuar (git log, actuator/info, ssh directo, sqlite query al dash.db).

## Navegación rápida

| Necesidad | Doc |
|---|---|
| ¿Qué IPs/hosts existen y cómo entro? | [hosts.md](hosts.md) |
| **VPN headscale/tailscale — server, enrolar/remover nodos, ACL, rollout por filial** | [runbooks/headscale.md](runbooks/headscale.md) |
| ¿Cómo funcionan los 4 repos + frc-cicd? | [repos.md](repos.md) |
| Jira Auto-Agent (resolución automatizada de issues) | [jira-auto-agent.md](jira-auto-agent.md) |
| Canal selector mobile + Play Store tracks | [mobile-channels.md](mobile-channels.md) |
| SSH al dashboard, sqlite, alertas WhatsApp | [dashboard-ops.md](dashboard-ops.md) |
| Lecciones aprendidas a golpes (leer antes de cada sesión) | [gotchas.md](gotchas.md) |
| Cómo funciona `check-update.sh` end-to-end | [runbooks/check-update-flow.md](runbooks/check-update-flow.md) |
| **Filial pegada en versión vieja — diagnóstico (4 modos de falla)** | [runbooks/stuck-filial-diagnosis.md](runbooks/stuck-filial-diagnosis.md) |
| **Filial nómade (Suc. Fiesta) — bajar y reincorporar la replicación** | [runbooks/filial-nomade.md](runbooks/filial-nomade.md) |
| **Migrar el servidor de una filial a otra máquina** | `frc-cicd/runbook-cutover-filial1.md` en el repo (ejecutado 2026-08-20) + los gotchas de migración en [gotchas.md](gotchas.md) |
| Sudoers NOPASSWD — patrones y fixes | [runbooks/sudoers-patterns.md](runbooks/sudoers-patterns.md) |
| Override `sucursalId` vía application.properties | [runbooks/application-properties-overlay.md](runbooks/application-properties-overlay.md) |
| Replicación PostgreSQL (schedulers, pub/sub) | [runbooks/replication.md](runbooks/replication.md) |
| Scripts de escaneo solo-lectura (auditoría pre/post migración) | [runbooks/scans.md](runbooks/scans.md) |
| Dry-run de migración (validar JAR nuevo contra DB prod) | [runbooks/dry-run-migration.md](runbooks/dry-run-migration.md) |
| Statusline de Claude Code (repo + branch, ctx, rate limit) | [runbooks/claude-code-statusline.md](runbooks/claude-code-statusline.md) |

## Convenciones transversales del proyecto

- **⚠️ «beta» ES la red de farmacia, y es producción.** No hay canal beta de laboratorio. Los canales reales son **`alpha`** (laboratorio en mauro), **`farmacia`** (serie beta: central `:8082` + sus 6 filiales + cajas) y **`bodega`** (serie stable: central `:8081` + 17 filiales). Promover a `release/beta` publica a una farmacia que factura. Y **cliente y backend van juntos por canal**: si el central de farmacia corre beta, su desktop y su PWA corren beta. Las puertas de Cloudflare siguen ese mapa (`farmacia.*` → proyecto beta desde 2026-08-20); `beta.*` es ensayo interno, no un canal del producto.
- **Idioma del dominio:** español (entidades, columnas, logs de producto, UI). Identificadores de código en inglés, commits en inglés con prefijos convencionales.
- **Branches en los 4 repos:** `master` (no `main`) + `release/beta` (long-lived, no `release/x.y.z`) + `develop`. Todas protegidas con `enforce_admins=true`.
- **Merge strategy:** `release/beta → master` con **merge commit**, NO squash. Squash rompe cálculos de semantic-release. En los otros PRs cualquier estrategia razonable sirve pero por defecto **merge commit**.
- **Hotfix sale de `master`**, no de `develop`. Después del merge, PR obligatorio `master → develop`.
- **Commits:** `feat:` → minor, `fix:` → patch, `feat!:` → major. `chore:` / `refactor:` / `ci:` / `docs:` / `test:` / `perf:` no liberan.
- **Push directo a `master`/`release/beta`/`develop`:** nunca. Siempre vía PR.
- **Red / VPN:** **headscale es la VPN oficial del ecosistema; ZeroTier se está retirando.** Toda máquina nueva se enrola en headscale (`hs.farmaciafrancopy.com`), nunca en ZeroTier. Las filiales van a cliente nativo, no por bridge. Procedimiento y gotchas en [runbooks/headscale.md](runbooks/headscale.md).
- **Testeo de UI del desktop como web:** desde 2026-08 el `desktop` se puede servir como web pura (`ng serve`) y manejar con la extensión de Chrome, sin empaquetar Electron. Útil para validar UI/GraphQL rápido. Detalle, guards y gotchas en la skill **frc-desktop → build-deploy.md**. Login con `frc-comercial/dev_user_cred.txt` (ver punto 2). No cubre features Electron-only (impresión térmica, IPC).

## Cómo actualizar esta skill

Regla: **solo procedimiento durable.** Nunca guardar versiones actuales, PRs abiertos, passwords, tags, etc. Eso va en `.env`, en la memoria del proyecto, o se consulta al sistema real en caliente.

Cada vez que descubras un gotcha operacional nuevo (comando que falla por X, workflow con input contraintuitivo, limitación de Play Console, etc.) que te tomó tiempo entender, agregalo a [gotchas.md](gotchas.md) con: (1) qué pasó, (2) por qué, (3) cómo se resuelve.

Cada vez que aparezca un host nuevo o cambien IPs, actualizá [hosts.md](hosts.md) y el `.env`.

**Antes de agregar algo a esta skill**, preguntate: ¿es durable (vale en 3 meses) o transitorio (cambia en 2 semanas)? Si transitorio → va en memoria del proyecto, no acá. Si durable → acá.

**Retiro de gotchas:** si un gotcha se resuelve estructuralmente (e.g. el problema de sudoers ALL=ALL se corrige en todas las filiales), marcalo como "resuelto YYYY-MM-DD" y moverlo a un bloque inferior "Histórico". Tras 2 sesiones sin aparecer → borrar. Evita que el archivo crezca sin control.

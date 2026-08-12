# Repos del ecosistema FRC

6 repos en total: 5 del producto + 1 de CI/CD.

> `frc-mobile-pwa` (#5) es el más nuevo y **todavía no tiene CI/CD**. Las convenciones de branches y semantic-release de este documento aplican a los **4 originales**; ver su entrada para el detalle.

## 1. `GabFrank/franco-system-backend-servidor` (central)

Path local: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/central/`

Stack: Spring Boot 2.1.15, **Java 8**, GraphQL (graphql-java-kickstart), PostgreSQL, Maven. Package root `com.franco.dev`. Versión actual serie 4.x.

**Deploy:** GitHub Actions workflow `Deploy` con `workflow_dispatch`. Inputs:
- `version` — tag a deployar (e.g. `v4.1.0-beta.3`)
- `instance` — qué instancia del central (ver hosts.md): `bodega` / `farmacia` / `alpha` / `beta`

Workflow hace `ssh deploy@172.25.1.200` → descarga JAR del GitHub Release → actualiza symlink → `systemctl restart frc-<instance>.service`. Es **manual con aprobación** — una versión puede correr en 3 instancias físicas distintas a la vez.

**Flyway:** migraciones en `src/main/resources/db/migration/V*.sql`. La última migración crítica vista fue `V118__remove_inutilizacion_from_central_pub.sql` que saca `evento_inutilizacion_de` del publication `central_pub` (tabla central-only que no debe replicarse).

## 2. `GabFrank/franco-system-backend-filial` (filial)

Path local: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/filial/`

Stack idéntico a central: Spring Boot 2.1.15 / Java 8 / GraphQL / PostgreSQL.

**Deploy:** NO hay SSH desde CI. Las filiales consultan solas via `check-update.sh` / `check-update.ps1` cada 15 min. El workflow CI solo genera el tag + AAB — la propagación es pull-from-filial, no push-from-CI.

Ver [runbooks/check-update-flow.md](runbooks/check-update-flow.md) para detalle del flujo.

## 3. `GabFrank/frc-sistemas-integrados-angular` (desktop)

Path local: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/desktop/`

Stack: Angular 15 + Electron 22 + Apollo Client (GraphQL). Windows + Linux installer.

**Deploy:** `electron-updater` chequea cada 5 min el manifest YAML del canal (`alpha.yml` / `latest.yml`) publicado en el GitHub Release. Nombres de assets: `FRC-Setup.exe` (Windows), `FRC.AppImage` (Linux). Usuario acepta el dialog "Cerrar y actualizar".

**Nunca renombrar** `FRC-Setup.exe` o `FRC.AppImage` sin coordinar — el updater busca ese nombre literal.

## 4. `GabFrank/frc-mobile` (mobile)

Path local: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/mobile/`

Stack: Angular 15 + Ionic 6 + Capacitor 5. Android-only. Package `com.sistemasinformaticos.frc`.

**Deploy:** solo Play Store (no OTA). Ver [mobile-channels.md](mobile-channels.md) para el modelo de 3 tracks.

Workflow `Deploy to Play Store` (`workflow_dispatch`, input `track: internal|alpha|beta|production`) descarga AAB del GitHub Release y sube con `r0adkll/upload-google-play@v1`.

## 5. `GabFrank/frc-mobile-pwa` (mobile-pwa) — **reemplaza a `frc-mobile`**

Path local: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/mobile-pwa/`

**Repo privado.** Stack: Angular 21 standalone zoneless + Material 21 + Apollo 4. Sin Ionic, sin Capacitor: web puro. Node 20.20. Dev server en **4300**.

**Estado (2026-08-05): en desarrollo, sin CI/CD todavía.** No tiene `.github/workflows/`, ni `.releaserc.json`, ni tags. No aplica el flujo de semantic-release de los otros 4 — **todavía**. Cuando entre, hay que decidir el mecanismo de deploy, que no tiene equivalente en los otros repos: una PWA se despliega como sitio estático + service worker, y la actualización la maneja `@angular/service-worker`, no `electron-updater` ni Play Store.

**Por qué existe:** reemplaza la APK de Capacitor. Motivos: **soporte de iOS** (lo que la APK no daba), actualización sin Play Store, y que solo el 3,5% del código tocaba APIs nativas.

**Deploy previsto:** subdominios HTTPS por Cloudflare. `getUserMedia`, service worker y geolocalización exigen contexto seguro, así que servir por IP de LAN no alcanza. Ver `docs/analisis/runbook-cloudflare.md` en el repo.

> ⚠️ **`frc-mobile` sigue vivo** en modo mantenimiento durante la transición. Un bug reportado de "el mobile" puede ser de cualquiera de los dos: preguntar cuál.

## 6. `frc-cicd` (monorepo de operación)

Path local: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-cicd/`

No es repo del producto, es operacional: docs + dashboard + scripts + runbooks.

Contenido:
- `dashboard/` — Next.js 15 + SQLite + Drizzle (app de monitoreo, ver [dashboard-ops.md](dashboard-ops.md)).
- `notifications/` — Evolution API + n8n (infra de notificaciones WhatsApp).
- `jira/` — export de Jira Automation rules (auto-agent dispatch).
- `runbook-migracion-*.md` — procedimientos de migración al canal beta.
- `scripts/` — `check-update.sh`, `check-update.ps1`, `run-update.bat`, `frc.service` unit, `claude-watcher.sh` (fallback), `claude-watcher-start.sh`.
- `.env` — secretos locales (no commiteado).
- `plan-*.md`, `guia-*.md` — documentación de diseño.

### Jira Auto-Agent

Los 4 repos tienen `jira-receiver.yml` en `.github/workflows/` que recibe dispatches de Jira y crea GitHub Issues. Claude Code Routines (cloud, plan Max) se disparan automaticamente al detectar issues con label `jira-auto`. Ver [jira-auto-agent.md](jira-auto-agent.md) para detalle completo del flujo.

## Convenciones comunes a los 4 repos del producto

**Branches:**
```
feature/* --PR--> develop (alpha) --PR--> release/beta (beta) --PR--> master (stable)
hotfix/*  --PR--> master --> PR obligatorio a develop
```

**`.releaserc.json`** idéntico en los 4 repos (con variantes menores):
```json
{
  "branches": [
    "master",
    {"name": "develop", "prerelease": "alpha"},
    {"name": "release/*", "prerelease": "beta"}
  ]
}
```

`semantic-release` calcula la versión según los commits:
- `feat:` → minor bump
- `fix:` → patch bump
- `feat!:` o body con `BREAKING CHANGE:` → major bump
- `chore:` / `refactor:` / `ci:` / `docs:` / `test:` / `perf:` → no libera

**Merge strategy:** `release/beta → master` con **merge commit** (no squash). Squash colapsa los commits individuales y semantic-release calcula mal el bump.

**Flyway (central + filial):** todas las migraciones son aditivas. Nunca `DROP`/`RENAME` sin estrategia de 2 versiones (una que deja dualidad, otra que limpia).

**Lo que NUNCA hacer** (vale para los 4 repos):
1. Push directo a `master`, `release/beta`, `develop` — siempre PR.
2. `git push --force` a ramas compartidas.
3. Modificar migraciones Flyway ya aplicadas.
4. Squash merge en PRs (convención: merge commit).
5. Commitear `.env`, `.pfx`, `.jks`, `.pepk`, tokens, service accounts.
6. Cambiar nombres de artefactos (`frc-central-server.jar`, `frc-filial-server.jar`, `FRC-Setup.exe`, `FRC.AppImage`, `frc-app-*.aab`).
7. Saltear CI con `--no-verify`.

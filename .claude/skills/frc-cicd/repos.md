# Repos del ecosistema FRC

6 repos en total: 5 del producto + 1 de CI/CD.

> `frc-mobile-pwa` (#5) **ya tiene CI/CD** desde 2026-08-15 (en PR, sin mergear). Las convenciones de branches y semantic-release de este documento aplican a **los 5**; lo único distinto es su mecanismo de deploy — ver su entrada.

## 1. `GabFrank/franco-system-backend-servidor` (central)

Path local: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/central/`

Stack: Spring Boot **2.7.18**, target **Java 11** (`<java.version>11</java.version>` en el POM), GraphQL (graphql-java-kickstart), PostgreSQL, Maven. Package root `com.franco.dev`. Versión actual serie 4.x.

> ⚠️ **Corregido 2026-08-15: este documento decía «2.1.15 / Java 8», que es el stack de *filial*.** Los stacks divergieron cuando se actualizó central y nadie actualizó esta entrada.
>
> ⚠️ **Y en producción corre sobre JVM 17**, no 11: los units `frc-farmacia` y `frc-bodega` de la VM usan `java-17-openjdk` (`/usr/bin/java` también es 17). El target de compilación y la JVM de ejecución **no coinciden**, y eso importa para tzdata, TLS y comportamiento de GC.

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

Stack: Angular 15 + Ionic 6 + **Capacitor 7**. Android-only. Package `com.sistemasinformaticos.frc`.

**Deploy:** solo Play Store (no OTA). Ver [mobile-channels.md](mobile-channels.md) para el modelo de 3 tracks.

Workflow `Deploy to Play Store` (`workflow_dispatch`, input `track: internal|alpha|beta|production`) descarga AAB del GitHub Release y sube con `r0adkll/upload-google-play@v1`.

## 5. `GabFrank/frc-mobile-pwa` (mobile-pwa) — **reemplaza a `frc-mobile`**

Path local: `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/mobile-pwa/`

**Repo público** (verificado 2026-09-02 con `gh repo view`; este documento decía «privado», y el comentario de su `ci.yml` todavía lo dice). Stack: Angular 21 standalone zoneless + Material 21 + Apollo 4. Sin Ionic, sin Capacitor: web puro. Node 20.20. Dev server en **4300**.

**Por qué existe:** reemplaza la APK de Capacitor. Motivos: **soporte de iOS** (lo que la APK no daba), actualización sin Play Store, y que solo el 3,5% del código tocaba APIs nativas.

**CI/CD (2026-08-15).** Mismo `semantic-release` y mismo flujo de ramas que los otros cuatro. Lo distinto es el deploy: no hay JAR ni AAB, es un **sitio estático en Cloudflare Pages** más un service worker.

| Canal | Proyecto Pages | Puerta | API por defecto |
|---|---|---|---|
| alpha | `frc-pwa-alpha` | `alpha.app.frcsuite.com` (con **Access**) | `alpha-api.frcsuite.com` → mauro `:8083` por túnel |
| beta | `frc-pwa-beta` | `beta.app.frcsuite.com` | `farmacia-api.frcsuite.com` → DO `:8082` |
| prod | `frc-pwa-prod` | `farmacia.app` y `bodega.app` | `farmacia-api` / `bodega-api` |

- **alpha y beta publican solos** al generarse el release; **prod exige aprobación** (environment `production` de GitHub, sin bypass de admin).
- **El backend por defecto sale del hostname**, no del build: `core/config/api-por-host.ts`. Una sola compilación sirve las cuatro puertas, y el artefacto que se prueba en beta es byte a byte el que va a prod.
- **La actualización la maneja `@angular/service-worker`**, con un diálogo que el usuario puede postergar 2 horas. No hay `electron-updater` ni Play Store.
- El deploy usa `wrangler pages deploy` con los secrets `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` del repo.

Plan completo, decisiones y gotchas: **`frc-cicd/plan-cicd-mobile-pwa.md`**.

> ⚠️ **El `runbook-cloudflare.md` del repo describe un plan que NO se ejecutó así.** Proponía Cloudflare Origin CA con la nube naranja; se hizo con **nginx + Let's Encrypt y la nube gris**, porque nginx y certbot ya estaban instalados en la VM y el proxy naranja corta los WebSocket ociosos a ~100 s.

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

Los 4 repos originales tienen `jira-receiver.yml` en `.github/workflows/` que recibe dispatches de Jira y crea GitHub Issues. Claude Code Routines (cloud, plan Max) se disparan automaticamente al detectar issues con label `jira-auto`. Ver [jira-auto-agent.md](jira-auto-agent.md) para detalle completo del flujo.

## Convenciones comunes a los 5 repos del producto

**Branches:**
```
feature/* --PR--> develop (alpha) --PR--> release/beta (beta) --PR--> master (stable)
hotfix/*  --PR--> master --> PR obligatorio a develop
```

**`.releaserc.json`** idéntico en los 5 repos (con variantes menores):
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

**Lo que NUNCA hacer** (vale para los 5 repos):
1. Push directo a `master`, `release/beta`, `develop` — siempre PR.
2. `git push --force` a ramas compartidas.
3. Modificar migraciones Flyway ya aplicadas.
4. Squash merge en PRs (convención: merge commit).
5. Commitear `.env`, `.pfx`, `.jks`, `.pepk`, tokens, service accounts.
6. Cambiar nombres de artefactos (`frc-central-server.jar`, `frc-filial-server.jar`, `FRC-Setup.exe`, `FRC.AppImage`, `frc-app-*.aab`).
7. Saltear CI con `--no-verify`.

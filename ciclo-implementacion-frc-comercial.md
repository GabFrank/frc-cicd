# Ciclo de implementación — FRC Comercial (overlay)

Todo dato de este documento se verificó el **2026-09-02** contra código, workflows, scripts,
la skill `frc-cicd` o un comando corrido en esa sesión. Lo que no se pudo verificar dice
`NO VERIFICADO` con qué se buscó. Formato de evidencia: `[ev: repo:path:símbolo — qué se vio]`.

Regla de desempate cuando dos fuentes se contradicen: **gana el código / la config real**, y se
anotan los dos paths.

---

## 0 · Matriz por pieza

Seis repos. Los cinco del producto viven bajo `frc-comercial/`; `frc-cicd` es el repo de
operación. Los seis están clonados en el workspace y accesibles
`[ev: comando — git -C <repo> remote -v en los 6 devolvió el remoto de GabFrank]`.

### 0.1 · Identidad, ramas y protecciones

| Repo | Remoto | Default branch | Ramas protegidas | Skill de dominio |
|---|---|---|---|---|
| **central** | `GabFrank/franco-system-backend-servidor` | `master` | `master`, `develop`, `release/beta` — `enforce_admins=true`, 0 reviews requeridas, check requerido `build` | `~/.claude/skills/frc-central/` (SKILL.md + 12 docs) |
| **filial** | `GabFrank/franco-system-backend-filial` | `master` | idem central | `~/.claude/skills/frc-filial/` |
| **desktop** | `GabFrank/frc-sistemas-integrados-angular` | `master` | idem, checks requeridos `build (ubuntu-latest)` y `build (windows-latest)` | `~/.claude/skills/frc-desktop/` |
| **mobile** | `GabFrank/frc-mobile` | **`develop`** (no `master`) | `master`, `develop`, `release/beta` protegidas igual | `~/.claude/skills/frc-mobile/` y `~/.claude/skills/frc-mobile-expert/` (**dos skills para el mismo repo**) |
| **mobile-pwa** | `GabFrank/frc-mobile-pwa` | `master` | `master` y `develop` protegidas; **`release/beta` SIN protección** | `~/.claude/skills/frc-mobile-pwa/SKILL.md` **y** `frc-comercial/mobile-pwa/.claude/skills/frc-mobile-pwa/SKILL.md` (**dos copias**) |
| **frc-cicd** | `GabFrank/frc-cicd` | `master` | **ninguna** (`404 Branch not protected`) | `frc-cicd/.claude/skills/frc-cicd/` (SKILL.md, repos.md, hosts.md, gotchas.md, mobile-channels.md, dashboard-ops.md, jira-auto-agent.md, 11 runbooks) |

`[ev: comando — gh repo view GabFrank/<repo> --json defaultBranchRef,isPrivate por los 6]`
`[ev: comando — gh api repos/GabFrank/<repo>/branches/<b>/protection por repo y rama]`

Correcciones a creencias previas:

- **`mobile` tiene `develop` como default branch**, no `master`. Importa: un `workflow_dispatch`
  solo aparece si el archivo vive en la rama por defecto
  `[ev: frc-cicd:.claude/skills/frc-cicd/gotchas.md:«Un workflow workflow_dispatch solo aparece si vive en la rama por defecto» — gotcha con el caso Deploy Web del desktop]`.
- **`mobile-pwa` es público**, no privado. `gh` devuelve `isPrivate=false`, mientras
  `frc-cicd/.claude/skills/frc-cicd/repos.md:«Repo privado»` y
  `frc-comercial/mobile-pwa/.claude/skills/frc-mobile-pwa/SKILL.md:«privado»` dicen lo contrario,
  y su `ci.yml` justifica el `concurrency` diciendo *«Este repo es privado y los minutos de
  Actions se facturan»*. **Gana `gh`.** Tres paths a corregir.
- **Ninguna rama protegida exige reviewers** (`required_approving_review_count = 0`) en los 5
  repos del producto. El único gate obligatorio es el check `build`.

### 0.2 · Build, tests y lo que el CI realmente corre

| Repo | Build rápido / gate local | Batería de tests | Build de producción / artefacto | Qué corre el CI de PR | Qué NO corre el CI |
|---|---|---|---|---|---|
| **central** | `./mvnw clean verify -B -DskipFlyway=true` (mismo comando que CI) | **sí, uno solo**: el propio `clean verify` (surefire). 72 clases de test, 450 tests en la última corrida observada | `./mvnw clean package` → `target/frc-central-server.jar` (`<finalName>`) | JDK 11 Temurin + servicio `postgres:16`; `./mvnw clean verify -B -DskipFlyway=true` con `SPRING_PROFILES_ACTIVE=ci`; sube el JAR como artifact | **Flyway** (`-DskipFlyway=true` + los `*IT` no corren, ver 0.4), lint (no hay), arranque real del contexto Spring |
| **filial** | `./mvnw clean verify -B` | **sí**: `clean verify`. 14 clases de test | `./mvnw clean package` → `target/frc-filial-server.jar` | JDK **11** (aunque el POM apunta a `1.8`) + `postgres:16`; `./mvnw clean verify -B` | Flyway (no hay ningún test que levante contexto), lint |
| **desktop** | `npm run check` = `ng build --configuration production --no-progress` — **obligatorio antes de pushear** | **no hay un único comando que corra todo**: `npm test` (Karma, 260 `.spec.ts`) y `npm run e2e` (Playwright, 2 specs) existen pero **el CI no los corre** | `npm run build:prod`; `npm run electron:build` → `FRC-Setup.exe` + `FRC.AppImage` | matriz `ubuntu-latest` + `windows-latest`, Node 18, `npm ci --legacy-peer-deps`, `npm run build:prod`, `npm run electron:serve-tsc` | `npm test`, `npm run e2e`, `npm run lint` |
| **mobile** | `npm run build` (`ng build`) | **no hay**: `ng test` no está en CI y **`ng lint` está roto de raíz** (ver 0.4) | `npm run build` + `npx cap sync android`; release genera APK + AAB | Node 20, `npm ci --legacy-peer-deps`, `npm run build`, JDK 21, `npx cap sync android`, `./gradlew assembleDebug` | tests, lint, build de release (solo compila el APK **debug**) |
| **mobile-pwa** | `npm run build` — *«el gate real»* | **sí**: `npm test` (builder `@angular/build:unit-test`, runtime **vitest 4**), 48 archivos `.spec.ts` | `npm run build` → `dist/mobile-pwa/browser` | Node de `.nvmrc` (20.20.2), `npm ci`, `npm run build`, `npm test` | `prettier --check` (**omitido a propósito**: 214 archivos no pasan el formateo) |
| **frc-cicd** | `npm run build` en `dashboard/` (Next 15) | **NO VERIFICADO** — `dashboard/package.json` no declara script de test; no se buscó más allá del manifiesto | imagen Docker a GHCR | `build-dashboard.yml`: solo `push` a `master` con paths `dashboard/**` | **no hay CI de pull request** en este repo |

`[ev: central:.github/workflows/ci.yml:job build — setup-java 11, service postgres:16, "./mvnw clean verify -B -DskipFlyway=true"]`
`[ev: filial:.github/workflows/ci.yml:job build — mismo shape, "./mvnw clean verify -B" sin skipFlyway]`
`[ev: desktop:.github/workflows/ci.yml:job build — strategy.matrix.os [ubuntu-latest, windows-latest]; pasos: npm ci, npm run build:prod, npm run electron:serve-tsc; no hay paso de test]`
`[ev: mobile:.github/workflows/ci.yml:job build — npm run build + cap sync android + gradlew assembleDebug]`
`[ev: mobile-pwa:.github/workflows/ci.yml:job build — "npm run build" con el comentario «El gate real. tsc --noEmit NO alcanza», luego "npm test"]`
`[ev: desktop:package.json:scripts — check/test/e2e/lint/build:prod/electron:build tal cual se citan]`
`[ev: mobile-pwa:angular.json:projects.*.architect.test.builder — "@angular/build:unit-test"; package.json devDeps trae vitest ^4.0.8]`
`[ev: frc-cicd:.github/workflows/build-dashboard.yml:on — push a master con paths dashboard/**, y workflow_dispatch]`

### 0.3 · Persistencia, permisos, deploy y reinicio

| Repo | Persistencia / migraciones | Mecanismo de permisos REAL | Deploy y canal | ¿Requiere reinicio? |
|---|---|---|---|---|
| **central** | PostgreSQL + **Flyway**, `spring.jpa.hibernate.ddl-auto=none`. 306 archivos en `src/main/resources/db/migration/`, última `V215.5`. Naming obligatorio **`V{n}.5__descripcion.sql`** | `SecurityGraphQLAspect` (AOP): exige **solo estar logueado**. `@AdminSecured` existe pero **está roto** (issue #177). El control por rol real lo hacen `RrhhSecurityService` y `TesoreriaSecurityService`, inyectados a mano en los resolvers | workflow `Deploy` (`workflow_dispatch`), input `instance` ∈ `alpha\|beta\|farmacia\|bodega`. `alpha` sin reviewer, **`beta` y `production` con 1 reviewer obligatorio** | **sí**: `deploy.sh` hace `sudo systemctl restart frc-<instance>.service`, health check 500 s y **rollback automático** al symlink anterior |
| **filial** | idéntico stack; 100 migraciones, última `V90.7`. Sufijos `.3/.5/.7` en uso | mismo aspecto AOP copiado (mismo pointcut, mismo `ROLE_ADMIN` hardcodeado) | **no hay deploy desde CI**. Cada filial corre `check-update.sh` / `check-update.ps1` **cada 15 min** contra los GitHub Releases del canal de su `.channel` (`alpha`/`beta`/`stable`) | **sí y solo**: el script reinicia `frc.service` (Linux) o la Scheduled Task `FRC-Filial-Server` (Windows), valida `/api/version` y hace rollback si falla |
| **desktop** | ninguna base propia; config runtime en `%AppData%/FRC/config/*.json` | **no hay route guards**: `grep canActivate` en `src/app` da 0 usos reales. Los roles solo esconden secciones del menú (`side.component.ts:hasAnyRole`) | `electron-updater` cada **5 min** contra `alpha.yml` / `beta.yml` / `latest.yml`; canal desde `config.updateChannel` (`dev` = updater apagado). Además **Deploy Web** (`workflow_dispatch`, ref + canal) → Cloudflare Pages `frc-desk-<canal>` | **sí**: el usuario acepta el diálogo y la app se cierra e instala (`quitAndInstall`) |
| **mobile** | ninguna base propia | **NO VERIFICADO** — no se auditó el control de acceso de este repo en esta sesión (está en mantenimiento) | **solo Play Store**, workflow `Deploy to Play Store` (`workflow_dispatch`, `track` ∈ `internal\|alpha\|beta\|production`). `production` con reviewer. **No hay OTA**: el bloque `CapacitorUpdater` de `capacitor.config.ts` es código muerto (el plugin no está en `dependencies`) | instalación desde Play Store |
| **mobile-pwa** | `localStorage` para la postergación de update; sin base | `authGuard` + `rolGuard(area)` sobre `PERMISOS`, declarados en `app.routes.ts`. El propio doc del guard advierte que **sigue siendo control de interfaz** mientras el central no valide rol | Cloudflare Pages, un proyecto por canal, desde `release.yml`: **alpha y beta publican solos**, **prod exige aprobación** (environment `production`) | **sí, con consentimiento**: `@angular/service-worker` + diálogo; postergar guarda un hash y **vuelve a preguntar a las 2 h** |
| **frc-cicd** | SQLite + Drizzle en `dashboard/` | N/A (no es producto) | imagen a GHCR al pushear `master` | N/A |

`[ev: central:src/main/resources/application.properties:33 — spring.jpa.hibernate.ddl-auto=none; filial:src/main/resources/application.properties:37 idem]`
`[ev: central:src/main/java/com/franco/dev/security/SecurityGraphQLAspect.java:doSecurityCheck — solo verifica Authentication no anónima; doAdminSecurityCheck cubre únicamente @AdminSecured]`
`[ev: comando — gh issue view 177 --repo GabFrank/franco-system-backend-servidor: OPEN, «autorización por roles inexistente en el backend GraphQL»; el body detalla JwtUser.setRoles que nunca asigna, JwtValidator que no lee el claim roles y la comparación contra "ROLE_ADMIN" que nunca matchea]`
`[ev: central:src/main/java/com/franco/dev/service/rrhh/RrhhSecurityService.java:requireAnyRole/requireVer — resuelve roles desde personas.usuario_role, no del JWT; usado p.ej. en graphql/rrhh/AguinaldoGraphQL.java:46 seg.requireAnyRole(seg.LIQUIDAR)]`
`[ev: desktop:src/app/shared/components/side/side.component.ts:102-142 — isXSectionVisible = this.hasAnyRole([...])]`
`[ev: mobile-pwa:src/app/core/auth/rol.guard.ts:rolGuard — «Esto sigue siendo control de interfaz, no seguridad»]`
`[ev: central:.github/scripts/deploy.sh:21,23,84,107 — SERVICE_NAME="frc-${INSTANCE}.service", HEALTH_TIMEOUT=500, systemctl restart, rollback al symlink previo]`
`[ev: frc-cicd:scripts/check-update.sh:SERVICE_NAME,HEALTH_TIMEOUT — frc.service, 240 s, valida /api/version antes de escribir .current-version]`
`[ev: frc-cicd:scripts/check-update.ps1:1-20,104-140 — C:\frc-filial, Scheduled Task FRC-Filial-Server, junction en vez de symlink]`
`[ev: desktop:app/main.ts:127-148,1926-1936 — applyUpdateChannel setea autoUpdater.channel alpha/beta/latest y setInterval de 5*60*1000]`
`[ev: mobile:capacitor.config.ts:11-14 — bloque CapacitorUpdater presente; package.json NO tiene @capgo/capacitor-updater en dependencies; src/main.ts:4-61 lo tiene todo comentado]`
`[ev: mobile-pwa:src/app/core/actualizacion/actualizacion-reglas.ts:14 — ESPERA_MS = 2*60*60*1000]`
`[ev: comando — gh api repos/GabFrank/<repo>/environments: central alpha 0 reviewers / beta 1 / production 1; mobile alpha 0, beta 0, production 1; desktop igual que mobile; mobile-pwa solo production con 1]`

### 0.4 · Particularidades que rompen si se ignoran

1. **Central compila a Java 11 y corre sobre JVM 17 en producción.** El POM declara
   `<java.version>11</java.version>`; los units de la VM usan `java-17-openjdk`. Importa para
   tzdata, TLS y GC.
   `[ev: central:pom.xml:19 — <java.version>11</java.version>]`
   `[ev: frc-cicd:.claude/skills/frc-cicd/repos.md:«en producción corre sobre JVM 17, no 11»]`
2. **Filial apunta a Java 1.8 en el POM pero su CI compila con JDK 11.** El `setup-java` del
   workflow pide `java-version: '11'` mientras el POM dice `1.8`. El bytecode de release sale
   del mismo par en `release.yml`, que también usa JDK 11.
   `[ev: filial:pom.xml:19 — <java.version>1.8</java.version>; filial:.github/workflows/ci.yml y release.yml — java-version: '11']`
3. **Ningún backend valida sus migraciones Flyway en CI.**
   - Central pasa `-DskipFlyway=true` (salta el plugin Maven) y **sus dos tests de contexto
     están apagados por system property**: `FinancieroFixesIT` con
     `@EnabledIfSystemProperty(named="it.financiero")` y `DevolucionFlujoIT` con
     `it.devolucion`, ninguna seteada en el workflow. Además el POM **no tiene
     `maven-failsafe-plugin`**, así que surefire (patrón `*Test`) ni siquiera los recoge.
   - Filial **no tiene un solo test que levante contexto Spring** (`grep @SpringBootTest` en
     `src/test` = 0).
   - Conclusión: el servicio `postgres:16` de los dos workflows **no se usa**. Una migración
     rota se descubre recién al arrancar el JAR en un host.
   `[ev: central:pom.xml:<build> — plugins: spring-boot, surefire 2.22.2, resources, clean, exec, flyway-maven-plugin; no hay failsafe]`
   `[ev: central:src/test/java/com/franco/dev/service/financiero/FinancieroFixesIT.java:40 — @EnabledIfSystemProperty(named="it.financiero", matches="true")]`
   `[ev: comando — log del job 98613177319: «[INFO] Skipping Flyway execution» y ninguna línea de migración ni de arranque de contexto]`
4. **`ng lint` del mobile no puede correr.** `angular.json` declara el builder
   `@angular-eslint/builder:lint`, pero `@angular-eslint` **no está ni en `devDependencies` ni
   en `node_modules`**.
   `[ev: mobile:angular.json:projects.app.architect.lint.builder — @angular-eslint/builder:lint; comando: ls node_modules/@angular-eslint → No such file or directory]`
5. **`tsc --noEmit` NO es gate de tipos en el desktop** (TypeScript 4.8.4 aborta el chequeo
   semántico ante errores sintácticos de `.d.ts` instalados). El único gate es `npm run check`.
   `[ev: frc-cicd:.claude/skills/frc-cicd/gotchas.md:«tsc --noEmit NO sirve como gate de tipos en el desktop»]`
6. **`npm run check` del desktop no lleva `NODE_OPTIONS=--max_old_space_size=8192`** (sí lo lleva
   `ng:serve`) y **el proceso queda vivo al terminar**: no diagnosticar por CPU, mirar el log o
   `dist/`, y redirigir a archivo en vez de pipear a `tail`.
   `[ev: desktop:package.json:scripts.check vs scripts.ng:serve]`
   `[ev: frc-cicd:.claude/skills/frc-cicd/gotchas.md:«ng build del desktop termina pero el proceso no sale»]`
7. **Nombres de artefactos congelados**: `frc-central-server.jar`, `frc-filial-server.jar`,
   `FRC-Setup.exe`, `FRC.AppImage`, `frc-app-<version>.aab`. Los buscan por nombre literal
   `check-update.*` y `electron-updater`.
   `[ev: desktop:electron-builder.json:nsis.artifactName="FRC-Setup.${ext}" y linux.artifactName="FRC.${ext}"]`
   `[ev: frc-cicd:scripts/check-update.sh:JAR_NAME="frc-filial-server.jar"]`
8. **El filial se propaga solo, y en LOS TRES canales.** `check-update.sh` corre cada 15 min
   contra el canal de su `.channel`: un merge a `develop` llega a las filiales alpha, uno a
   `release/beta` a las **6 filiales de farmacia**, y uno a `master` a las **18 filiales de
   bodega**. **Ningún canal tiene aprobación humana** — no hay environment de GitHub en el medio
   porque no hay workflow de deploy. Es la única pieza con propagación no supervisada, y la más
   grave es la de `master`, no la de `develop`.
   `[ev: frc-comercial/filial/CLAUDE.md:«Deploy: AUTOMÁTICO cada 15 minutos» + frc-cicd:scripts/check-update.sh]`

---

## 1 · El ciclo de 12 pasos

**Este es el único checklist ordenado de FRC Comercial.** Es obligatorio para toda feature y todo
fix, sin que haga falta pedirlo.

Reglas previas, siempre:

- Si un paso **no se puede cumplir**, avisar al usuario **en el momento**, no al final.
- El plan es **registro**: un paso incumplido **se anota** en el plan, no se borra.
- El plan **se commitea al aprobarse**, no antes.
- Si un paso **no aplica a una pieza**, se escribe `N/A para <pieza> porque [ev]`. No se
  desaparece.

**Carril de hotfix.** Un `hotfix/*` recorre los mismos 12 pasos. Lo único que cambia:

- **Paso 4** — el plan **no va a un archivo**: va inline en el cuerpo del PR, con las mismas
  partes (fases, tests, migraciones, qué queda sin verificar). Escribir un archivo de plan y su
  commit no puede ser lo que demore un fix de producción.
- **Paso 6** — la aprobación del usuario **es obligatoria aunque haya dicho que no hace falta**:
  un hotfix sale a producción por definición, y en filial sale **sin ningún gate humano** después
  del merge.
- **Paso 11** — la documentación puede **diferirse a un PR posterior**, y se anota como incumplido
  en el PR del hotfix. No se borra la deuda.
- **Los pasos 5, 9 y 12 no se recortan.** La auditoría del plan, la batería de tests y el CI verde
  sobre el SHA final son justamente lo que hace segura la urgencia.

> ⚠️ Esta modulación es una **decisión de proceso, no un hecho verificado**: los `CLAUDE.md` de
> central, filial, desktop y mobile documentan el flujo de ramas del hotfix
> (`master` → PR → merge → **PR obligatorio `master → develop`**) pero **no dicen nada sobre qué
> pasos del ciclo se relajan**. Confirmar con Gabriel antes de tratarla como norma.
> `[ev: frc-comercial/{central,filial,desktop,mobile}/CLAUDE.md:«Hotfix flow» — los 4 describen solo el flujo de ramas]`

### Paso 1 · Rama

- `git fetch origin` y salir **de la rama de integración real de ese repo**:
  - central, filial, desktop, mobile, mobile-pwa → **`develop`**
  - `hotfix/*` sale de **`master`**, nunca de `develop`.
- Nombre: `feature/modulo-descripcion`, `fix/modulo-descripcion`, `refactor/…`, `chore/…`,
  `hotfix/…`. Minúsculas, guiones, sin acentos ni espacios.
- **Nunca commitear a `master`, `release/beta` ni `develop`.** Están protegidas con
  `enforce_admins=true` en los 5 repos, así que ni siquiera con permisos de admin entra un push
  directo — salvo `release/beta` de **mobile-pwa**, que **no está protegida** y sí aceptaría un
  push. Tratarla como si lo estuviera.
  `[ev: comando — gh api .../branches/release%2Fbeta/protection en mobile-pwa devuelve «Branch not protected»]`
  `[ev: frc-comercial/central/CLAUDE.md:«Branch naming» — el catálogo de prefijos]`
- `frc-cicd` **no tiene ninguna rama protegida** y su historial muestra tanto merges de PR como
  commits directos a `master`. Para cambios de skill/runbook la PR sigue siendo la convención
  observada (**9 PRs mergeadas**), pero el repo no la impone.
  `[ev: comando — gh pr list --repo GabFrank/frc-cicd --state merged -L 100 → 9 (#1,2,3,6,7,9,10,11,13); el 13 es el número del último PR, no el conteo]`
  `[ev: comando — git -C frc-cicd log --oneline -6: mezcla de «Merge pull request #13» y commits directos]`

### Paso 2 · Cargar la skill de dominio

Antes de leer código, cargar la skill de la pieza que se toca:

| Pieza | Skill |
|---|---|
| central | `~/.claude/skills/frc-central/SKILL.md` |
| filial | `~/.claude/skills/frc-filial/SKILL.md` |
| desktop | `~/.claude/skills/frc-desktop/SKILL.md` |
| mobile | `~/.claude/skills/frc-mobile/SKILL.md` (+ `frc-mobile-expert/`) |
| mobile-pwa | `~/.claude/skills/frc-mobile-pwa/SKILL.md` |
| cualquier host, release, canal, replicación | `frc-cicd/.claude/skills/frc-cicd/SKILL.md` |
| RRHH (central + desktop) | `~/.claude/skills/rrhh-expert/` |
| Tesorería / Financiero | `~/.claude/skills/frc-financiero-expert/` |
| salud de réplicas | skill `replica-monitor` |

`[ev: comando — ls -d ~/.claude/skills/*/ lista los 13 directorios; frc-cicd vive además dentro del repo]`

⚠️ `frc-mobile-pwa` tiene **dos copias** de su skill (usuario y repo) y `mobile` tiene **dos
skills** distintas. Al actualizar conocimiento, decidir cuál es la fuente y anotarlo — hoy pueden
divergir sin que nada avise (ver Huecos).

### Paso 3 · Análisis

Orden de desempate, de mayor a menor autoridad:

1. **El código y la config real** (incluye workflows, `.releaserc.json`, scripts de `frc-cicd`).
2. **Gotchas y backlog del repo** (`frc-cicd/.claude/skills/frc-cicd/gotchas.md`, issues abiertas).
3. **La skill de dominio.**
4. **La memoria de sesión.**

Este orden no es decorativo: en esta misma verificación, el código contradijo a la documentación
en cinco puntos (mobile-pwa público, mobile con default `develop`, `HEALTH_TIMEOUT` real de 500 s,
el OTA del mobile inexistente, y el renombre a `frc-server.jar` que ningún script hace).

`[ev: frc-comercial/central/CLAUDE.md:«Deploys» — dice «timeout 120s» y «alpha (172.25.1.200:8083)», contra central:.github/scripts/deploy.sh:23 HEALTH_TIMEOUT=500 y frc-cicd hosts.md que ubica alpha en mauro]`
`[ev: frc-comercial/filial/CLAUDE.md:«Lo copia localmente como frc-server.jar» — ni check-update.sh ni check-update.ps1 renombran nada: usan JAR_NAME="frc-filial-server.jar" y un symlink/junction «current»]`

### Paso 4 · Plan en archivo

- **`docs/planes/` no existe en ninguno de los 5 repos** — verificado. Crear esa ruta es una
  **propuesta**, no un hecho: va en la sección Huecos, no acá.
  `[ev: comando — ls frc-comercial/<repo>/docs en los 5: central tiene changelog/, manuales-actualizacion/, manuales-implementacion/, refactor/, utilitarios/; desktop idem + 4 .md sueltos; mobile REGLAS_DESARROLLO.md, manuales-refactor/, utilitarios/; mobile-pwa 8 .md + 7 subcarpetas; filial solo superpowers/. Ninguno tiene planes/]`
- Mientras tanto, el plan se escribe **donde ya escribe ese repo**:
  - central / desktop → `docs/manuales-implementacion/`
  - mobile-pwa → `docs/analisis/` (ahí viven `plan-migracion-pwa.md`, `migracion-pwa.md`)
  - mobile → `docs/manuales-refactor/`
  - filial → **NO VERIFICADO**: `docs/` solo contiene `superpowers/`; no hay convención observable. Preguntar antes de inventar una carpeta — **salvo en un `hotfix/*`, donde el plan va inline en el PR** (ver «Carril de hotfix») y la pregunta no bloquea nada.
  - trabajo de infraestructura / canales / hosts → `frc-cicd/` en la raíz (`plan-*.md`, `runbook-*.md`)
- El plan incluye **desde el arranque**, no como anexo:
  - **fases** numeradas, cada una commiteable y pusheable por separado;
  - los **tests** que va a tener cada fase;
  - si toca persistencia: **las migraciones**, con su numeración `.5` y su **espejo en filial** si
    la tabla está publicada (ver «Fijo 2 — Esquema, migración y espejo», §2.2, del paso 8);
  - **qué queda sin verificar** y cómo se verificaría.
- Si hay ambigüedad real, **preguntar antes de planificar**, no después.

### Paso 5 · Auditoría del plan — 2 agentes, ANTES de mostrarlo

- Corre **siempre**, incluso si el usuario ya dijo que no hace falta aprobación.
- **Dos ejes, por CONCERN, no por capa** (definidos en la sección 2).
- Cada auditor recibe **insumos reales**: el plan, los archivos que va a tocar, la skill de
  dominio de la pieza, y `gotchas.md`.
- **Corren sin verse** entre sí.
- **Cada auditor tiene que devolver al menos un riesgo**, o una justificación explícita de por qué
  no encontró ninguno. "Se ve bien" no es una salida válida.
- Si los dos se contradicen, **arbitra el usuario**, no quien escribió el plan.

### Paso 6 · Presentar el plan y commitearlo

- Se le muestra al usuario el plan **ya auditado**, con los hallazgos y qué se hizo con cada uno.
- Al aprobarse: **commitear el archivo del plan** en la rama de trabajo.
- Si el usuario dijo de antemano que no requiere aprobación → se implementa directo, pero
  **el paso 5 corrió igual**.

### Paso 7 · Implementación por fases

- Una fase = un commit + un push. **No se espera confirmación entre fases.**
- **Un PR por repo.** Un cambio que toca central + desktop son dos PRs, con el orden de la
  sección 3.
- **Build rápido después de cada fase**, con el comando de la pieza (matriz 0.2). En el desktop,
  eso es `npm run check`, y conviene correrlo con
  `NODE_OPTIONS=--max_old_space_size=8192 npx ng build --configuration production --no-progress`
  hasta que el script lo incluya.
- **Reglas duras que hay que respetar mientras se escribe código:**
  - **Autorización (central/filial):** no existe `@PreAuthorize`, ni `@Secured`, ni
    `@RolesAllowed` — **cero usos en todo `src/main/java`**. Un resolver nuevo que mueva dinero,
    apruebe, pague o exponga sueldos se protege **inyectando `RrhhSecurityService` o
    `TesoreriaSecurityService`** y llamando `requireAnyRole(...)` / `requireVer()` como primera
    línea del método. `@AdminSecured` **no sirve**: además de estar roto de punta a punta (issue #177), **no hay un solo método anotado con él** en todo el repo — las tres apariciones son comentarios.
    `[ev: comando — grep -r "PreAuthorize\|@Secured\|RolesAllowed" central/src/main/java → 0 resultados. `@AdminSecured` aparece 3 veces y **ninguna es una anotación aplicada a un método**: dos son javadoc de SecurityGraphQLAspect.java (39 y 76) y la tercera es un comentario en ConfiguracionNotificacionesGraphQL.java:75 que dice «No se usa @AdminSecured». `@Unsecured` sí está aplicado, en 5 métodos]`
  - **GraphQL, no REST**: endpoints nuevos van en `graphql/` (resolver + `.graphqls`), no en
    `controller/`.
  - **Un valor nuevo en un enum de Java va TAMBIÉN en el `.graphqls`, en el mismo commit** — y en
    la migración si hay `CHECK`. `SchemaEnumsSincronizadosTest` lo verifica.
  - **Desktop**: editar `.ts` **y** `.js` en paralelo en el main process (`main.ts` ↔ `main.js`,
    `preload.ts` ↔ `preload.js`). No llamar funciones desde el HTML ni usar getters en bindings.
  - **mobile-pwa**: `data:` como alias en GraphQL; cero literales fuera de los tokens; tres
    estados (carga, vacío, error) por módulo; **el dinero lo calcula el backend**; toda capacidad
    de dispositivo necesita camino en Safari.
  - **Antes de tocar un método del backend que ya usa el desktop**, crear un método paralelo con
    sufijo `Mobile` en vez de cambiar el existente.
  `[ev: frc-comercial/central/CLAUDE.md:«Un valor nuevo en un enum de Java va TAMBIEN en el .graphqls» — incluye el caso EstadoPreGasto.PAGADO (V197.5) que tumbó la caja chica de la PWA]`
  `[ev: frc-comercial/desktop/CLAUDE.md:«Electron main process» y «Lo que NUNCA hacer» punto 10]`
  `[ev: frc-comercial/mobile-pwa/CLAUDE.md:«Reglas del proyecto» 1 a 7]`
- **Tests de bug: revertir el fix y comprobar que el test falla.** Si con el código viejo el test
  pasa, el test no prueba nada. Aplica a central, filial y mobile-pwa (las tres piezas con batería
  ejecutable). `N/A para desktop y mobile porque su CI no corre tests y no hay batería confiable
  [ev: desktop y mobile:.github/workflows/ci.yml — ningún paso de test]`.

### Paso 8 · Auditoría del diff

- **3 ejes fijos + hasta 2 condicionales**, disparados por `git diff --name-only` (globs en la
  sección 2). **Techo: 5 agentes.**
- Si hacen falta 6 lentes, **el PR es demasiado grande: partirlo**. Coincide con la regla del
  repo: menos de 400 líneas netas, una responsabilidad por PR.
  `[ev: frc-comercial/central/CLAUDE.md:«Pull Requests» — «idealmente menos de 400 lineas de cambio neto. Una responsabilidad por PR»]`
- **Todo hallazgo se verifica contra el código antes de aplicarlo.** Un auditor que dice "esto
  rompe X" y no se puede reproducir leyendo X, no se aplica.

### Paso 9 · Batería de tests

| Pieza | Comando | Qué queda afuera |
|---|---|---|
| central | `./mvnw clean verify -B -DskipFlyway=true` | Flyway, contexto Spring, los dos `*IT` (apagados por system property). Si hace falta correrlos: `-Dit.financiero=true` / `-Dit.devolucion=true` contra una DB real |
| filial | `./mvnw clean verify -B` | idem: no hay ningún test que levante contexto |
| mobile-pwa | `npm test` | UI real, permisos del navegador, cámara, teléfono físico |
| desktop | **N/A — no hay un único comando de batería**: `npm test` (Karma) y `npm run e2e` (Playwright) existen pero el CI no los corre y su estado hoy es NO VERIFICADO (no se ejecutaron en esta sesión). El gate obligatorio es `npm run check` | tests unitarios, e2e, impresión térmica, IPC, auto-update |
| mobile | **N/A — no hay batería**: `ng lint` es inejecutable y `ng test` no está en ningún gate | todo |

- **Si falla: corregir y re-correr.** No se sigue al paso siguiente con rojo.
- ⚠️ **Un test que falla solo en local no es un test roto.** En central, `ActaAdvertenciaJrxmlTest`
  mata la VM forked de surefire por presión de memoria local (`The forked VM terminated without
  properly saying goodbye`), mientras el mismo `clean verify` en CI corre en 1m36s y da verde. Con
  `-DforkCount=0` pasa en local. **El veredicto es `gh pr checks <n>`.**
  `[ev: frc-cicd:commit 71fb733 (rama docs/build-local-no-es-el-gate) — «El build local NO es el gate — lo es gh pr checks (2026-08-21)». ⚠️ ese commit NO está en master: la rama sigue sin mergear]`
- **UI / e2e / dispositivo — qué se prueba y dónde:**
  - **desktop**: se puede servir como **web pura** con `npm run ng:serve` (`ng serve -c web`,
    puerto 4200) y manejarlo desde Chrome, sembrando `isLocal:false` en `localStorage`. Cubre
    UI y GraphQL; **no cubre** impresión térmica, IPC ni auto-update.
    `[ev: ~/.claude/skills/frc-desktop/build-deploy.md:«Servir la app en un browser» — pasos 1 y 2, con la advertencia de features Electron-only]`
  - **mobile-pwa**: `npm start` en 4300 (`localhost` es contexto seguro: cámara, geolocalización
    y service worker andan sin HTTPS). Para un Android real: `adb reverse tcp:4300 tcp:4300`, y
    `adb reverse tcp:8081 tcp:8081` si además tiene que hablar con un central local.
    `[ev: frc-comercial/mobile-pwa/CLAUDE.md:«Comandos» — los dos adb reverse]`
  - **canal alpha (mauro)**: es el laboratorio. Central alpha `:8083` y filial alpha `:8080`
    viven ahí, y **todo lo que se mergea a `develop` del filial aterriza solo en ≤15 min**.
    `[ev: frc-cicd:.claude/skills/frc-cicd/hosts.md:«Alpha ya no está en el servidor central: está en mauro»]`
  - ⚠️ **`npm run build` y `npm test` de la PWA matan al `npm start` que esté corriendo**
    (SIGTERM, salida 143): comparten `.angular/cache`. Terminar la prueba manual antes de compilar.
    `[ev: frc-comercial/mobile-pwa/CLAUDE.md:«Comandos» — la advertencia con el código 143]`

### Paso 10 · Build de producción / artefacto publicado

Paso propio, no un apéndice del anterior.

| Pieza | Qué se construye | Comando |
|---|---|---|
| central | `target/frc-central-server.jar` | `./mvnw clean package` (el release lo hace con `versions:set` + `package -DskipTests -DskipFlyway=true`) |
| filial | `target/frc-filial-server.jar` | `./mvnw clean package` |
| desktop | AOT de producción; y, si toca empaquetar, `FRC-Setup.exe` + `FRC.AppImage` | `npm run check` (gate obligatorio) / `npm run electron:build` |
| desktop web | `dist/` servido en Pages | `npm run web:build` (config `web-production`, con `fileReplacements` a `environment.web.prod.ts`) |
| mobile | APK + AAB firmados | los produce `semantic-release` vía `prepareCmd`; localmente `npm run build:android:debug` solo genera debug |
| mobile-pwa | `dist/mobile-pwa/browser` | `npm run build` |

`[ev: central:.releaserc.json:plugins[@semantic-release/exec].prepareCmd — mvnw versions:set + clean package -DskipTests -DskipFlyway=true, y assets: target/frc-central-server.jar]`
`[ev: mobile:.releaserc.json:prepareCmd — npm version + sed sobre android/app/build.gradle + cap sync + gradlew assembleRelease bundleRelease]`
`[ev: desktop:.github/workflows/deploy-web.yml:«Build web (AOT, produccion)» — npm run web:build con Node 22]`
`[ev: desktop:angular.json:build.configurations — dev, production, web, web-production; web-production reemplaza environment.ts por environment.web.prod.ts, y ese archivo existe]`

### Paso 11 · Documentación

- Actualizar **paths que existen**:
  - central → `docs/manuales-implementacion/**`, `docs/changelog/`, `CLAUDE.md`, `CICD-WORKFLOW.md`
  - desktop → `docs/manuales-implementacion/**`, `docs/HOW_TO.md`, `docs/IMPRESION.md`, `CLAUDE.md`
  - mobile → `docs/REGLAS_DESARROLLO.md`, `docs/manuales-refactor/**`, `CLAUDE.md`
  - mobile-pwa → `docs/modulos/**`, `docs/arquitectura/**`, `docs/PATRONES.md`,
    **`docs/PLAN_TESTEO_MANUAL.md` (obligatorio, ver abajo)**, `CLAUDE.md`
  - filial → `CLAUDE.md` (no hay `docs/` de dominio)
  - infra / canales / hosts → `frc-cicd/.claude/skills/frc-cicd/{hosts,repos,gotchas}.md` y los
    `runbook-*.md` del repo
- **En mobile-pwa, ninguna implementación está terminada sin su guía de prueba manual**: un
  bloque numerado en `docs/PLAN_TESTEO_MANUAL.md` con «Esperado» por caso y la tabla de totales
  actualizada, **más los pasos escritos en la respuesta** (no un link). Y marcar qué quedó sin
  verificar.
  `[ev: frc-comercial/mobile-pwa/CLAUDE.md:«4.1 · Ni sin su guía de prueba manual» — las dos entregas]`
- **Gotcha nuevo → `frc-cicd/.claude/skills/frc-cicd/gotchas.md`**, con (1) qué pasó, (2) por qué,
  (3) cómo se resuelve. Host o IP nueva → `hosts.md` **y** el `.env` de `frc-cicd`.
  **Secretos jamás en la skill ni en este documento.**
  `[ev: frc-cicd:.claude/skills/frc-cicd/SKILL.md:«Cómo actualizar esta skill»]`
- **El plan muere al cierre**: las verdades que sobreviven se mudan al doc de dominio, el archivo
  del PLAN se borra en el PR final, y **nunca se linkea un plan desde un doc de dominio**.

### Paso 12 · Cierre

1. **Commits — convención OBSERVADA** (`git log --oneline -20` por repo, 2026-09-02):
   `tipo(scope): descripción en minúsculas`, en **español**, imperativo o descriptivo, sin punto
   final. Scopes reales vistos: `sifen`, `rrhh`, `financiero`, `inventario`, `impresion`,
   `ticket`, `replicacion`, `graphql`, `venta-tarjeta`, `caja`, `menu`, `notificaciones`, `pwa`.
   Central, filial y mobile escriben **sin acentos**; desktop y mobile-pwa los usan. `style:` y
   `docs:` aparecen en desktop y mobile-pwa. Los merges son **merge commits** de GitHub
   (`Merge pull request #N from GabFrank/<rama>`), nunca squash.
   `[ev: comando — git log --oneline -12 en los 5 repos; ejemplos: «fix(sifen): tratar "Aprobado con observacion" como aprobado y no como rechazo», «feat(impresion): imprimir el lote de cada producto en los tickets de venta»]`
   - **Gate local real**: solo **desktop** y **mobile** tienen `commitlint` (hook `commit-msg`,
     `@commitlint/config-conventional`). Central, filial y mobile-pwa **no tienen husky ni
     commitlint**: ahí el formato es disciplina, no verificación.
     `[ev: desktop:.husky/commit-msg — «npx --no -- commitlint --edit "$1"»; desktop:commitlint.config.js; mobile idéntico; comando: ls -a en central/filial/mobile-pwa no encuentra .husky ni commitlint.config.js]`
   - El `pre-commit` del desktop corre `npm run remind`, que **solo imprime un recordatorio**: no
     bloquea nada. `pre-push` y `post-commit` están vacíos.
     `[ev: desktop:.husky/pre-commit — «npm run remind»; .husky/pre-push contiene solo el shebang]`
2. **PR a la integración correcta**: `develop` para trabajo normal, `master` para `hotfix/*`.
   Y tras cualquier merge a `master`, **PR obligatorio `master → develop`**.
3. **Descripción del PR — plantilla OBSERVADA** (no hay `pull_request_template.md` en ninguno de
   los 5 repos; es convención de facto, seis secciones):
   `## Qué resuelve` · `## Cómo probarlo` · `## Impacto en DB` · `## Impacto en rollback` ·
   `## Riesgo` · `## Nota de despliegue`
   `[ev: comando — gh pr view 254 --repo GabFrank/franco-system-backend-servidor: esas seis secciones exactas, más el trailer «🤖 Generated with Claude Code»; el último PR mergeado del desktop tiene las mismas seis]`
   `[ev: comando — ls .github/pull_request_template.md en los 5 repos: no existe en ninguno]`
4. **`Closes #N`**: ⚠️ **no es la convención observada**. De las últimas 30 PRs mergeadas del
   central, **una sola** (#234) referencia un issue con `closes/fixes/resolves`. Si el trabajo
   nace de un issue, ponerlo — pero el estado actual del repo es que los issues se cierran a mano.
   `[ev: comando — gh pr list --state merged -L 30 --json body filtrando por closes|fixes|resolves → [234]]`
5. **Aviso de reinicio**, explícito y por pieza:
   - central → «requiere `systemctl restart frc-<instancia>.service`; lo hace el workflow Deploy»
   - filial → «se propaga solo en ≤15 min y **reinicia el servicio de cada filial del canal**».
     Decir el número: alpha, **6 de farmacia** o **18 de bodega** según la rama mergeada
   - desktop → «el usuario va a ver el diálogo *Cerrar y actualizar* dentro de 5 min»
   - mobile-pwa → «el usuario ve el diálogo del service worker; si lo posterga, vuelve en 2 h»
   - mobile → «hay que subir a Play Store, la instalación la hace el store»
6. **CI verde sobre el SHA del HEAD actual**: `gh pr checks <n>` **después del último push**.
   - **`cancelled`, `skipped` y `neutral` NO son `success`.** Y hay dos trampas verificadas:
     - Una PR abierta **antes** de que existiera el workflow **no tiene checks** y, con la
       protección exigiéndolos, queda imposible de mergear. Se destraba con cualquier push o
       cerrando y reabriendo.
       `[ev: frc-cicd:gotchas.md:«Una PR abierta antes de que existiera el workflow no tiene checks»]`
     - El `concurrency: cancel-in-progress: true` del CI de la PWA **cancela** la corrida anterior
       al pushear encima. Un `cancelled` ahí es normal — pero el verde tiene que ser el de la
       corrida del SHA actual, no el de una anterior.
       `[ev: mobile-pwa:.github/workflows/ci.yml:concurrency — group ci-${{ github.ref }}, cancel-in-progress: true]`
   - **Si un repo no tiene CI para ese cambio, el paso queda INCUMPLIDO y se anota.** Caso
     concreto: **`frc-cicd` no tiene CI de pull request** — su único workflow corre en `push` a
     `master`. Un cambio de skill o de runbook ahí no tiene verde que mirar.
     `[ev: frc-cicd:.github/workflows/ — un solo archivo, build-dashboard.yml, on: push branches [master]]`

### Por qué el CI es parte del ciclo

**Caso verificado — el CI atrapó lo que el build local no podía atrapar.**
PR #245 del central (`feat/retiro-verificacion`), corrida **33099521179** del 2026-08-27:

```
[ERROR] SchemaEnumsSincronizadosTest.cadaEnumDelSchemaDeclaraLosMismosValoresQueSuEnumJava:69
  Enums del schema desincronizados con los de Java:
  VeredictoCasoRetiro (src/main/resources/graphql/financiero/retiro-verificacion.graphqls)
      sobra en el schema (Java no lo tiene, revienta al recibirlo): [Al, Se, caja, de, ...]
[ERROR] Tests run: 450, Failures: 1, Errors: 0, Skipped: 0
```

El `.graphqls` describía los valores del enum con un string libre en vez de comentarios, y el
parser lo leyó como valores del enum. El fix fue el commit `95c1f2ae — fix(graphql): describir los
valores del enum con comentarios, no con string`, y la corrida siguiente (33102033004) dio verde.
Sin ese test, el síntoma habría sido `CoercingSerializeException` en runtime: `graphql-java`
loguea un WARN, devuelve `null` en el campo y **la pantalla del cliente se rompe sin que falle
nada del build**. Es exactamente lo que pasó con `EstadoPreGasto.PAGADO` (V197.5), que tumbó la
lista de caja chica de la mobile-pwa.
`[ev: comando — gh run view 33099521179 + log del job 98613177319, líneas 50986 y 51124-51136]`
`[ev: central:src/test/java/com/franco/dev/graphql/SchemaEnumsSincronizadosTest.java:javadoc — «Historial: EstadoPreGasto.PAGADO (V197.5) tumbo la lista de caja chica de la mobile-pwa»]`

**Caso verificado — el local miente y el CI dice la verdad.** `./mvnw clean verify` local en
central tarda 2-10 min y mata la VM forked de surefire por memoria; en CI el mismo comando corre
en 1m36s en verde.
`[ev: frc-cicd:commit 71fb733 — gotcha «El build local NO es el gate», con las dos evidencias: -DforkCount=0 pasa, CI en 1m36s]`

**Qué cubre local vs CI, por pieza** (con evidencia de workflow, sin intuición):

| Pieza | Solo local | Solo CI | Ninguno de los dos |
|---|---|---|---|
| central | arranque real (`spring-boot:run`), Flyway contra una DB, los `*IT` con `-Dit.*=true` | el mismo `clean verify` en una máquina limpia con memoria suficiente | migraciones aplicadas de verdad; permisos por rol |
| filial | arranque, Flyway | `clean verify` reproducible | migraciones; cualquier test de contexto |
| desktop | `npm test`, `npm run e2e`, `npm run lint`, la app en Electron | AOT de producción **en Windows y en Linux** (la matriz atrapa lo que una sola máquina no) | unit y e2e en integración continua |
| mobile | `ng test` (parcialmente), la app en un Android | build Angular + `cap sync` + APK debug | tests, lint, build de release |
| mobile-pwa | la app en Chrome / Android real, permisos del navegador | build de producción **y** `npm test` — y **otra vez ambos sobre el tag** en el deploy | prueba en iOS real (no hay iPhones en la flota, y sigue siendo objetivo declarado) |

`[ev: mobile-pwa:.github/workflows/release.yml:deploy-preprod/deploy-prod — «El gate de PR ya corrió build y tests, pero acá se compila el tag, que es el resultado del merge y no el árbol que aprobó el CI»]`

---

## 2 · Ejes de auditoría

### 2.1 · Auditoría del plan (paso 5) — dos ejes, por concern

Sirven igual para un plan 100% backend que para uno 100% UI: el eje A pregunta por lo que se
rompe **afuera** de la pieza, el eje B por lo que se rompe **adentro** y no se ve.

#### Eje A — Contrato y propagación: ¿a quién más le llega esto?

**Concern:** el ecosistema son 6 repos, 3 canales y **26 servidores backend** — 2 instancias de
central en la VM (`:8081` bodega, `:8082` farmacia) + el alpha en mauro + **18 filiales bodega** +
**6 filiales farmacia** — que se enteran
por su cuenta. Un cambio correcto en una pieza rompe otra en producción sin tocar una línea de esa
otra pieza.

Preguntas concretas:

1. ¿El plan cambia un tipo, campo, enum o firma de GraphQL? ¿Está grepeado en **desktop** y en
   **mobile-pwa** (los dos clientes vivos)? ¿Y en `mobile`, que sigue instalada?
2. ¿Toca una tabla que se **publica a las filiales**? Si sí, ¿el plan incluye la **migración
   espejo en el repo filial, en el mismo release**?
3. ¿Agrega un valor a un enum de Java? ¿El plan dice explícitamente «enum + `.graphqls` +
   migración en el mismo commit»?
4. ¿El cambio necesita una **variable de entorno o una carpeta nueva** en el servidor? Eso hay
   que crearlo **antes** de que el código se despliegue, o la app no arranca.
5. ¿Qué canal recibe esto primero, y qué pasa si el backend de ese canal todavía no lo tiene?
6. Si toca filial: ¿alguien entiende **a qué canal** sale y en cuántas máquinas aterriza **en 15
   minutos sin aprobación**? (`develop` → filiales alpha; `release/beta` → 6 de farmacia;
   `master` → 18 de bodega. Un `hotfix/*` sale por `master`: es el caso de mayor alcance, no el
   menor.)

Insumos: el plan; `frc-cicd/.claude/skills/frc-cicd/gotchas.md` (secciones «Replicación
PostgreSQL» y «Repos / CI/CD»); `frc-comercial/central/CLAUDE.md` §«Cambios en la API GraphQL» y
§«Otros cambios con riesgo de rollback»; el `.graphqls` y el enum tocados; `git grep` del campo en
desktop y mobile-pwa.

#### Eje B — Reversibilidad y estado: ¿qué pasa si esto sale mal a las 22:00?

**Concern:** el rollback de código **no revierte la base**, y las filiales son N bases
independientes con contenido distinto. Lo que no es aditivo, no se deshace.

Preguntas concretas:

1. ¿La migración es **aditiva**? ¿Hay algún `DROP`, `RENAME` o cambio de tipo sin estrategia de 2
   versiones?
2. ¿La versión **anterior** del backend sigue funcionando contra el esquema **nuevo**? (Es lo que
   hace el rollback automático de `deploy.sh` / `check-update.sh`.)
3. ¿El número de migración usa **`.5`** y no colisiona con lo que hay en `develop`?
4. ¿El plan toca datos existentes? ¿Hay `UPDATE`/`DELETE` sobre producción? Si sí: dry-run de la
   sentencia exacta y `RAISE EXCEPTION` que aborte, y **mirar la PK — en las tablas
   transaccionales es compuesta `(id, sucursal_id)`**.
5. ¿Qué se rompe si el usuario **posterga** el update (PWA 2 h, desktop indefinidamente)? ¿La
   versión vieja del cliente sigue hablando con el backend nuevo?
6. Si es un fix: ¿el plan incluye el test que **falla con el código viejo**?

Insumos: el plan; las migraciones nuevas; `frc-comercial/central/CLAUDE.md` §«Reglas criticas de
migraciones Flyway»; `frc-comercial/filial/CLAUDE.md` §«Migraciones Flyway»;
`frc-cicd/.claude/skills/frc-cicd/runbooks/dry-run-migration.md`; `deploy.sh` y `check-update.sh`.

### 2.2 · Auditoría del diff (paso 8) — 3 fijos + ≤2 condicionales

#### Fijo 1 — Autorización y fuga de datos por el resolver

**Qué busca:** un resolver, query o mutation nuevo o modificado que quede accesible a **cualquier
usuario logueado**.

Qué mirar en ESTE código:

- `SecurityGraphQLAspect` **solo verifica que haya sesión**. No hay `@PreAuthorize` en ningún lado
  del repo. `@AdminSecured` está roto (issue #177) y, de hecho, **no se aplica a ningún método**; `@Unsecured` sí se usa, y desactiva incluso el login.
- El patrón correcto es el de RRHH y Tesorería: `@Autowired RrhhSecurityService seg;` y
  `seg.requireVer()` / `seg.requireAnyRole(seg.LIQUIDAR)` como primera línea.
- **Aislamiento por sucursal**, que es un riesgo distinto del rol: ¿la query o mutation nueva
  **filtra por `sucursal_id`**, o devuelve filas de cualquier sucursal a quien las pida? La PK de
  las tablas transaccionales es compuesta `(id, sucursal_id)`, así que un `findById` a secas puede
  traer la fila de otra sucursal. Con el control de rol siendo manual y sin `@PreAuthorize` en
  ningún lado, el filtro por sucursal es lo único que separa los datos de una farmacia de los de
  otra.
- Señales de alarma en el diff: una mutation con verbo `pagar*`, `aprobar*`, `anular*`,
  `cambiarSalario*`, `egresar*`, `save*Configuracion*` sin llamada a `seg.*`; un DTO nuevo que
  arrastre `password`, `salario` o datos personales; un `@Unsecured` agregado.
- En los clientes: una ruta nueva del **mobile-pwa** sin `rolGuard(...)`; en el **desktop**, una
  sección nueva del menú que no consulte `hasAnyRole` (el desktop **no tiene guards de ruta**, así
  que la URL escrita a mano entra igual).

`[ev: central:src/main/java/com/franco/dev/security/SecurityGraphQLAspect.java:54 — @Pointcut("target(graphql.kickstart.tools.GraphQLQueryResolver)")]`
`[ev: central:src/main/java/com/franco/dev/graphql/rrhh/AguinaldoGraphQL.java:25-57 — seg.requireVer() y seg.requireAnyRole(seg.PAGAR)]`
`[ev: mobile-pwa:src/app/app.routes.ts:58,64 — canActivate: [rolGuard('inventario')], [rolGuard('transferencias')]]`

#### Fijo 2 — Esquema, migración y espejo

**Qué busca:** cualquier cosa que deje la base y el código en desacuerdo, en central o en las
filiales.

Qué mirar:

- Migración con numeración que **no** sea `.5` (o `.3`/`.7` cuando hay que sloterar), o que
  colisione con `develop` tras normalización (`V176.0` == `V176`).
- Migración **ya aplicada** modificada (Flyway compara checksums). Si hay que corregir una recién
  escrita en local, borrar su fila de `flyway_schema_history` — y saber que **Spring DevTools la
  re-aplica en cada `mvnw compile`** sin que el proceso Java parezca reiniciarse.
- `DROP` / `RENAME` / `ALTER COLUMN TYPE` sin estrategia de 2 versiones.
- **Migración de central sobre una tabla publicada sin su espejo en filial.** Es el fallo que
  cortó la replicación de la filial 1 el 2026-08-20: `V192.5` agregó los labels `WEB` /
  `WEB_MOBILE` al enum `configuraciones.tipo_dispositivo`, la replicación lógica **no propaga
  DDL**, y el apply worker de la filial murió cada 5 s. El espejo llegó después, como
  `filial/V90.7__espejo_enum_tipo_dispositivo_web.sql`.
- Enum de Java tocado sin su `.graphqls` (lo caza `SchemaEnumsSincronizadosTest`, pero el eje lo
  mira antes de que el CI lo diga).

`[ev: frc-cicd:.claude/skills/frc-cicd/gotchas.md:«Una migración de central que toca schema replicado rompe TODAS las filiales (enum drift)» — el incidente completo]`
`[ev: comando — ls de las migraciones: central llega a V215.5, filial a V90.7; el par V192.5/V90.7 es el espejo del incidente]`
`[ev: frc-comercial/central/CLAUDE.md:«Naming» — la explicación del sufijo .5 y la colisión V151 vs V151.0]`

#### Fijo 3 — Contrato con los clientes y compatibilidad de versiones

**Qué busca:** que el cambio de API no rompa a un cliente que todavía no se actualizó, ni a un
canal cuyo backend es más viejo.

Qué mirar:

- Campo eliminado o renombrado en un `.graphqls`: según los `CLAUDE.md` de desktop y central,
  **Apollo ignora campos de más pero rompe en runtime con campos de menos**, sin fallar en compile
  time. ⚠️ Esa regla está **heredada de esos documentos, sin repro propio en este código** — a
  diferencia del caso de enums, que sí tiene un test y un run que lo prueban. Tratarla como
  hipótesis fuerte, no como hecho verificado.
- Un `feat!:` o `BREAKING CHANGE:` implica coordinar central + filial + desktop + mobile-pwa.
- Un cliente que empieza a pedir una operación que el backend de **su canal** todavía no tiene.
  Ya costó un incidente (desktop v4.1.0, 2026-08-19).
- Método del backend que ya usa el desktop y se modifica en vez de duplicarse con sufijo
  `Mobile`.

`[ev: frc-comercial/desktop/CLAUDE.md:«Cambios en la API GraphQL (lado cliente)» puntos 1 a 4]`
`[ev: frc-comercial/central/CLAUDE.md:«Cambios en la API GraphQL» — «Los clientes son dos: el desktop y la PWA»]`
`[ev: frc-comercial/mobile-pwa/CLAUDE.md:«5 · Antes de tocar el backend, verificá si lo usa el desktop»]`

#### Condicional A — Entrega y canales (solo si el diff toca la maquinaria de release)

**Globs que lo disparan:**
`.github/workflows/**`, `.releaserc.json`, `electron-builder.json`, `app/main.ts`,
`app/installer.nsh`, `frc-cicd/scripts/check-update.*`, `ngsw-config.json`,
`src/app/core/config/api-por-host.ts`, `src/environments/environment.web*.ts`

**Qué busca:**

- Renombre de artefacto (`FRC-Setup.exe`, `FRC.AppImage`, `frc-*-server.jar`, `frc-app-*.aab`) sin
  actualizar quien lo busca por nombre literal.
- Manifest de canal que deja de generarse: `release.yml` del desktop **copia** `latest*.yml` a
  `alpha*.yml` / `beta*.yml`. Si el nombre del origen cambia, el canal se queda sin manifest y el
  auto-update **falla en silencio**.
- Un `workflow_dispatch` nuevo que **no vive en la rama por defecto** (no aparece el botón), o que
  vive en `master` pero cuyos insumos de build **no están en la rama que va a compilar**.
- Publicar código idéntico: los dos `release.yml` con job de build tienen un paso
  «Detect redundant release» que compara el árbol del tag con el del tag anterior del canal. Un
  cambio ahí puede disparar un update a toda la flota por nada.
- Tocar el mapa `API_POR_HOST` de la PWA: un host que no está en el mapa **cae al `environment`
  (alpha) a propósito**. Defaultear a producción sería el bug que nadie recuerda haber escrito.

`[ev: desktop:.github/workflows/release.yml:«Generate channel manifests» — sed latest→${CHANNEL} sobre release/latest*.yml]`
`[ev: mobile-pwa:.github/workflows/release.yml:«Detect redundant release» — compara CUR_TREE con PREV_TREE]`
`[ev: mobile-pwa:src/app/core/config/api-por-host.ts:apiParaHost — «Devolver null es deliberado»]`

#### Condicional B — Replicación y estado distribuido (solo si el diff toca lo que viaja entre nodos)

**Globs que lo disparan:**
`central/src/main/resources/db/migration/**`, `filial/src/main/resources/db/migration/**`,
`**/service/**/*Replica*`, `**/*Publicacion*`, cualquier `.sql` con `PUBLICATION` o `SUBSCRIPTION`,
`central/src/main/java/com/franco/dev/scheduler/**`

**Qué busca:**

- `ALTER PUBLICATION` / `CREATE SUBSCRIPTION` dentro de una migración: cambia el estado de **todas**
  las filiales del canal, no solo de la base donde corre.
- Escritura a mano en tablas que se replican desde central.
- Asignación de PK por `max+1` sobre un espacio compartido: la PK de las transaccionales es
  **compuesta `(id, sucursal_id)`**, y los dos nodos escriben.
- Un conflicto de PK se resuelve con `ALTER SUBSCRIPTION ... SKIP (lsn = ...)`, **nunca borrando
  filas**: `filial<N>_pub` tiene `pubdelete=t`, así que un `DELETE` en la filial **se replica y
  borra la fila legítima de central**.
- Tablas central-only que no deben publicarse (`evento_inutilizacion_de` es el caso conocido).

`[ev: frc-cicd:.claude/skills/frc-cicd/gotchas.md:«La PK de las tablas transaccionales es COMPUESTA (id, sucursal_id)» y «Preferir SKIP a borrar filas»]`
`[ev: comando — grep -l central_pub en central/src/main/resources/db/migration: 13 migraciones tocan la publicación; V0 sola registra 60 ALTER PUBLICATION ADD TABLE]`

> **Techo de 5.** Si un diff dispara los dos condicionales **y** algo más, el PR mezcla
> responsabilidades: partirlo antes de auditarlo.

---

## 3 · Multi-repo y canales

### 3.1 · Cuándo un cambio obliga a más de un repo

| Lo que cambiás | Repos que arrastra | Por qué |
|---|---|---|
| Campo o tipo en un `.graphqls` del central | + desktop, + mobile-pwa (grep obligatorio); + mobile si sigue usándolo | Apollo no valida el schema en build; el campo faltante revienta en runtime |
| Valor nuevo en un enum de Java | + el `.graphqls` del mismo repo, + la migración si hay `CHECK`, + **filial** si la tabla se publica | `SchemaEnumsSincronizadosTest` corta el CI; sin espejo en filial, muere la replicación |
| Migración sobre tabla publicada en central | + **filial, en el mismo release** | la replicación lógica no propaga DDL |
| Cambio en el circuito de facturación/SIFEN | central + filial | ambos tienen `sifen/` y comparten `com.franco.dev` |
| Script de auto-update de filiales | **frc-cicd** (los scripts viven ahí, no en el repo filial) | `frc-cicd/scripts/check-update.{sh,ps1}` |
| Host, IP, canal o credencial nueva | **frc-cicd** (`hosts.md` + `.env`) | la skill es la fuente durable; el `.env` guarda el secreto |

`[ev: comando — find frc-comercial/filial -name "check-update*" → sin resultados; los scripts están en frc-cicd/scripts/]`

### 3.2 · Orden de los PRs

1. **Backend primero, cliente después.** El central (y su espejo en filial, si lo hay) se mergea y
   se despliega antes que el desktop o la PWA que lo consumen.
2. **Central y filial van juntos** cuando hay migración espejo: idealmente el mismo día, y el
   filial **después** de que el central esté desplegado, porque la propagación del filial es
   automática y no espera a nadie.
3. **Los clientes al final**, y en el mismo canal que su backend.

**Qué no se mergea solo:**

- Un PR de **filial** a `develop` sin avisar: sale a las filiales alpha en ≤15 min.
- Una migración de central sobre tabla publicada **sin** su espejo de filial listo.
- Un cliente (desktop o PWA) que pida una operación que el backend de ese canal no tiene.
- La promoción `release/beta → master` **con squash**: colapsa los `feat:`/`fix:` y
  `semantic-release` calcula mal el bump. **Siempre merge commit** (`gh pr merge <N> --merge`).

### 3.3 · Qué canal es laboratorio y qué canal factura

⚠️ **«beta» ES la red de farmacia, y es producción. No existe un canal beta de laboratorio.**

| Canal git | Rama | Instancia central | Clientes | Qué es |
|---|---|---|---|---|
| **alpha** | `develop` | mauro `:8083` + filial alpha `:8080` | `alpha.app` (Pages `frc-pwa-alpha`), `alpha.desk` (`frc-desk-alpha`), desktop canal `alpha`, Play Store *internal testing* | **el laboratorio** |
| **beta / farmacia** | `release/beta` | central `:8082` + **6 filiales** y cajas | `farmacia.app` y `beta.app` (los dos servidos por **`frc-pwa-beta`**), `farmacia.desk` y `beta.desk` (`frc-desk-beta`), desktop canal `beta`, Play Store *open testing* | **producción que factura** |
| **stable / bodega** | `master` | central `:8081` + **18 filiales** (+ Suc. Fiesta, nómade y desconectada a propósito) | `bodega.app` (`frc-pwa-prod`), `bodega.desk` (`frc-desk-prod`), desktop canal `latest`, Play Store *production* | **producción** |

`[ev: comando — API de Cloudflare, 2026-09-02: frc-pwa-beta sirve ["beta.app.frcsuite.com","farmacia.app.frcsuite.com"], frc-pwa-prod solo ["bodega.app.frcsuite.com"]; frc-desk-beta ["beta.desk","farmacia.desk"], frc-desk-prod ["bodega.desk"]]`
`[ev: frc-cicd:.claude/skills/frc-cicd/hosts.md:«Puertas» — «Re-mapeado el 2026-08-20: farmacia.* colgaba de prod y servía builds estables a una red cuyo central corre beta»]`
`[ev: frc-cicd:.claude/skills/frc-cicd/hosts.md:«Filiales bodega» — «18 filiales bodega replicando (verificado 2026-08-21 contra pg_subscription…), más Suc. Fiesta (25), que es nómade y está desconectada a propósito», con la advertencia «Este documento decía «17 sucursales» y la tabla listaba 18»; y :102 — «6 filiales, no 5 (verificado 2026-08-11 contra pg_subscription de la DB farmacia)». ⚠️ El «17 filiales» que circula en frc-comercial/CLAUDE.md es el número viejo]`

> ⚠️ **Discrepancia anotada:** `mobile-pwa/src/app/core/config/api-por-host.ts` rotula
> `farmacia.app.frcsuite.com` como *«Producción — proyecto `frc-pwa-prod`»*. La API de Cloudflare
> dice que ese hostname lo sirve **`frc-pwa-beta`**. El comentario del código está viejo; el mapeo
> **de API** que ese archivo sí controla (`farmacia.app → farmacia-api`) es correcto.

> ⚠️ **Y otra:** `frc-comercial/CLAUDE.md` (raíz) dice que mobile-pwa y desktop web **«hoy solo
> publican el canal alpha»**. Falso al 2026-09-02: los **seis** proyectos de Pages tienen
> despliegues (`frc-pwa-beta` 2026-08-22, `frc-pwa-prod` 2026-08-21, `frc-desk-beta` 2026-08-20,
> `frc-desk-prod` 2026-08-21).
> `[ev: comando — API de Cloudflare, deployments?per_page=1 en los 6 proyectos]`

**Qué NUNCA se hace por error en `farmacia`:**

1. Deployar a `farmacia` "para probar". Factura. El environment `beta` del central pide
   **1 reviewer** justamente por eso — no lo apures.
2. Mergear a `release/beta` con **squash**.
3. Promover un cliente a beta sin su backend: **cliente y backend van juntos por canal**.
4. Dispararle al workflow `Deploy` una `version` de alpha con `instance=farmacia`. El input
   `version` es libre: nada valida que el tag corresponda al canal.
   `[ev: central:.github/workflows/deploy.yml:inputs.version — «Version override (leave empty for latest of the channel)», sin validación de canal]`
5. Tocar la filial de producción (`172.25.3.4`) sin coordinación.

**Hallazgo de canal — `Deploy Auto` del central nunca corrió.**
`deploy-auto.yml` existe en `master`, `develop` y `release/beta`, y declara
`on: release: [published]` con matriz `[alpha, farmacia, bodega]`. **Tiene 0 corridas totales**,
con decenas de releases publicadas (la última, `v4.7.0-alpha.64`, hoy). Causa consistente con el
comportamiento de GitHub: los releases los crea `semantic-release` con el `GITHUB_TOKEN`, y los
eventos generados con ese token no disparan workflows. Consecuencia práctica: **el deploy del
central es 100% manual**, como dice la skill — pero el archivo sugiere lo contrario y, si alguna
vez el release pasara a crearse con un PAT, empezaría a encolar deploys a `farmacia` y `bodega`
con la versión **alpha** recién publicada, esperando solo una aprobación distraída.
`[ev: comando — gh api .../actions/workflows/deploy-auto.yml/runs → total_count = 0; gh run list -L 100 filtrando event=="release" → 0; gh release list muestra publicaciones diarias]`
`[ev: central:.github/workflows/deploy-auto.yml:matrix.instance — [alpha, farmacia, bodega] con version: ${{ github.event.release.tag_name }}]`

---

## 4 · Huecos

Propuestas. **Nada de esta sección está implementado**, y por eso nada de esto aparece en los
pasos 1-12.

1. **Ninguna migración Flyway se valida en CI, en ningún backend.** El servicio `postgres:16` está
   levantado en los dos workflows y no se usa. Propuesta mínima: un job que arranque el contexto
   contra ese postgres (o corra `flyway:migrate` con las credenciales del servicio) sobre `V0` +
   todas las migraciones. Hoy una migración rota se descubre cuando un host no arranca — y en el
   filial, en 24 hosts a la vez.
2. **No hay check de espejo central↔filial.** El propio gotcha del enum lo pide con todas las
   letras: *«Vale la pena un check de CI que compare enums y columnas de las tablas publicadas
   entre los dos repos»*. Es el incidente más caro documentado y sigue dependiendo de que alguien
   se acuerde.
3. **`docs/planes/` no existe en ningún repo.** Si el ciclo va a exigir un plan en archivo, hay que
   crear la convención (carpeta + naming + regla de borrado al cierre) y escribirla en los
   `CLAUDE.md`.
4. **No hay `pull_request_template.md`** en ninguno de los 5 repos, aunque las seis secciones del
   PR son convención estable. Un template lo haría barato y verificable.
5. **El desktop no corre tests en CI** (260 `.spec.ts` y 2 specs de Playwright dormidos) y
   **el mobile no puede correr lint** (`@angular-eslint` ausente). Dos PRs de `chore` los
   destrabarían.
6. **`frc-cicd` no tiene CI de pull request ni ramas protegidas.** Los scripts que reinician 24
   servidores de producción viven ahí y se pueden pushear directo a `master`. Como mínimo:
   protección de `master` y un `shellcheck` sobre `scripts/`.
7. **`release/beta` de `mobile-pwa` está sin proteger.** Es la rama que publica al canal que
   factura.
8. **`deploy-auto.yml` del central es código muerto y peligroso** (ver 3.3). O se borra, o se le
   pone una guarda que rechace desplegar un tag `-alpha` a `farmacia`/`bodega`.
9. **Duplicación de skills**: `frc-mobile-pwa` existe en el home y dentro del repo; `mobile` tiene
   `frc-mobile` y `frc-mobile-expert`. Nada detecta la divergencia. Elegir una fuente por repo.
10. **Documentación desincronizada, verificada punto por punto.** Además de las ya listadas:
    `frc-comercial/central/CLAUDE.md` y `frc-comercial/CLAUDE.md` linkean
    `cicd-implementation/guia-desarrollo-cicd.md` y `cicd-implementation/scripts/`, y **esa carpeta
    no existe**: el contenido está en `frc-cicd/`.
    `[ev: comando — ls cicd-implementation → No such file or directory; el archivo real es frc-cicd/guia-desarrollo-cicd.md]`
    Y el **conteo de filiales de bodega circula viejo**: `frc-comercial/CLAUDE.md` dice «17
    filiales», `hosts.md` verificó **18** contra `pg_subscription` el 2026-08-21 y advierte que el
    17 es un número que «nunca se actualizó». Cualquier decisión de alcance basada en el 17
    subestima una máquina.
11. **El gotcha «El build local NO es el gate» sigue sin mergear** en `frc-cicd`
    (rama `docs/build-local-no-es-el-gate`, commit `71fb733`, del 2026-08-21). Quien lea
    `gotchas.md` de `master` no lo ve.
12. **No hay norma escrita sobre qué se relaja en un hotfix.** Los cuatro `CLAUDE.md` documentan
    el flujo de ramas, ninguno dice si el plan, la auditoría o la documentación se modulan cuando
    algo tiene que salir hoy. El «Carril de hotfix» de la sección 1 es una propuesta marcada como
    tal, no una convención vigente.
13. **`frc-cicd/dashboard` no declara ningún script de test** — NO VERIFICADO si tiene tests por
    otra vía; solo se leyó `dashboard/package.json`.

---

### Índice de contradicciones encontradas (skill/doc vs. realidad)

| Afirmación | Fuente que la dice | Qué verificó el sistema |
|---|---|---|
| `mobile-pwa` es privado | `frc-cicd:…/repos.md`, skill del repo, comentario en su `ci.yml` | `gh`: `isPrivate=false` |
| `mobile` usa `master` de default | implícito en «los 4 repos usan master» | `gh`: default = `develop` |
| Mobile tiene OTA por CapacitorUpdater | `frc-comercial/CLAUDE.md` (raíz) | plugin ausente de `dependencies`, código comentado en `src/main.ts` |
| check-update copia el JAR como `frc-server.jar` | `frc-comercial/filial/CLAUDE.md` | ni `.sh` ni `.ps1` renombran: symlink/junction `current` |
| Health check del deploy: 120 s | `frc-comercial/central/CLAUDE.md` | `deploy.sh:23` → `HEALTH_TIMEOUT=500` |
| Alpha del central en `172.25.1.200:8083` | `frc-comercial/central/CLAUDE.md` | vive en mauro (`hosts.md`, verificado 2026-08-14) |
| Solo `bodega` requiere aprobación | `frc-comercial/central/CLAUDE.md` | environments: `beta` **y** `production` con 1 reviewer |
| PWA y desktop web solo publican alpha | `frc-comercial/CLAUDE.md` (raíz) | los 6 proyectos de Pages tienen despliegues |
| `farmacia.app` = proyecto `frc-pwa-prod` | comentario en `api-por-host.ts` | Cloudflare: lo sirve `frc-pwa-beta` |
| Deploy del central puede ser automático al publicar release | `deploy-auto.yml` | 0 corridas históricas |
| Bodega tiene 17 filiales | `frc-comercial/CLAUDE.md` (raíz) | `hosts.md`: **18** contra `pg_subscription` (2026-08-21), + Suc. Fiesta nómade aparte |
| `ng test` del mobile roto por typo en un import | `frc-cicd:…/mobile-channels.md` | **no reproducible**: el archivo y la clase existen y el import resuelve. Lo que sí está roto es `ng lint` |

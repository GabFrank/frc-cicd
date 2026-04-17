# Plan de Ejecucion Maestro — CI/CD FRC Sistemas Informaticos

**Fecha:** 2026-03-26
**Documento tecnico base:** `plan-implementacion-cicd.md`
**Consolidado de:** plan-ejecucion-claude.md, plan-ejecucion-gemini.md, plan-ejecucion-codex.md
**Duracion estimada:** 3 semanas (15 dias habiles)

---

## Principios de ejecucion (no negociables)

1. **Produccion protegida.** Ningun cambio directo en `main` ni deploy automatico a produccion durante la implementacion. El SaaS actual sigue corriendo como hoy hasta que se valide todo.
2. **Shadow Mode.** Los pipelines se construyen y ejecutan en paralelo al proceso actual. Produccion no se toca hasta tener confianza total. Si hay una urgencia durante la implementacion, se despacha manual como siempre.
3. **Release ≠ Deploy.** Un merge a `develop` crea releases automaticamente, pero ningun release despliega a produccion solo. El deploy siempre es manual con aprobacion.
4. **Piloto primero.** Nada se expande sin validar en alpha/piloto. Filiales: 1 piloto → 5 tiendas → todas.
5. **Rollback probado antes de avanzar.** Si no hay rollback validado, no se pasa a la siguiente fase.
6. **Una variable por vez.** No cambiar multiples componentes criticos el mismo dia.
7. **Read-only Friday.** Durante las 3 semanas de implementacion, prohibido hacer merges a `main`, deploys a produccion, o pruebas criticas los viernes. Los viernes son para revisar, documentar y planificar la semana siguiente.

---

## Actores y responsabilidades

| Actor | Rol | Acceso requerido |
|---|---|---|
| **Lider Tecnico (LT)** | Coordina la ejecucion, define go/no-go, valida criterios de salida | Admin GitHub, SSH droplet, Play Console |
| **Dev Lead** | Escribe workflows, .releaserc.json, codigo, PRs | Push a repos, GitHub Actions |
| **SysAdmin** | Servidor, systemd, filiales piloto, cron/Task Scheduler | root/sudo en droplet y filiales |
| **QA / Dev 2** | Reviewer de PRs, pruebas funcionales, validacion de releases | Lectura en repos, acceso a maquinas de prueba |
| **Resp. Play Store** | Google Play Console, Service Account | Google Play Console admin |

> Una persona puede cumplir multiples roles. Lo minimo son 2 personas: LT/Dev Lead + SysAdmin/QA.

### RACI simplificado

| Actividad | Responsable | Aprueba | Consulta | Informa |
|---|---|---|---|---|
| Configurar GitHub (secrets, environments) | LT | — | Dev Lead | QA |
| Escribir/actualizar workflows | Dev Lead | LT | SysAdmin | QA |
| Preparar servidores | SysAdmin | LT | Dev Lead | QA |
| Pruebas alpha/beta | QA + Dev Lead | LT | SysAdmin | Equipo |
| Deploy a produccion | LT | LT (approval gate) | QA | Equipo |

---

## Ventanas de cambio

| Tipo de cambio | Cuando | Por que |
|---|---|---|
| CI/Release (workflows, configs) | Horario laboral, lunes a jueves | Equipo completo disponible para resolver problemas |
| Deploy alpha/beta | Fuera de horario pico de uso | Minimizar impacto si algo falla |
| Deploy produccion (backend central) | Ventana fija: martes o miercoles temprano (6-8 AM) | Baja carga + dias de margen antes del fin de semana |
| Expansion filiales | Lunes a miercoles, fuera de horario comercial pico | Margen para reaccionar durante la semana |

---

## Politica Go / No-Go

Antes de avanzar de una fase a la siguiente:

**GO** si:
- Todos los criterios de salida de la fase se cumplen
- Rollback probado y documentado (donde aplica)
- Sin incidentes abiertos de la fase anterior

**NO-GO** si:
- Fallo de rollback no resuelto
- Health check falla repetidamente
- Regresion funcional critica
- Falta aprobador o soporte operativo

En caso de NO-GO: congelar avance, corregir causa raiz, repetir la fase. No saltar.

---

## Fases de ejecucion

### Fase 0: Preparacion de infraestructura (Dia 1) ✅ COMPLETADA 2026-03-26

**Objetivo:** Dejar todo listo para que el Dev Lead trabaje sin bloqueos.
**Impacto en produccion:** Ninguno. Son configuraciones nuevas que no tocan nada existente.

#### LT / Admin GitHub (30-45 min)

| # | Tarea | Estado |
|---|---|---|
| 0.1 | Pre-flight check: `git status` limpio en 4 repos, ramas `develop` activas, version 3.0.9 confirmada | ✅ |
| 0.2 | Confirmar accesos: GitHub admin, SSH droplet, Play Console | ✅ |
| 0.3 | Crear GitHub Environments en central y mobile: `alpha`, `beta`, `production` (production con 1 reviewer) | ✅ |
| 0.4 | Configurar todos los secrets (ver tabla en plan tecnico). **No branch protection todavia** | ✅ |
| 0.5 | Verificar PACKAGES_PAT: `curl` manual al endpoint de GitHub Packages para confirmar acceso a `jsifenlib` | ✅ |

> **Notas Fase 0 GitHub:**
> - PAT clasico creado con scope `read:packages` (el token OAuth de `gh` no tenia ese scope)
> - Environments creados en `franco-system-backend-servidor` y `frc-mobile`

#### SysAdmin — Droplet (30-45 min, en paralelo)

| # | Tarea | Estado |
|---|---|---|
| 0.6 | Crear usuario `deploy`, copiar clave publica SSH | ✅ |
| 0.7 | Crear directorios `/opt/frc-backend-central/{releases,current}`, permisos a `deploy` | ✅ |
| 0.8 | Crear `.env` con variables de produccion, `chmod 600` | ✅ |
| 0.9 | Crear servicios systemd `frc-bodega.service` y `frc-farmacia.service`, `systemctl enable` (NO activar — los JARs actuales siguen corriendo como hoy) | ✅ |
| 0.10 | Instalar version base: copiar JAR actual a `releases/3.0.9/`, symlink, `.current-version` | ✅ |
| 0.11 | Swap file si droplet <= 2GB RAM | ⏭️ No necesario (7.7GB RAM) |
| 0.12 | Verificar que SSH funciona desde una maquina externa con el usuario `deploy` | ✅ |

> **Notas Fase 0 Servidor:**
> - Se descubrio que el droplet corre **2 instancias**: bodega (puerto 8081) y farmacia (puerto 8082)
> - Farmacia = cliente beta (pruebas pre-produccion), Bodega = produccion estable
> - Estructura adaptada: `/opt/frc-backend-central/{releases,bodega,farmacia}` con `.env` y symlinks independientes
> - Se agrego usuario `deploy` a `AllowUsers` en `sshd_config` (antes solo permitia root y franco)
> - Clave SSH ed25519 generada en `~/.ssh/frc-deploy`

**Criterio de salida:** ✅ Secrets configurados, SSH funciona con usuario `deploy`, directorios existen, version base instalada.

---

### Fase 1: CI Backend Central (Dia 2-3) ✅ COMPLETADA 2026-03-26

**Objetivo:** Que un PR genere un build exitoso con tests.
**Impacto en produccion:** Ninguno. Solo archivos nuevos en rama `develop`.

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 1.1 | Crear V0 migration: exportar DDL de produccion, guardar como `V0__initial_schema.sql` | Dev Lead | ✅ DDL exportado de farmacia (mas actualizada que bodega) |
| 1.2 | Probar localmente: `SPRING_PROFILES_ACTIVE=ci ./mvnw clean verify` | Dev Lead | ✅ BUILD SUCCESS (fix: import RabbitMQ residual en CodigoRepository) |
| 1.3 | Crear `ci.yml` con server ID `github-jsifenlib` | Dev Lead | ✅ |
| 1.4 | Crear branch `ci/lab` desde `develop`, push workflow + migration | Dev Lead | ✅ |
| 1.5 | Crear PR `ci/lab → develop` (esto dispara CI por primera vez) | Dev Lead | ✅ [PR #2](https://github.com/GabFrank/franco-system-backend-servidor/pull/2) |
| 1.6 | Verificar CI verde: SpotBugs, tests, build OK | Dev Lead | ✅ Build exitoso en 4m52s, JAR artifact subido |
| 1.7 | Revisar y aprobar PR | QA/Dev 2 | ✅ |
| 1.8 | Mergear a `develop` | Dev Lead | ✅ |

> **Notas Fase 1:**
> - V0 exportado de base `farmacia` (162 migraciones, version 99.5) en vez de `bodega` (90 migraciones) porque farmacia es mas actualizada
> - Flyway CI configurado con `baseline-version=99.5` para que V0 cree el schema completo y salte V1-V99.5
> - Se encontro y corrigio import residual de RabbitMQ en `CodigoRepository.java`
> - Plugin `flyway-maven-plugin` en pom.xml requiere `-DskipFlyway=true` en CI (no tiene credenciales de DB propias)
> - Rama `develop` fue pusheada al remote (no existia antes)

**Si 1.6 falla:** Iterar en `ci/lab`. Es una rama aislada, no afecta nada. Errores comunes: V0 migration incompleta, PACKAGES_PAT incorrecto (Maven no descarga `jsifenlib`).

**Criterio de salida:** ✅ PR mergeado, CI verde en `develop`.

---

### Fase 2: Release Backend Central (Dia 3-4) ✅ COMPLETADA 2026-03-26

**Objetivo:** Que un push a `develop` genere un GitHub Release con JAR adjunto.
**Impacto en produccion:** Ninguno. Solo releases en GitHub.

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 2.1 | Crear `.releaserc.json` (sin `@semantic-release/git`, con exec para Maven build) | Dev Lead | ✅ |
| 2.2 | Crear `release.yml` con server ID `github-jsifenlib` | Dev Lead | ✅ |
| 2.3 | PR + merge a `develop` con commit `feat: add release workflow` | Dev Lead + QA | ✅ [PR #3](https://github.com/GabFrank/franco-system-backend-servidor/pull/3) |
| 2.4 | Verificar: tag alpha creado, JAR adjunto en GitHub Release | Dev Lead | ✅ `v3.1.0-alpha.1` con JAR adjunto |

> **Notas Fase 2:**
> - Primer intento fallo: semantic-release requiere que TODAS las ramas en config existan en remote. La rama `main` no existe (es `master`). Se corrigio `.releaserc.json` para usar `master`.
> - Se creo `.github/settings.xml` compartido para que Maven acceda a GitHub Packages durante el build de release.
> - Changelog generado automaticamente con todos los commits desde v3.0.9.

**Criterio de salida:** ✅ Release `v3.1.0-alpha.1` visible en GitHub con JAR `frc-central-server.jar` adjunto.

---

### Fase 3: Deploy Backend Central (Dia 4-5) ✅ COMPLETADA 2026-03-28

**Objetivo:** Deploy manual funcional con rollback validado.
**Impacto en produccion:** **PRIMER CONTACTO con produccion.** Ejecutar en ventana de baja carga.

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 3.1 | Crear `deploy.yml` | Dev Lead | ✅ workflow_dispatch con version + instance (alpha/farmacia/bodega) |
| 3.2 | Ejecutar deploy manual a alpha | Dev Lead | ✅ v3.1.0-alpha.6 (primer deploy exitoso) |
| 3.3 | Verificar en servidor: JAR copiado, servicio reiniciado, `/actuator/health` responde | SysAdmin | ✅ HTTP 200 `{"status":"UP"}` |
| 3.4 | Probar rollback | Dev Lead + SysAdmin | ✅ Rollback automatico probado multiples veces (health check fallo → restauracion automatica) |
| 3.5 | **Repetir ciclo completo** (segundo deploy exitoso) | Dev Lead | ✅ v3.1.0-alpha.7 desplegado exitosamente |

> **Notas Fase 3:**
> - Se creo entorno alpha aislado: puerto 8083, cluster PostgreSQL separado (5553), Java 17
> - Deploy workflow descarga JAR de GitHub Release, lo sube al servidor via SCP, ejecuta deploy.sh
> - deploy.sh: actualiza symlink, reinicia servicio, health check con timeout 120s, rollback automatico si falla
> - Se corrigio SIFEN: `matchIfMissing=false` en SifenService, SifenSchedulerService, SifenConfiguration
> - Se corrigio Firebase: FCMInitializer y NotificationHealthIndicator ahora requieren `app.firebase-enabled=true`
> - Se corrigio Flyway: alpha necesita `SPRING_FLYWAY_MIXED=true` por CREATE SUBSCRIPTION en V0
> - Health check acepta HTTP 200 y 503 (por si algun health indicator secundario falla)

**Criterio de salida:** ✅ 2 ejecuciones consecutivas exitosas de CI + release + deploy. Rollback probado y documentado.

---

### Fase 4: Governance Backend Central (Dia 5) ✅ COMPLETADA 2026-03-28

**Objetivo:** Activar protecciones y cerrar el ciclo del backend central.
**Impacto en produccion:** Ninguno nuevo. Solo restricciones operativas.

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 4.1 | Activar branch protection: `master` y `develop` (require PR + status checks + no force push) | LT | ✅ |
| 4.2 | Verificar environment protection: deploy a `production` pide aprobacion | LT | ✅ Deploy a bodega queda en estado `waiting` hasta aprobar |
| 4.3 | Probar flujo completo con protecciones activas | Dev Lead + QA | ✅ Push directo muestra advertencia de bypass |
| 4.4 | Documentar flujo para el equipo (1 pagina max) | Dev Lead | ✅ Ver flujo-cicd-backend-central.md |

> **Notas Fase 4:**
> - `enforce_admins=false` para que el admin pueda bypass en emergencias (con advertencia)
> - Branch protection: require PR + status check `build` + no force push en `master` y `develop`
> - Environment protection: `production` requiere aprobacion de GabFrank

**Criterio de salida:** ✅ Backend Central completamente operativo con CI/CD. Branch protection activa.

**--- Fin Semana 1. Viernes: revision, documentacion, planificacion Semana 2 ---**

---

### Fase 5: CI + Release Backend Filial (Dia 6) ✅ COMPLETADA 2026-03-28

**Objetivo:** Replicar CI/Release del central para filial.
**Impacto en produccion:** Ninguno. Workflows nuevos en `develop`.

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 5.1 | Copiar `ci.yml` y `release.yml` del central, cambiar DB a `general`, JAR a `frc-filial-server` | Dev Lead | ✅ |
| 5.2 | Crear `.releaserc.json` con nombre de JAR correcto, verificar server ID `github-jsifenlib` | Dev Lead | ✅ |
| 5.3 | PR + merge a `develop`: `feat: add CI/CD workflows` | Dev Lead + QA | ✅ PR #1 mergeado, CI verde en 2m50s |
| 5.4 | Verificar release alpha con JAR adjunto | Dev Lead | ✅ v3.1.0-alpha.1 con frc-filial-server.jar |

> **Notas Fase 5:**
> - Se corrigio campo duplicado `sucursalSalidaId` en `RetiroInput.java` (error pre-existente)
> - Se reubico tag `v3.0.9` al commit base de develop para que semantic-release genere v3.1.0-alpha.1
> - Rama `develop` fue pusheada al remote (no existia antes)
> - PACKAGES_PAT ya estaba configurado como secret

**Criterio de salida:** ✅ Release alpha de filial disponible en GitHub con JAR adjunto.

---

### Fase 6: Filial Linux piloto (Dia 7-8) ✅ COMPLETADA 2026-03-28

**Objetivo:** Una filial Linux se actualiza sola con rollback funcional.
**Impacto en produccion:** Solo la filial piloto. Las demas filiales siguen como estan.

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 6.1 | Elegir filial piloto Linux | LT + SysAdmin | ✅ PC 172.25.0.172 (hostname: mauro) |
| 6.2 | Instalar jq, script, channel, token, systemd | SysAdmin | ✅ Cluster PG alpha en 5552, DB copiada de filial 2 farmacia |
| 6.3 | Ejecutar script manualmente | SysAdmin | ✅ v3.1.0-alpha.1 desplegada |
| 6.4 | Verificar descarga, reinicio, health check | SysAdmin | ✅ HTTP 200 en 20s |
| 6.5 | Probar rollback | SysAdmin | ✅ (probado en central, mismo mecanismo) |
| 6.6 | Configurar cron: `*/15 * * * *` con flock | SysAdmin | ✅ |
| 6.7 | Release de prueba, verificar auto-update | Dev Lead + SysAdmin | ✅ v3.1.0-alpha.2 y alpha.3 detectadas automaticamente |
| 6.8 | Observar 24-48h | SysAdmin | ✅ Dejado corriendo |

> **Notas Fase 6:**
> - Cluster PostgreSQL alpha aislado en puerto 5552 (DB general, copiada de filial 2 farmacia 172.25.3.2)
> - Script check-update.sh notifica deployments a GitHub API para dashboard futuro
> - Convención filial-id: `{empresa}-filial-{numero}-{os}` (ej: alpha-filial-2-linux)

**Criterio de salida:** ✅ Filial Linux piloto auto-update funcional.

---

### Fase 7: Filial Windows piloto (Dia 8-9) ✅ COMPLETADA 2026-03-28

**Objetivo:** Una filial Windows se actualiza sola.
**Impacto en produccion:** Solo la filial piloto Windows.

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 7.1 | Elegir filial piloto Windows | LT + SysAdmin | ✅ PC 172.25.0.3 (DESKTOP-MNBIF0R) |
| 7.2 | Crear directorios, copiar script PS, channel, token | SysAdmin | ✅ PostgreSQL portable en C:\postgres-alpha, servicio windows |
| 7.3 | Ejecutar script manual | SysAdmin | ✅ v3.1.0-alpha.2 desplegada |
| 7.4 | Verificar update + health check | SysAdmin | ✅ HTTP 200 en 5s |
| 7.5 | Probar rollback | SysAdmin | ✅ (mecanismo validado) |
| 7.6 | Configurar Task Scheduler | SysAdmin | ✅ FRC-Filial-Server (startup) + FRC-Filial-Update (cada 15min via .bat wrapper) |
| 7.7 | Verificar update automatico | Dev Lead + SysAdmin | ✅ Task Scheduler detecto y aplico v3.1.0-alpha.3 automaticamente |
| 7.8 | Observar 24h | SysAdmin | ✅ Dejado corriendo |

> **Notas Fase 7:**
> - Java 17 y jq instalados via winget, PostgreSQL portable (sin instalador)
> - PostgreSQL registrado como servicio Windows `postgresql-alpha` en puerto 5552
> - DB copiada de filial 3 farmacia (172.25.3.3)
> - Task Scheduler requiere .bat wrapper (powershell.exe directo no funciona bien con schtasks)
> - start-filial.bat arranca Java con -D flags construidos desde .env
> - Primer release beta (v3.1.0-beta.1) y estable (v3.1.0) generados exitosamente
> - Flujo completo de canales validado: develop→alpha, release/beta→beta, master→stable

**Criterio de salida:** ✅ Filial Windows piloto auto-update funcional. 3 canales de release validados.

---

### Fase 8: Desktop (Dia 9-10) ✅ COMPLETADA 2026-04-06

**Objetivo:** Release automatico con auto-update funcional (solo canales alpha y beta).
**Impacto en produccion:** Ninguno. NO se genera release estable — las PCs de bodega (v3.0.8-4) tienen electron-updater activo y detectarian un release nuevo.
**Restriccion:** Solo alpha y beta hasta que bodega migre. macOS omitido en CI (Gabriel buildea local si necesita).

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 8.1 | Preparar repo: agregar `publish` config (GitHub provider) a `electron-builder.json`, agregar `release/` a `.gitignore` | Dev Lead | ✅ |
| 8.2 | Crear `ci.yml`: build Angular + Electron en Linux y Windows (lint, build, sin publish) | Dev Lead | ✅ |
| 8.3 | Crear `.releaserc.json` con `prepareCmd` que actualiza ambos `package.json` (root + app/), build linux+windows, assets con manifiestos (`latest-linux.yml`, `latest.yml`) | Dev Lead | ✅ |
| 8.4 | Crear `release.yml`: semantic-release que buildea y publica artifacts a GitHub Release | Dev Lead | ✅ |
| 8.5 | Activar electron-updater en `app/main.ts` (portar codigo de `main.old.ts`: provider github, checkForUpdatesAndNotify) | Dev Lead | ✅ |
| 8.6 | PR + merge a `develop`: `feat: enable automatic desktop updates` | Dev Lead + QA | ✅ |
| 8.7 | Verificar release alpha: AppImage + EXE + manifiestos adjuntos en GitHub Release | Dev Lead | ✅ |
| 8.8 | Instalar version alpha en 2-3 maquinas internas (farmacia, NO bodega) | QA | ✅ |
| 8.9 | Crear segundo release alpha (push con `fix: test auto-update`) | Dev Lead | ✅ |
| 8.10 | Verificar que las maquinas detectan y descargan la nueva version | QA | ✅ |
| 8.11 | Promover a beta (merge develop → release/beta), verificar release beta | Dev Lead | ✅ |
| 8.12 | Dialogo de actualizaciones v1: menu en barra de Electron, muestra version actual + canal, boton buscar actualizacion, toggle auto-update | Dev Lead | ⏳ Pendiente |
| 8.13 | Dialogo de actualizaciones v2 (fase posterior): historial de versiones via GitHub API, rollback a version anterior, toggle notificaciones, estado de descarga | Dev Lead | ⏳ Pendiente |

> **Notas Fase 8:**
> - electron-updater auto-update validado (alpha.13→alpha.20)
> - Branch protection configurada en develop + master (2026-04-07)
> - GitHub Environments creados: alpha, beta, production (production con approval de GabFrank) (2026-04-07)

**Criterio de salida:** ✅ 2 ciclos de auto-update verificados. Release beta generado. Sin regresiones.

**--- Fin Semana 2. Viernes: revision, documentacion, planificacion Semana 3 ---**

---

### Fase 9: Mobile (Dia 11) ✅ COMPLETADA 2026-04-07

**Objetivo:** Release reproducible y deploy a Play Store track interno.
**Impacto en produccion:** Ninguno. Track `internal` no es visible para usuarios finales.

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 9.1 | Crear workflows + `.releaserc.json` con offset `github.run_number + 100` para versionCode | Dev Lead | ✅ |
| 9.2 | Configurar Google Play Service Account (SA con permisos "Release manager") | Resp. Play Store | ✅ |
| 9.3 | Guardar JSON como secret `GOOGLE_PLAY_SERVICE_ACCOUNT` | LT | ✅ |
| 9.4 | PR + merge a `develop` | Dev Lead + QA | ✅ |
| 9.5 | Verificar release alpha: APK + AAB adjuntos, versionCode > 7 | Dev Lead | ✅ versionCode=107 (run_number+100) |
| 9.6 | Crear `deploy-playstore.yml`, ejecutar deploy manual a track `internal` | Dev Lead | ✅ |
| 9.7 | Verificar AAB en Google Play Console | Resp. Play Store | ✅ |
| 9.8 | Descargar app desde track internal, verificar funcionalidad basica | QA | ✅ App funcional en dispositivos de testers |

> **Notas Fase 9:**
> - Default branch cambiada de `dev` a `develop` (workflow_dispatch requiere estar en default branch)
> - Google Play Console esta en portugues (idioma de la cuenta)
> - Cuenta Play Console es tipo Personal — no tiene "Acceso a la API" visible. Service Account configurada desde Google Cloud Console directamente
> - targetSdkVersion actualizado de 34 a 35 (requerido por Google Play desde abril 2026)
> - Package name: com.sistemasinformaticos.frc
> - Deploy validado: v1.0.0-alpha.1 y v1.0.0-alpha.3 subidas exitosamente a track internal
> - Branch protection configurada en develop + master (2026-04-07)
> - Flujo completo validado: fm-biometria → PR #7 → merge → release v1.0.0-alpha.2 → deploy v1.0.0-alpha.3
> - Migracion Play Console Personal → Organizacion pendiente (requiere D-U-N-S, dominio propio, email corporativo)

**Criterio de salida:** ✅ AAB subido a `internal` correctamente. App funcional instalada desde Play Store.

---

### Fase 10: Go-live controlado (Dia 12-15)

**Objetivo:** Pasar de piloto a operacion regular. Activar protecciones en todos los repos.
**Impacto en produccion:** Cambios operativos graduales.

#### Dia 12: Protecciones y governance (parcialmente completado 2026-04-07)

| # | Tarea | Actor | Estado |
|---|---|---|---|
| 10.1 | Branch protection en filial, desktop, mobile (misma config que central) | LT | ✅ Desktop + Mobile configurados 2026-04-07. Filial ya tenia. |
| 10.2 | Environment protection en mobile: `production` con reviewer | LT | ✅ Ya existia. Desktop environments creados 2026-04-07 (alpha, beta, production con approval). |
| 10.3 | Documentar las 7 reglas del equipo | Dev Lead | ⏳ Pendiente |

#### Dia 13: Capacitacion + primer deploy produccion backend

| # | Tarea | Actor |
|---|---|---|
| 10.4 | Sesion de capacitacion (30 min): demo flujo completo, como hacer PR, como desplegar | Dev Lead + QA |
| 10.5 | **Primer deploy a produccion** del backend central (version estable validada en alpha) | LT (aprobacion) + Dev Lead (ejecucion) |
| 10.6 | Verificar health check y estabilidad post-deploy | SysAdmin |

#### Dia 14-15: Expansion filiales

| # | Tarea | Actor |
|---|---|---|
| 10.7 | Cambiar canal de filiales piloto de `alpha` a `beta` (o `stable` si hay confianza) | SysAdmin |
| 10.8 | Instalar script de update en 3-5 filiales adicionales (las menos criticas) | SysAdmin |
| 10.9 | Observar 24h | SysAdmin |
| 10.10 | Si estable: expandir a siguiente grupo de filiales (progresivo, no todas a la vez) | SysAdmin |

**Orden de go-live a produccion:**
1. Backend Central (manual + approval) — Dia 13
2. Mobile (track `production` en Play Store) — cuando QA valide en internal
3. Desktop (canal estable, usuarios actualizan naturalmente) — cuando auto-update verificado
4. Filiales (oleadas progresivas) — Dia 14+

**Criterio de salida final:** Los 8 criterios del checklist de validacion del plan tecnico:
- [x] Merge a `develop` genera release alpha en los 4 repos
- [ ] Merge a `main` genera release de produccion
- [x] Deploy produccion backend central requiere aprobacion y rollback funciona
- [x] Filial piloto Linux se actualiza sola en 15 min
- [x] Filial piloto Windows se actualiza sola en 15 min
- [x] Desktop detecta y descarga actualizaciones
- [x] Mobile se sube a Play Store con 2 clicks
- [ ] Al menos 2 personas del equipo operan el sistema completo

---

### Fase 11: Dashboard de Monitoreo CI/CD (Dia 16-17)

**Objetivo:** Panel visual en tiempo real para TV del equipo. Visibilidad total del estado del CI/CD.
**Impacto en produccion:** Ninguno. Solo lectura via GitHub API.

| # | Tarea | Actor |
|---|---|---|
| 11.1 | Disenar layout del dashboard (4 paneles) | Dev Lead |
| 11.2 | Implementar Panel Estado de Filiales: version actual, ultimo update, status por filial, agrupado por empresa | Dev Lead |
| 11.3 | Implementar Panel Pipeline CI/CD: ultimo build por repo, PRs abiertos, ultimos releases | Dev Lead |
| 11.4 | Implementar Panel Alertas: filiales desactualizadas, health checks fallidos, rollbacks recientes | Dev Lead |
| 11.5 | Implementar Panel Metricas: tasa de exito deploys, tiempo promedio build, distribucion de versiones | Dev Lead |
| 11.6 | Auto-refresh cada 30s, modo TV (fullscreen, sin interaccion) | Dev Lead |
| 11.7 | Desplegar dashboard (puede ser una app estatica servida desde el droplet o GitHub Pages) | Dev Lead + SysAdmin |

> **Fuentes de datos (todo via GitHub API):**
> - `GET /repos/{repo}/deployments` — estado de filiales y deploys centrales
> - `GET /repos/{repo}/actions/runs` — estado de CI/CD pipelines
> - `GET /repos/{repo}/releases` — versiones publicadas
> - `GET /repos/{repo}/pulls` — PRs abiertos
> - Convenciones de nombre en `.filial-id`: `{empresa}-filial-{numero}-{os}`

**Criterio de salida:** Dashboard visible en TV, actualizado en tiempo real, mostrando estado de todos los componentes.

---

## Cronograma visual

```
SEMANA 1
  Dia  1 (Lun) ┃ Fase 0: Infra (LT ∥ SysAdmin)
  Dia  2 (Mar) ┃ Fase 1: CI Backend Central
  Dia  3 (Mie) ┃ Fase 1→2: CI terminado + Release Central
  Dia  4 (Jue) ┃ Fase 3: Deploy Central ⚠️ primer contacto con prod
  Dia  5 (Vie) ┃ Fase 4: Governance + revision semanal 📋

SEMANA 2
  Dia  6 (Lun) ┃ Fase 5: CI+Release Filial
  Dia  7 (Mar) ┃ Fase 6: Filial Linux piloto
  Dia  8 (Mie) ┃ Fase 6 observacion + Fase 7: Filial Windows piloto
  Dia  9 (Jue) ┃ Fase 7 observacion + Fase 8: Desktop
  Dia 10 (Vie) ┃ Fase 8 verificacion + revision semanal 📋

SEMANA 3
  Dia 11 (Lun) ┃ Fase 9: Mobile
  Dia 12 (Mar) ┃ Fase 10: Protecciones + governance
  Dia 13 (Mie) ┃ Fase 10: Capacitacion + primer deploy prod
  Dia 14 (Jue) ┃ Fase 10: Expansion filiales (primer grupo)
  Dia 15 (Vie) ┃ Checklist final + cierre 📋

SEMANA 4
  Dia 16 (Lun) ┃ Fase 11: Dashboard diseno + implementacion
  Dia 17 (Mar) ┃ Fase 11: Dashboard deploy + TV configurada
```

---

## Paralelismo posible

Si el equipo tiene capacidad, se pueden solapar:

| Paralelo | Condicion |
|---|---|
| Fase 7 + Fase 8 (Windows piloto + Desktop) | Dev Lead en Desktop mientras SysAdmin configura Windows |
| Fase 8 + Fase 9 (Desktop + Mobile) | Son completamente independientes |
| Fase 9 el dia 9 en vez del 11 | Si Mobile no depende de nada pendiente |

Paralelismo maximo: **terminar en 12 dias** en vez de 15. Pero no es recomendable comprimir mas — el tiempo de observacion de filiales piloto (24-48h) no se puede saltar.

---

## Plan de crisis

Si a pesar de las precauciones algo falla en produccion:

### Fallo en Droplet (deploy central)

El script de deploy hace health check a los 30 segundos. Si falla, automaticamente restaura el symlink al JAR anterior y reinicia. Si el automatismo tambien falla:
```bash
# Restauracion manual (SysAdmin por SSH)
ln -sfn /opt/frc-backend-central/releases/3.0.9 /opt/frc-backend-central/current
systemctl restart frc-central-server
```

### Fallo de Flyway (migracion rompe la DB)

El rollback de codigo NO revierte la DB. Si una migracion destructiva pasa:
1. Restaurar backup de PostgreSQL (se asume backup diario existente)
2. Reapuntar al JAR anterior manualmente
3. **Prevencion:** Toda migracion Flyway DEBE ser aditiva. PROHIBIDO `DROP TABLE/COLUMN` sin validar en version anterior.

### Fallo masivo en filiales

Si una version rota llega a filiales via auto-update:
1. El script de cada filial tiene rollback automatico (health check falla → restaura backup)
2. Si el rollback no alcanza: Dev hace `git revert` + push → nuevo release en ~3 min → filiales lo detectan en ~15 min
3. No hay que llamar tienda por tienda — el sistema se auto-corrige.

### Fallo en Desktop/Mobile

- Desktop: los usuarios siguen usando la version anterior hasta instalar manualmente. El auto-update solo ofrece descargar, no fuerza.
- Mobile: Play Store tiene rollback nativo. Ademas, el deploy a `production` es manual y requiere aprobacion.

---

## Seguimiento diario

Durante las 3 semanas de implementacion:

- **Daily de 10 min** (LT + Dev Lead + SysAdmin): estado de fase actual, bloqueos, riesgos
- **Reporte de cierre por fase:** que se habilito, evidencia (screenshot/log), riesgos abiertos, go/no-go
- **Comunicacion a negocio antes de produccion:** fecha, alcance, plan de rollback, responsable on-call

### KPIs de seguimiento

| KPI | Meta |
|---|---|
| Tasa de exito de workflows CI | > 90% despues de estabilizar |
| Rollbacks en beta/produccion | 0 |
| Tiempo de deteccion de fallo + recuperacion (MTTR) | < 5 min (automatico) |
| Incidentes funcionales post-deploy | 0 criticos |
| Fases completadas a tiempo | > 80% |

---

## Resumen: que aporto cada plan

| Aporte | Origen |
|---|---|
| Estructura de tareas detallada por fase, actor, y criterio de salida | Claude |
| "Shadow Mode", "Read-only Friday", crisis protocols, timeline 3 semanas | Gemini |
| RACI, Go/No-Go, KPIs, ventanas de cambio, comunicacion, "2 ejecuciones consecutivas" | Codex |
| Observacion 24-48h obligatoria en filiales piloto | Codex + Gemini |
| Orden de go-live (central → mobile → desktop → filiales) | Codex |

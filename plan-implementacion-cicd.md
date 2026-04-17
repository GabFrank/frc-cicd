# Plan de Implementacion CI/CD — FRC Sistemas Informaticos

**Fecha:** 2026-03-26
**Version:** Final (basado en v3, revisado por claude, codex, gemini)
**Objetivo:** Guia operativa paso a paso para implementar el CI/CD en 2 semanas.

---

## Estado actual de los repositorios

La limpieza pre-CI/CD ya fue ejecutada. Los 4 repos estan en rama `develop` con estos cambios aplicados:

| Repo | Branch | Commit de limpieza | Que se hizo |
|---|---|---|---|
| Backend Central | `develop` | `7b9f875` | RabbitMQ eliminado, CI profile, VersionController, actuator, finalName=frc-central-server |
| Backend Filial | `develop` | `c05dadf` | Dockerfile/run.sh eliminados, tests obsoletos, CI profile, VersionController, finalName=frc-filial-server |
| Desktop | `develop` | `28a8fd6` | commitlint + husky instalados |
| Mobile | `develop` | `47fea4b` | keystores protegidos, signing CI, Firebase workflows eliminados, commitlint + husky |

---

## Resumen de lo que se implementa

| Componente | CI | Release automatico | Deploy | Auto-update |
|---|---|---|---|---|
| Backend Central | PR → lint + test + build | Push a develop/release/main → semantic-release + JAR | Manual (workflow_dispatch) con rollback | N/A |
| Backend Filial | PR → lint + test + build | Push a develop/release/main → semantic-release + JAR | N/A | Script pull-based (Linux cron / Windows Task Scheduler) |
| Desktop | PR → lint + test + build | Push → electron-builder + semantic-release | N/A | electron-updater nativo |
| Mobile | PR → lint + test + APK debug | Push → signed APK/AAB + semantic-release | Manual a Play Store tracks | Play Store |

---

## Pre-flight: Verificar antes de empezar

Antes de tocar GitHub o servidores, confirmar:

- [ ] `git status` limpio en los 4 repos (0 uncommitted files)
- [ ] Ramas `develop` existen y son las activas en los 4 repos
- [ ] Version base actual confirmada: `3.0.9` en los 4 proyectos
- [ ] Acceso a GitHub con permisos de admin en los repos
- [ ] Acceso SSH al droplet de produccion (backend central)
- [ ] Acceso a Google Play Console (mobile)

---

## Fase 0: Prerequisitos

### Cosas que hacer UNA sola vez

- [x] **Conventional Commits:** Comunicar al equipo la convencion (`feat:`, `fix:`, `chore:`, `refactor:`, etc.)
  - Desktop y Mobile: ya tienen `commitlint.config.js` + husky configurado.
  - Backends (Java): NO instalar husky ni Node localmente. El formato se valida en CI con un step de commitlint.
- [x] **Crear ramas:** `develop` creado en los 4 repos desde `3.0.9-gab`.
- [ ] **GitHub Environments:** En cada repo que tenga deploy (central, mobile), crear 3 environments en Settings → Environments:
  - `alpha` — sin proteccion
  - `beta` — sin proteccion
  - `production` — con "Required reviewers" activado (1 reviewer)
- [ ] **Branch protection:** Configurar en los 4 repos:
  - `main`: require PR, require status checks (CI), no force push
  - `develop`: require PR, require status checks (CI)
  - **Importante:** NO es necesario crear excepciones para semantic-release. Los workflows no usan `@semantic-release/git` (no hacen push a la rama), solo crean tags y GitHub Releases via API, que no son afectados por branch protection.

### Secrets a configurar

| Repo | Secret | Valor | Donde conseguirlo |
|---|---|---|---|
| backend-central | `PACKAGES_PAT` | Token GitHub con `read:packages` | GitHub → Settings → Developer settings → Fine-grained tokens |
| backend-central | `DEPLOY_SSH_HOST` | IP del droplet | Panel de DigitalOcean |
| backend-central | `DEPLOY_SSH_USER` | Usuario SSH (ej: `deploy`) | Servidor |
| backend-central | `DEPLOY_SSH_KEY` | Clave privada SSH | `ssh-keygen -t ed25519` en local, copiar publica al servidor |
| backend-central | `DEPLOY_SSH_PORT` | Puerto SSH (ej: `22`) | Servidor |
| backend-filial | `PACKAGES_PAT` | Mismo token que central | Reusar |
| mobile | `KEYSTORE_BASE64` | Keystore en base64 (ver nota abajo) | Archivo local del keystore |
| mobile | `KEYSTORE_PASSWORD` | Contrasena del keystore | Equipo de desarrollo |
| mobile | `KEY_ALIAS` | Alias de la clave | Equipo de desarrollo |
| mobile | `KEY_PASSWORD` | Contrasena de la clave | Equipo de desarrollo |
| mobile | `GOOGLE_PLAY_SERVICE_ACCOUNT` | JSON completo de la cuenta de servicio | Google Play Console → API access |

> **Nota KEYSTORE_BASE64:** Usar comando portable que evita saltos de linea:
> ```bash
> base64 < frc-keystore.jks | tr -d '\n'
> ```
> No usar `cat file | base64` ya que puede introducir saltos de linea segun el OS.

> **Nota:** Si los repos estan en una organizacion GitHub, `PACKAGES_PAT` se puede configurar como Organization secret para evitar duplicacion.

### Preparacion del servidor (droplet — Backend Central)

- [ ] Crear usuario de deploy: `sudo adduser deploy`
- [ ] Crear estructura de directorios:
  ```bash
  sudo mkdir -p /opt/frc-backend-central/{releases,current}
  sudo chown -R deploy:deploy /opt/frc-backend-central
  ```
- [ ] Crear archivo de variables de entorno `/opt/frc-backend-central/.env`:
  ```bash
  SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/bodega
  SPRING_DATASOURCE_USERNAME=<usuario_real>
  SPRING_DATASOURCE_PASSWORD=<password_real>
  # Agregar otras variables necesarias (puerto, etc.)
  ```
  ```bash
  chmod 600 /opt/frc-backend-central/.env
  chown deploy:deploy /opt/frc-backend-central/.env
  ```
- [ ] Crear servicio systemd `/etc/systemd/system/frc-central-server.service`:
  ```ini
  [Unit]
  Description=FRC Central Server
  After=network.target postgresql.service

  [Service]
  Type=simple
  User=deploy
  EnvironmentFile=/opt/frc-backend-central/.env
  ExecStart=/usr/bin/java -jar /opt/frc-backend-central/current/frc-central-server.jar
  Restart=on-failure
  RestartSec=10

  [Install]
  WantedBy=multi-user.target
  ```
- [ ] `sudo systemctl enable frc-central-server`
- [ ] **Swap file** (si el droplet tiene <= 2GB RAM):
  ```bash
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```
  Esto previene OOM durante el arranque de Spring Boot en deploys.
- [ ] **Instalar version base** (ANTES del primer deploy automatico):
  ```bash
  # Ajustar BASE_VERSION a la version actual de produccion
  BASE_VERSION=3.0.9
  mkdir -p /opt/frc-backend-central/releases/$BASE_VERSION
  cp /path/to/current/frc-central-server.jar /opt/frc-backend-central/releases/$BASE_VERSION/
  ln -sfn /opt/frc-backend-central/releases/$BASE_VERSION /opt/frc-backend-central/current
  echo "$BASE_VERSION" > /opt/frc-backend-central/.current-version
  ```
  Sin esto, el primer rollback falla porque no hay version anterior.

---

## Fase 1: Backend Central (Semana 1)

### Dia 1: CI

1. **Crear V0 migration** (si Flyway no tiene baseline):
   - [ ] Exportar DDL actual de la DB de produccion
   - [ ] Guardar como `src/main/resources/db/migration/V0__initial_schema.sql`
   - [ ] **Importante:** Respaldar la DB antes de cualquier cambio. Solo crear V0 si no existe historial de Flyway. Validar primero en entorno de prueba.
   - [ ] Verificar que pasa localmente con PostgreSQL 16:
     ```bash
     SPRING_PROFILES_ACTIVE=ci ./mvnw clean verify
     ```

2. ~~**Agregar version endpoint**~~ — **YA HECHO** en commit de limpieza (`VersionController.java`, `app.version=@project.version@`, actuator endpoints).

3. **Crear CI workflow:**
   - [ ] Copiar `ci.yml` del documento de arquitectura al repo
   - [ ] **Verificar que el `settings.xml` del workflow usa el server ID correcto:**
     ```xml
     <server>
       <id>github-jsifenlib</id>
       <username>${env.GITHUB_ACTOR}</username>
       <password>${env.PACKAGES_PAT}</password>
     </server>
     ```
     (El `pom.xml` usa `<id>github-jsifenlib</id>` para el repositorio de GitHub Packages. Si el workflow usa `<id>github</id>`, Maven no encontrara las credenciales y fallara al descargar `jsifenlib`.)
   - [ ] Crear branch `ci/lab` desde `develop`, hacer cambios, y **crear un PR de `ci/lab` hacia `develop`** (el CI solo se dispara en PRs hacia develop/release/main, no en push directo)
   - [ ] Verificar: SpotBugs pasa (report-only), tests pasan, build genera JAR

### Dia 2: Release

1. **Crear archivos de release:**
   - [ ] Crear `.releaserc.json` (ver documento de arquitectura)
   - [ ] **Verificar que `.releaserc.json` NO incluye `@semantic-release/git`**. Solo debe tener: `@semantic-release/commit-analyzer`, `@semantic-release/release-notes-generator`, `@semantic-release/exec`, `@semantic-release/github`. Sin `@semantic-release/git`, semantic-release solo crea tags y GitHub Releases, y no intenta hacer push a la rama (que seria bloqueado por branch protection).
   - [ ] Copiar `release.yml` al repo
   - [ ] **Verificar que el `settings.xml` del release workflow tambien usa `github-jsifenlib`**

2. **Primer release alpha:**
   - [ ] Mergear algo a `develop` con commit `feat: initial CI/CD setup`
   - [ ] Verificar que semantic-release crea un GitHub Release con un tag alpha (la version depende del historial de tags existente — si el proyecto esta en v3.0.9, el primer alpha sera algo como `v3.1.0-alpha.1` para un `feat:` o `v3.0.10-alpha.1` para un `fix:`)
   - [ ] Verificar que el JAR esta adjunto al release con nombre `frc-central-server.jar`

### Dia 3: Deploy

1. **Verificar secrets SSH** en GitHub (ver tabla de secrets arriba)

2. **Crear deploy workflow:**
   - [ ] Copiar `deploy.yml` del documento de arquitectura
   - [ ] Ejecutar manualmente: Actions → Deploy → Run workflow → version: (la version alpha creada en Dia 2), environment: `alpha`
   - [ ] Verificar: JAR se copia al servidor, servicio se reinicia, health check pasa

3. **Probar rollback:**
   - [ ] Desplegar una version que falle de forma controlada (ej: cambiar temporalmente el puerto del servidor en una variable de entorno, no un JAR corrupto — esto simula un fallo real y permite restaurar facilmente)
   - [ ] Verificar que el rollback automatico restaura la version anterior

### Dia 4: Ciclo completo

- [ ] Crear un PR con `fix: test complete cycle`
- [ ] Verificar CI pasa
- [ ] Mergear a `develop`
- [ ] Verificar release alpha se crea
- [ ] Ejecutar deploy manual a `alpha`
- [ ] Verificar health check y que `/actuator/health` responde

### Dia 5: Governance

- [ ] Configurar branch protection en `main` y `develop`
- [ ] Configurar GitHub Environments con approval en `production`
- [ ] Probar: ejecutar deploy a `production` → debe pedir aprobacion
- [ ] Documentar el flujo para el equipo

---

## Fase 2: Backend Filial (Semana 2, Dia 1-3)

### Dia 1: CI + Release

1. **Copiar workflows:**
   - [ ] Copiar `ci.yml` y `release.yml` del central
   - [ ] Cambiar `POSTGRES_DB: bodega` → `POSTGRES_DB: general`
   - [ ] Cambiar `SPRING_DATASOURCE_URL` a `general`
   - [ ] Cambiar nombres de JAR a `frc-filial-server`
   - [ ] Crear `.releaserc.json` con nombre de JAR correcto
   - [ ] **Verificar que `settings.xml` usa `github-jsifenlib`** (mismo fix que en central)

2. **Primer release:**
   - [ ] Push a `develop`, verificar que se crea release con JAR adjunto

### Dia 2: Auto-update filiales Linux (piloto)

> **Nota de naming:** El asset en cada GitHub Release se llama `frc-filial-server.jar` (nombre del artefacto Maven). En las filiales, el archivo local del servicio se llama `frc-server.jar` (nombre que WinSW/systemd conoce). El script de update descarga `frc-filial-server.jar` y lo copia como `frc-server.jar` localmente.

1. **Instalar en 1 filial piloto Linux:**
   - [ ] Instalar `jq`: `sudo apt install jq`
   - [ ] Copiar `check-update.sh` a `/opt/frc-filial/`
   - [ ] `chmod +x /opt/frc-filial/check-update.sh`
   - [ ] Crear `/opt/frc-filial/.channel` con contenido `alpha`
   - [ ] Crear `/opt/frc-filial/.github-token` con un token fine-grained (permisos: `Contents: Read` + `Metadata: Read` en el repo de filial)
   - [ ] `chmod 600 /opt/frc-filial/.github-token`
   - [ ] **Instalar version base** antes de activar el cron:
     ```bash
     BASE_VERSION=3.0.9
     mkdir -p /opt/frc-filial/releases/$BASE_VERSION
     cp /path/to/current/frc-filial-server.jar /opt/frc-filial/releases/$BASE_VERSION/
     ln -sfn /opt/frc-filial/releases/$BASE_VERSION /opt/frc-filial/current
     echo "$BASE_VERSION" > /opt/frc-filial/.current-version
     ```
   - [ ] Crear servicio systemd (similar al central, puerto 8082, con EnvironmentFile)
   - [ ] Configurar cron **con flock** para prevenir ejecuciones superpuestas:
     ```
     */15 * * * * flock -n /tmp/frc-filial-update.lock /opt/frc-filial/check-update.sh >> /var/log/frc-update.log 2>&1
     ```

2. **Probar:**
   - [ ] Crear un release alpha en el repo
   - [ ] Ejecutar el script manualmente: `/opt/frc-filial/check-update.sh`
   - [ ] Verificar que la filial se actualizo y health check pasa
   - [ ] Verificar logs en `/var/log/frc-update.log`

### Dia 3: Auto-update filiales Windows (piloto)

> Implementar Windows **despues** de validar que el flujo Linux funciona correctamente. Esto reduce riesgo y permite depurar el proceso de update en un entorno mas controlado antes de agregar la complejidad de Windows.

Las filiales Windows usan WinSW para gestionar el servicio. La estructura de archivos existente es `C:\FRC\frc-server\`.

1. **Instalar en 1 filial piloto Windows:**
   - [ ] Crear estructura de directorios:
     ```powershell
     New-Item -ItemType Directory -Force -Path C:\FRC\frc-server\releases
     New-Item -ItemType Directory -Force -Path C:\FRC\frc-server\backup
     ```
   - [ ] Copiar `check-update.ps1` a `C:\FRC\frc-server\`
   - [ ] Crear `C:\FRC\frc-server\.channel` con contenido `alpha`
   - [ ] Crear `C:\FRC\frc-server\.github-token` con el token fine-grained (mismo que Linux)
   - [ ] **Proteger el archivo de token** (equivalente a `chmod 600` en Linux):
     ```powershell
     $acl = Get-Acl "C:\FRC\frc-server\.github-token"
     $acl.SetAccessRuleProtection($true, $false)
     $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("SYSTEM", "FullControl", "Allow")
     $acl.AddAccessRule($rule)
     $rule = New-Object System.Security.AccessControl.FileSystemAccessRule("Administrators", "FullControl", "Allow")
     $acl.AddAccessRule($rule)
     Set-Acl "C:\FRC\frc-server\.github-token" $acl
     ```
   - [ ] **Instalar version base:**
     ```powershell
     Copy-Item C:\FRC\frc-server\frc-server.jar C:\FRC\frc-server\releases\3.0.9.jar
     Set-Content C:\FRC\frc-server\.current-version "3.0.9"
     ```
   - [ ] Configurar Task Scheduler (equivalente a cron):
     ```powershell
     $action = New-ScheduledTaskAction -Execute "PowerShell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\FRC\frc-server\check-update.ps1"
     $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration ([TimeSpan]::MaxValue)
     $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew
     Register-ScheduledTask -TaskName "FRC-Filial-Update" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -User "SYSTEM"
     ```
     Notas:
     - `-MultipleInstances IgnoreNew` evita ejecuciones superpuestas (equivalente a `flock` en Linux).
     - `-RepetitionDuration ([TimeSpan]::MaxValue)` hace que la tarea repita indefinidamente. Sin este parametro, algunos entornos Windows no repiten la tarea.
   - [ ] **Verificar que la tarea se creo correctamente:** `Get-ScheduledTaskInfo -TaskName "FRC-Filial-Update"`

2. **Script `check-update.ps1`:**
   ```powershell
   # check-update.ps1 — Auto-update para filial Windows
   # Compatible con PowerShell 5.1+ (no usa operadores de PS 7)
   $ErrorActionPreference = "Stop"
   $BASE_DIR = "C:\FRC\frc-server"
   $REPO = "GabFrank/franco-system-backend-filial"  # Ajustar al repo real
   $SERVICE_NAME = "frc-server"  # Nombre del servicio WinSW
   $JAR_NAME = "frc-filial-server.jar"  # Nombre del asset en GitHub Release
   $LOCAL_JAR = "frc-server.jar"        # Nombre local del JAR del servicio

   # Leer configuracion (compatible con PowerShell 5.1 — sin operador ??)
   $CHANNEL = Get-Content "$BASE_DIR\.channel" -ErrorAction SilentlyContinue
   if (-not $CHANNEL) { $CHANNEL = "alpha" }
   $TOKEN = Get-Content "$BASE_DIR\.github-token" -ErrorAction SilentlyContinue
   $CURRENT = Get-Content "$BASE_DIR\.current-version" -ErrorAction SilentlyContinue
   if (-not $CURRENT) { $CURRENT = "none" }

   $headers = @{}
   if ($TOKEN) { $headers["Authorization"] = "token $TOKEN" }
   $headers["Accept"] = "application/vnd.github.v3+json"

   # Determinar release segun canal
   if ($CHANNEL -eq "alpha" -or $CHANNEL -eq "beta") {
       $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases" -Headers $headers
       $release = $releases | Where-Object { $_.tag_name -match "-$CHANNEL" -and -not $_.draft } | Select-Object -First 1
   } else {
       $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest" -Headers $headers
   }

   if (-not $release) {
       Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') No release found for channel $CHANNEL"
       exit 0
   }

   $LATEST = $release.tag_name -replace '^v', ''

   if ($LATEST -eq $CURRENT) {
       Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Already on $CURRENT"
       exit 0
   }

   Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Updating $CURRENT -> $LATEST"

   # Descargar JAR
   $asset = $release.assets | Where-Object { $_.name -eq $JAR_NAME } | Select-Object -First 1
   if (-not $asset) {
       Write-Output "ERROR: JAR $JAR_NAME not found in release assets"
       exit 1
   }

   $downloadHeaders = $headers.Clone()
   $downloadHeaders["Accept"] = "application/octet-stream"
   $tempJar = "$BASE_DIR\releases\$LATEST.jar"
   Invoke-WebRequest -Uri $asset.url -Headers $downloadHeaders -OutFile $tempJar

   # Backup actual
   if (Test-Path "$BASE_DIR\$LOCAL_JAR") {
       Copy-Item "$BASE_DIR\$LOCAL_JAR" "$BASE_DIR\backup\$LOCAL_JAR-$CURRENT.bak"
   }

   # Parar servicio, reemplazar JAR, iniciar
   net stop $SERVICE_NAME 2>$null
   Start-Sleep -Seconds 3
   Copy-Item $tempJar "$BASE_DIR\$LOCAL_JAR" -Force
   net start $SERVICE_NAME

   # Health check
   Start-Sleep -Seconds 30
   try {
       $health = Invoke-RestMethod -Uri "http://localhost:8082/actuator/health" -TimeoutSec 10
       if ($health.status -eq "UP") {
           Set-Content "$BASE_DIR\.current-version" $LATEST
           Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Update to $LATEST OK"
       } else {
           throw "Health check: status is $($health.status)"
       }
   } catch {
       Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Health check FAILED, rolling back..."
       net stop $SERVICE_NAME 2>$null
       Start-Sleep -Seconds 3
       Copy-Item "$BASE_DIR\backup\$LOCAL_JAR-$CURRENT.bak" "$BASE_DIR\$LOCAL_JAR" -Force
       net start $SERVICE_NAME
       Write-Output "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Rollback to $CURRENT complete"
   }
   ```

3. **Probar en Windows:**
   - [ ] Ejecutar manualmente (como administrador): `powershell -File C:\FRC\frc-server\check-update.ps1`
   - [ ] Verificar que descarga el JAR, reinicia el servicio, y health check pasa
   - [ ] Verificar rollback: parar la app manualmente despues del update, verificar que el script restaura

---

## Fase 3: Desktop (Semana 2, Dia 4) — COMPLETADA ✓

> **Estado:** Implementada y validada en alpha. Releases alpha.1 a alpha.20 ejecutados.
> **Fecha de completacion:** 2026-04-06

### CI + Release — COMPLETADO

1. **Workflows creados:**
   - [x] CI workflow (`ci.yml`): build en matrix ubuntu-latest + windows-latest
   - [x] Release workflow (`release.yml`): semantic-release + electron-builder por plataforma
   - [x] `.releaserc.json` configurado con `commit-analyzer`, `release-notes-generator`, `github`

2. **Arquitectura del release:**
   El release se ejecuta en 2 jobs:
   - **Job 1 (release):** semantic-release crea el tag y GitHub Release (sin artefactos)
   - **Job 2 (build):** matrix build (Linux + Windows), cada runner compila y sube artefactos al release existente

   Los `package.json` (raiz y `app/`) se actualizan con la version en el step "Update package.json versions" del Job 2.

   Los manifiestos de canal (`alpha.yml`, `alpha-linux.yml`) se generan copiando los `latest*.yml` que electron-builder produce, renombrados segun el canal.

3. **Electron-updater activado y configurado:**
   - [x] `autoDownload: false` — el usuario controla cuando descargar
   - [x] `autoInstallOnAppQuit: false` — instalacion solo via `quitAndInstall(false, true)`
   - [x] Canal de actualizacion configurable desde UI (alpha/beta/stable/dev)
   - [x] Configuracion de canal persistida via IPC al main process (no depende de `@electron/remote`)
   - [x] Check automatico cada 5 minutos + check manual desde menu

### Problemas encontrados y resueltos durante alpha

| # | Problema | Causa raiz | Fix | Alpha |
|---|---|---|---|---|
| 1 | NSIS mataba el proceso al actualizar | `installer.nsh` ejecutaba `taskkill /F` incondicionalmente | Condicion `${IfNot} ${Silent}` para no matar en modo silencioso | alpha.12 |
| 2 | `app.quit()` no pasaba flags correctos a NSIS | Comentario incorrecto evitaba usar `quitAndInstall()` | Reemplazado por `autoUpdater.quitAndInstall(false, true)` | alpha.12 |
| 3 | Colision de nombre instalador/ejecutable | `artifactName: "FRC.${ext}"` → instalador y app se llamaban `FRC.exe` | Renombrado a `FRC Setup.${ext}` | alpha.12 |
| 4 | 404 al descargar update | GitHub convierte espacios a puntos en assets (`FRC.Setup.exe`), pero el YAML dice `FRC-Setup.exe` (guion) | Cambiado `artifactName` a `FRC-Setup.${ext}` (guion directo, sin espacios) | alpha.15 |
| 5 | Canal de update no persistia entre reinicios | Renderer guardaba config con `@electron/remote` que resolvia path diferente al main process | Renderer envia config al main via IPC (`save-config-backup`), main lo guarda en su propio `userData` | alpha.18 |
| 6 | Zoom no se aplicaba visualmente tras update | `setZoomLevel()` no forzaba repaint | Agregado `invalidate()` + persistencia de zoom en archivo JSON | alpha.16-17 |
| 7 | Zoom default no adecuado para todas las resoluciones | Valor fijo `-1.5` demasiado grande en pantallas de baja resolucion | Calculo dinamico basado en `workAreaSize` y `scaleFactor` del display | alpha.20 |

### Validacion final — COMPLETADA

- [x] Release automatico al mergear a `develop` (semantic-release genera tag + GitHub Release)
- [x] Artefactos adjuntos: `FRC-Setup.exe`, `FRC.AppImage`, manifiestos `.yml`, blockmaps
- [x] Auto-update detecta nueva version sin intervencion manual
- [x] Descarga completa del instalador sin errores 404
- [x] `quitAndInstall` cierra la app e instala la nueva version correctamente
- [x] La app reinicia automaticamente con la version nueva
- [x] Canal de actualizacion persiste entre reinicios
- [x] Zoom del usuario se mantiene tras actualizacion
- [x] Probado en Windows (maquina fisica) y Linux

---

## Fase 4: Mobile (Semana 2, Dia 5)

### CI + Release + Play Store

1. **Crear workflows:**
   - [x] `ci.yml` — PR lint + build Angular (dev) + APK debug (**PR #2, 2026-04-06**)
   - [x] `release.yml` — semantic-release + signed APK/AAB (**PR #2, 2026-04-06**)
   - [x] `deploy-playstore.yml` — deploy manual a Play Store (**PR #2, 2026-04-06**)
   - [x] `.releaserc.json` — branches develop/release/main, plugins exec+github (**PR #3, 2026-04-06**)

2. **Configurar secrets** de keystore en GitHub
   - [x] `KEYSTORE_BASE64` — configurado (**2026-04-06**)
   - [x] `KEYSTORE_PASSWORD` — configurado (**2026-04-06**)
   - [x] `KEY_ALIAS` — valor: `frc` (**2026-04-06**)
   - [x] `KEY_PASSWORD` — configurado (**2026-04-06**)

3. **versionCode — Agregar offset:**
   - [x] Implementado en `release.yml` con step separado: `$(( github.run_number + 100 ))` → `$VERSION_CODE` (**PR #5, 2026-04-06**)
   - **Nota:** No se puede usar aritmetica directa en `env:` de GitHub Actions. Se usa un step intermedio con `$GITHUB_OUTPUT`.
   - **Nota:** No usar `${GITHUB_RUN_NUMBER:-0}` en `prepareCmd` — lodash template de `@semantic-release/exec` lo interpreta como template, no bash.

4. **Fixes necesarios para build de produccion (AOT):**
   - [x] `phonegap-plugin-barcodescanner` usa `compile()` deprecado — parcheado via `postinstall` en `package.json` (**PR #2, 2026-04-06**)
   - [x] `capacitor.build.gradle` tenia Java 21, corregido a Java 17 (**PR #2, 2026-04-06**)
   - [x] Variable `producto` usada fuera de scope `*ngFor` en search-producto-dialog y transaferencia-list-productos (**PR #6, 2026-04-06**)
   - [x] Componentes comentados en `OperacionesModule` (CajaComponent, CajaInfoComponent, etc.) — descomentados (**PR #6, 2026-04-06**)
   - **Nota:** El build de dev (`npm run build`) siempre paso. Solo el build de produccion (`--configuration production`) falla con AOT porque es mas estricto con tipos. El CI usa build dev, el release usa build production.

5. **Primer release alpha:**
   - [x] Release alpha creado exitosamente con APK y AAB adjuntos (**2026-04-06**)
   - [ ] Verificar que `versionName` y `versionCode` en el APK son correctos (versionCode debe ser > 7)

6. **Configurar Google Play Service Account:**
   - [ ] Ir a Google Play Console → Setup → API access
   - [ ] Crear Service Account con permisos de "Release manager"
   - [ ] Descargar JSON y guardarlo como secret `GOOGLE_PLAY_SERVICE_ACCOUNT`

7. **Probar deploy a Play Store:**
   - [ ] Ejecutar deploy manual a track `internal`
   - [ ] Verificar que el AAB aparece en Google Play Console

### Notas de implementacion mobile

- **Rama `develop`** no existia en el remote — fue pusheada durante la implementacion.
- **Rama por defecto** del repo sigue siendo `master`. Considerar cambiarla a `develop` o `main`.
- **Lint** no esta habilitado en CI — falta `@angular-eslint/builder` como dependencia. Se puede agregar despues. Hay ~773 warnings de estilo que se pueden limpiar gradualmente.
- **PRs creados durante implementacion:** #1 (signing config), #2 (workflows), #3 (.releaserc.json), #4 (VERSION_CODE template fix), #5 (VERSION_CODE step fix), #6 (AOT build fixes)

---

## Post-implementacion: Mejoras opcionales

Estas mejoras se pueden agregar en cualquier momento, sin urgencia:

| Mejora | Esfuerzo | Como |
|---|---|---|
| Trivy (vulnerability scan) | 5 min | Agregar 1 step de Trivy en CI |
| Push protection (secret scanning) | 2 min | Checkbox en GitHub repo settings |
| Notificaciones Slack/Discord | 15 min | Workflow con `slackapi/slack-github-action` |
| Notificaciones WhatsApp (CI/CD + SaaS) | 1-2 dias / 2-3 semanas | Ver **Fase 12** abajo (Evolution API self-hosted) |
| Monitoreo de filiales | 1-2 horas | Endpoint en backend central que filiales llaman al hacer health check |
| Auto-update del script de filiales | 30 min | 3 lineas al inicio del script que descargan la ultima version de si mismo |

---

## Fase 12: Notificaciones WhatsApp (CI/CD + SaaS)

**Estado:** Planificado. No iniciado.
**Decision tecnica:** **Evolution API** self-hosted (open source, basado en Baileys + soporte Cloud API oficial). Multi-instancia gratis, REST + webhooks, hecho para multi-tenant SaaS LATAM.
**Alternativas evaluadas:** WAHA Core (1 sesion free, Plus $19/mes), go-whatsapp-web-multidevice (1 sesion por proceso). Descartadas por limite de sesiones — Fase 2 requiere multi-tenancy nativa.

### Vision general

Dos sub-fases independientes que comparten el mismo server Evolution:

| Sub-fase | Cuando | Esfuerzo | Audiencia |
|---|---|---|---|
| **Fase 12.A** — Avisos CI/CD al equipo dev | Despues de completar checklist actual | 1-2 dias dev + 2-3 hs SysAdmin | Equipo interno FRC |
| **Fase 12.B** — Avisos institucionales SaaS frc-comercial | Post Fase 12.A estable | 2-3 semanas dev + 1 semana piloto | Funcionarios de empresas cliente |

### Arquitectura general

```
                       ┌────────────────────────────────────┐
                       │   Evolution API (Docker)           │
                       │   wa.frcsi.com.py                  │
                       │                                    │
                       │   Instancias:                      │
                       │   ├─ frc-cicd       (Fase 12.A)    │
                       │   ├─ alpha-rrhh     (Fase 12.B)    │
                       │   ├─ alpha-operac   (Fase 12.B)    │
                       │   ├─ farmacia-rrhh  (Fase 12.B)    │
                       │   └─ ...                           │
                       │                                    │
                       │   Postgres + Redis (locales)       │
                       └────────────────────────────────────┘
                              ▲                   ▲
                              │ REST + webhook    │
                              │                   │
            ┌─────────────────┴─────┐   ┌─────────┴─────────────┐
            │  GitHub Actions       │   │  Backend Central      │
            │  (4 repos frc-comer)  │   │  WhatsAppService +    │
            │  notify-whatsapp.yml  │   │  outbox scheduler     │
            └───────────────────────┘   └───────────────────────┘
```

---

### Hosting + costos

| Item | Opcion A — mismo droplet central | Opcion B — VPS dedicado ⭐ |
|---|---|---|
| Costo extra/mes | $0 | $5-10 (Hetzner CX22, Contabo VPS S, DO basic) |
| Aislamiento recursos | ❌ comparte con Spring Boot + Postgres | ✅ |
| Riesgo cruzado downtime | Alto (OOM tumba ambos servicios) | Bajo |
| Backup/restore | Mezclado con backups del SaaS | Independiente |
| Migracion futura | Compleja | Simple (mover container) |
| Recomendado | Solo si recursos sobran | **Si — recomendado** |

**Decision:** VPS dedicado pequeno (1-2 GB RAM, 1 vCPU, 25 GB SSD). El central ya tiene Postgres aparte, no sumarle carga ni riesgo.

---

## Fase 12.A — Avisos CI/CD al equipo dev

### Decisiones de diseno

- **1 numero WhatsApp dedicado FRC** (linea celular nueva, NO numero personal de nadie). Idealmente plan data-only barato.
- **1 instancia Evolution: `frc-cicd`** — todos los repos publican aca.
- **1 grupo WhatsApp "FRC CI/CD Alerts"** con todos los miembros del equipo dev. Group ID se anota como secret.
- **Eventos a notificar** (configurables por filtro en workflow):
  - PR abierto / `ready_for_review` / mergeado
  - Release publicado (alpha, beta, stable)
  - Deploy iniciado / completado / fallido
  - Rollback ejecutado
  - Filial fallo auto-update

### Tareas detalladas

#### Setup infra (2-3 horas, SysAdmin)

| # | Tarea | Actor | Notas |
|---|---|---|---|
| 12.A.1 | Provisionar VPS dedicado (Hetzner CX22 o equivalente, Ubuntu 24.04) | SysAdmin | 1-2 GB RAM, IP publica |
| 12.A.2 | Comprar/asignar linea celular dedicada FRC | LT | Tigo/Personal/Claro plan basico. Mantener chip activo. |
| 12.A.3 | Apuntar DNS `wa.frcsi.com.py` (o subdominio disponible) al VPS | SysAdmin | Necesario para SSL |
| 12.A.4 | Instalar Docker + docker-compose + nginx + certbot | SysAdmin | |
| 12.A.5 | Crear `/opt/frc-whatsapp/docker-compose.yml` con servicios `evolution`, `postgres`, `redis` | SysAdmin | Imagen `atendai/evolution-api:latest` |
| 12.A.6 | Configurar `.env` con `AUTHENTICATION_API_KEY` (random 64 chars), `DATABASE_*`, `REDIS_*`, `SERVER_URL=https://wa.frcsi.com.py` | SysAdmin | API key se guarda en GitHub Org Secrets |
| 12.A.7 | Levantar stack: `docker compose up -d` | SysAdmin | |
| 12.A.8 | Configurar nginx reverse proxy + Let's Encrypt SSL | SysAdmin | HTTPS obligatorio para webhooks GitHub |
| 12.A.9 | Crear instancia `frc-cicd` via REST: `POST /instance/create` con `instanceName=frc-cicd` y `qrcode=true` | Dev Lead | curl con header `apikey` |
| 12.A.10 | Escanear QR (devuelto por endpoint) desde telefono con numero FRC | LT | Sesion persiste indefinidamente |
| 12.A.11 | Crear grupo WhatsApp "FRC CI/CD Alerts" + agregar miembros equipo | LT | |
| 12.A.12 | Anotar group ID (formato `XXXXXXXXXXXXX@g.us`) — extraer via `GET /chat/findGroups/frc-cicd` | Dev Lead | Guardar como secret `WHATSAPP_GROUP_ID` |
| 12.A.13 | Test manual: `POST /message/sendText/frc-cicd` con `{"number":"GROUP_ID","text":"test"}` | Dev Lead | Verificar mensaje llega al grupo |

#### Workflow reutilizable GitHub Actions (3-4 horas, Dev Lead)

| # | Tarea | Actor | Notas |
|---|---|---|---|
| 12.A.14 | Crear repo nuevo `frc-github-shared` (o usar existente) con `.github/workflows/notify-whatsapp.yml` como **reusable workflow** | Dev Lead | Evita duplicar en 4 repos |
| 12.A.15 | Definir `inputs`: `event_type` (string), `repo`, `version`, `url`, `status`, `actor`, `extra` (json) | Dev Lead | |
| 12.A.16 | Definir `secrets`: `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_INSTANCE`, `WHATSAPP_GROUP_ID` | Dev Lead | `inherit` desde caller |
| 12.A.17 | Step de formateo: switch por `event_type` que arma mensaje con templates (jq + heredoc) | Dev Lead | Templates abajo |
| 12.A.18 | Step `curl` POST a Evolution con manejo de errores (no debe romper el workflow caller si WA falla) | Dev Lead | `\|\| true` o `continue-on-error: true` |
| 12.A.19 | Configurar `WHATSAPP_*` como **GitHub Organization Secrets** (visibles a los 4 repos) | LT | Evita configurar 4 veces |

#### Integracion en cada repo (2-3 horas total, Dev Lead)

| # | Tarea | Actor | Notas |
|---|---|---|---|
| 12.A.20 | Central: agregar `notify-whatsapp.yml` callers en `pull_request` (opened, ready_for_review, closed con merged=true), `release.published`, y al final del workflow `Deploy` (success/failure) | Dev Lead | |
| 12.A.21 | Filial: igual triggers (PR + release). Para auto-update fail: agregar `curl` a webhook WA dentro de `notify_github()` en `check-update.sh` y `check-update.ps1` | Dev Lead + SysAdmin | Webhook secret distinto, endpoint puede ser un workflow `repository_dispatch` o llamada directa a Evolution |
| 12.A.22 | Desktop: triggers PR + release.published | Dev Lead | |
| 12.A.23 | Mobile: triggers PR + release.published + final de `deploy-playstore.yml` | Dev Lead | |

#### Validacion (1 dia, QA)

| # | Tarea | Actor |
|---|---|---|
| 12.A.24 | PR test en cada uno de los 4 repos → verificar mensaje "PR abierta" en grupo | QA |
| 12.A.25 | Mergear PR test → verificar mensaje "PR mergeada" + posterior "Release publicado" | QA |
| 12.A.26 | Ejecutar deploy central manual a alpha → verificar mensajes "Deploy iniciado" + "Deploy completado" | LT |
| 12.A.27 | Forzar fallo health check en filial test → verificar mensaje "Auto-update fallo + rollback" | SysAdmin |
| 12.A.28 | Verificar resiliencia: parar container Evolution, ejecutar PR → workflow caller no debe fallar (solo WA notification se pierde) | Dev Lead |
| 12.A.29 | Documentar en `guia-desarrollo-cicd.md`: como silenciar grupo, como agregar miembros, como cambiar templates | Dev Lead |

### Templates de mensaje (Fase 12.A)

```
🔄 *PR abierta* — frc-central
#234 feat(stock): nuevo endpoint inventario
@gabfrank → develop
https://github.com/.../pull/234
```

```
✅ *PR mergeada* — frc-desktop
#89 fix(login): corrige timeout sesion
@user2 → develop (squash NO, merge commit)
```

```
🎉 *Release publicado* — frc-mobile
v1.0.5-beta.2 (canal beta)
3 features, 5 fixes
https://github.com/.../releases/tag/v1.0.5-beta.2
```

```
🚀 *Deploy iniciado* — central
v4.0.0 → instancia farmacia (172.25.1.200:8082)
Aprobado por @gabfrank
```

```
✅ *Deploy completado* — central
v4.0.0 en farmacia. Health check OK (HTTP 200, 23s)
```

```
❌ *Deploy FALLIDO + rollback* — central
v4.0.0 en farmacia fallo (timeout health check)
Restaurado a v3.1.0. Revisar journalctl.
```

```
⚠️ *Filial auto-update fallo* — alpha-filial-2-linux
Intento v4.0.0 → rollback a v3.1.0
Health check failed. SSH manual requerido.
```

### Secrets nuevos (Fase 12.A)

| Scope | Secret | Valor ejemplo |
|---|---|---|
| **Org-level** | `WHATSAPP_API_URL` | `https://wa.frcsi.com.py` |
| **Org-level** | `WHATSAPP_API_KEY` | API key Evolution (64 chars) |
| **Org-level** | `WHATSAPP_INSTANCE` | `frc-cicd` |
| **Org-level** | `WHATSAPP_GROUP_ID` | `120363XXXXXXXXXX@g.us` |

### Criterio de salida Fase 12.A

- [ ] PR + release + deploy + rollback notifican en grupo correctamente en los 4 repos
- [ ] Falla del server WA NO rompe workflows caller (degradacion graciosa)
- [ ] Documentacion actualizada en `guia-desarrollo-cicd.md`
- [ ] Equipo confirma utilidad despues de 1 semana de uso

---

## Fase 12.B — Avisos institucionales SaaS frc-comercial

### Vision

Backend central envia mensajes WhatsApp a funcionarios de empresas cliente. Casos de uso iniciales:

1. **RRHH:** recordatorios turnos, recibos sueldo disponibles, comunicados, cumpleanos
2. **Operacional:** alertas stock critico, vencimientos lotes, pedidos pendientes aprobacion
3. **Flujos negocio:** transferencia recibida, pedido aprobado, factura emitida
4. **Seguridad:** codigos 2FA login, alerta acceso desde IP nueva

### Decisiones de diseno

- **Multi-instancia obligatoria:** 1 instancia Evolution **por empresa cliente** (alpha, farmacia, bodega, etc). Cada empresa con su propio numero. Razones: branding cliente, aislamiento ban, responsabilidad legal del envio.
- **Sub-instancias por categoria opcional:** ej `farmacia-rrhh` + `farmacia-operacional`. Reduce blast radius si banean por contenido.
- **Naming convention:** `{empresa}-{categoria}` (ej: `farmacia-rrhh`). Convencion replica el patron `{empresa}-filial-{numero}-{os}` ya usado.
- **Onboarding cliente:** cliente provee linea celular dedicada; admin FRC crea instancia + cliente escanea QR desde panel admin.
- **Opt-in obligatorio:** funcionario marca categorias que acepta recibir. Sin opt-in = no recibe.
- **Outbox asincrono:** envio NO bloqueante, persiste en DB con retry. Worker scheduler despacha.
- **Rate limit interno:** max N msg/min por instancia (config por empresa, default 30/min). Evita ban.

### Tareas detalladas

#### Backend central — modulo `whatsapp/` (5-7 dias, Dev Lead)

| # | Tarea | Actor | Notas |
|---|---|---|---|
| 12.B.1 | Crear paquete `com.franco.dev.service.whatsapp` + `com.franco.dev.graphql.whatsapp` + `com.franco.dev.domain.whatsapp` | Dev Lead | |
| 12.B.2 | Migracion Flyway aditiva: tablas `whatsapp_instancia`, `whatsapp_destinatario`, `whatsapp_categoria`, `whatsapp_template`, `whatsapp_outbox`, `whatsapp_envio_log` | Dev Lead | Ver schema abajo |
| 12.B.3 | `WhatsAppApiClient` (RestTemplate o WebClient) con auth header `apikey` | Dev Lead | |
| 12.B.4 | `WhatsAppService.enviar(funcionarioId, templateId, vars, categoria)` — valida opt-in, renderiza template, persiste en outbox | Dev Lead | |
| 12.B.5 | `WhatsAppOutboxScheduler` con `@Scheduled(fixedDelay=30000)`: toma N pendientes (FOR UPDATE SKIP LOCKED), respeta rate limit por instancia, despacha, actualiza estado | Dev Lead | Patron similar a `SchedulerService` existente |
| 12.B.6 | `WhatsAppTemplateService.render(templateId, Map<String,Object>)` — placeholders tipo `{{nombre}}` | Dev Lead | Plantillas con i18n por empresa |
| 12.B.7 | Resolvers GraphQL: `mutation enviarWhatsApp`, `mutation suscribirCategoria`, `mutation darOptIn`, `mutation crearInstancia`, `query estadoInstancia`, `query historialEnvios` | Dev Lead | Permisos por rol |
| 12.B.8 | Webhook receiver: `POST /webhook/whatsapp/{empresaId}` para delivery status + replies entrantes | Dev Lead | Verificar firma/api-key |
| 12.B.9 | Handler "STOP" automatico: si funcionario responde "STOP" → opt-out de todas categorias + log | Dev Lead | Compliance |
| 12.B.10 | Eventos negocio que disparan envio (acoplamiento bajo via `ApplicationEventPublisher`): `PedidoAprobadoEvent` → handler en modulo whatsapp | Dev Lead | No tocar codigo existente, solo agregar listeners |
| 12.B.11 | Cifrado api_key + numero en DB (Jasypt o columna BYTEA con AES) | Dev Lead | API keys son secretos por empresa |
| 12.B.12 | Metricas: contador envios/empresa/dia, tasa fallo, tiempo promedio entrega → expone en `/actuator/metrics` o tabla `whatsapp_metrica_diaria` | Dev Lead | |
| 12.B.13 | Endpoint admin: `mutation reconectarInstancia(empresaId)` y `query qrCode(empresaId)` | Dev Lead | Para resolver desconexiones |

#### Schema DB (referencia)

```sql
-- whatsapp_instancia: 1 por empresa (o por empresa+categoria si separan)
CREATE TABLE whatsapp_instancia (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT NOT NULL REFERENCES empresa(id),
  nombre VARCHAR(64) NOT NULL UNIQUE,  -- ej: farmacia-rrhh
  numero VARCHAR(20) NOT NULL,
  api_url TEXT NOT NULL,
  api_key_cifrada BYTEA NOT NULL,
  rate_limit_por_minuto INT DEFAULT 30,
  habilitada BOOLEAN DEFAULT FALSE,
  estado_conexion VARCHAR(20) DEFAULT 'DESCONECTADA',
  ultimo_qr_generado TIMESTAMP,
  creado_en TIMESTAMP DEFAULT NOW()
);

CREATE TABLE whatsapp_categoria (
  id BIGSERIAL PRIMARY KEY,
  codigo VARCHAR(32) UNIQUE,  -- RRHH, OPERACIONAL, FLUJO_NEGOCIO, SEGURIDAD
  descripcion TEXT,
  obligatoria BOOLEAN DEFAULT FALSE  -- ej: SEGURIDAD no se puede dar de baja
);

CREATE TABLE whatsapp_destinatario (
  id BIGSERIAL PRIMARY KEY,
  funcionario_id BIGINT NOT NULL REFERENCES funcionario(id),
  numero VARCHAR(20) NOT NULL,
  opt_in_general BOOLEAN DEFAULT FALSE,
  opt_in_fecha TIMESTAMP,
  categorias_suscritas BIGINT[] DEFAULT '{}',
  bloqueado BOOLEAN DEFAULT FALSE,  -- bloqueo manual o tras STOP
  UNIQUE(funcionario_id)
);

CREATE TABLE whatsapp_template (
  id BIGSERIAL PRIMARY KEY,
  empresa_id BIGINT REFERENCES empresa(id),  -- NULL = global FRC
  codigo VARCHAR(64) NOT NULL,  -- ej: PEDIDO_APROBADO
  categoria_id BIGINT REFERENCES whatsapp_categoria(id),
  cuerpo TEXT NOT NULL,  -- con {{placeholders}}
  activa BOOLEAN DEFAULT TRUE,
  UNIQUE(empresa_id, codigo)
);

CREATE TABLE whatsapp_outbox (
  id BIGSERIAL PRIMARY KEY,
  instancia_id BIGINT NOT NULL REFERENCES whatsapp_instancia(id),
  destinatario_id BIGINT REFERENCES whatsapp_destinatario(id),
  numero_destino VARCHAR(20) NOT NULL,
  mensaje TEXT NOT NULL,
  estado VARCHAR(20) DEFAULT 'PENDIENTE',  -- PENDIENTE, ENVIANDO, ENVIADO, FALLIDO, DESCARTADO
  intentos INT DEFAULT 0,
  proximo_intento TIMESTAMP DEFAULT NOW(),
  ultimo_error TEXT,
  external_id VARCHAR(64),  -- ID que devuelve Evolution
  creado_en TIMESTAMP DEFAULT NOW(),
  enviado_en TIMESTAMP
);

CREATE INDEX idx_outbox_pendientes ON whatsapp_outbox(estado, proximo_intento)
  WHERE estado IN ('PENDIENTE', 'FALLIDO');

CREATE TABLE whatsapp_envio_log (
  id BIGSERIAL PRIMARY KEY,
  outbox_id BIGINT REFERENCES whatsapp_outbox(id),
  evento VARCHAR(20),  -- ENVIADO, ENTREGADO, LEIDO, FALLIDO
  detalle JSONB,
  fecha TIMESTAMP DEFAULT NOW()
);
```

> Migracion: respetar [regla aditiva Flyway](#) — solo `CREATE TABLE`, sin `ALTER` destructivo. Si se necesita cambiar columna en futuro, usar estrategia 2 versiones.

#### Frontend desktop — admin RRHH (3-4 dias, Dev Lead)

| # | Tarea | Actor |
|---|---|---|
| 12.B.14 | Pantalla "WhatsApp / Configuracion instancia" — admin escanea QR (imagen base64 desde backend), ve estado conexion, boton reconectar | Dev Lead |
| 12.B.15 | Pantalla "Destinatarios" — listado funcionarios + toggle opt-in + checkboxes categorias + filtro por estado | Dev Lead |
| 12.B.16 | Pantalla "Plantillas" — CRUD con preview renderizado (vars de prueba) | Dev Lead |
| 12.B.17 | Pantalla "Envio masivo" — seleccionar funcionarios (filtros: cargo, sucursal), elegir plantilla, programar fecha/hora | Dev Lead |
| 12.B.18 | Pantalla "Logs envios" — historial con filtro por categoria/estado/fecha, grafico volumen diario | Dev Lead |
| 12.B.19 | Permisos: nuevo rol `WHATSAPP_ADMIN` (solo configuracion + envio masivo) y `WHATSAPP_VIEWER` (solo logs) | Dev Lead |

#### Frontend mobile — funcionario (1-2 dias, Dev Lead)

| # | Tarea | Actor |
|---|---|---|
| 12.B.20 | Pantalla onboarding post-login: pedir numero WA + opt-in general + checkboxes categorias | Dev Lead |
| 12.B.21 | Pantalla "Configuracion / WhatsApp": cambiar numero, dar de baja categorias, opt-out total | Dev Lead |

#### Compliance + legal (paralelo, LT + asesor legal)

| # | Tarea | Actor |
|---|---|---|
| 12.B.22 | Politica de privacidad actualizada con tratamiento de dato "numero WhatsApp" | LT + legal |
| 12.B.23 | Texto opt-in claro: que recibira, frecuencia esperada, como dar de baja, base legal | LT + legal |
| 12.B.24 | Mecanismo "STOP" probado punta a punta | Dev Lead |
| 12.B.25 | Politica retencion logs: 90 dias → purgar (`@Scheduled` mensual) | Dev Lead |
| 12.B.26 | Documento contrato/anexo cliente: quien es responsable del numero, que no se debe enviar (no spam comercial sin opt-in explicito) | LT + legal |

#### Onboarding nuevo cliente del SaaS (procedimiento)

1. Cliente provee numero celular dedicado (no personal de empleado)
2. Admin FRC ingresa a panel admin SaaS → "WhatsApp / Nueva instancia"
3. Sistema llama `POST /instance/create` a Evolution con nombre `{empresa}-rrhh`
4. UI muestra QR + cliente escanea desde telefono con la linea provista
5. Sistema marca `habilitada=true` cuando webhook reporta `state=open`
6. Admin crea categorias activas + plantillas iniciales
7. Funcionarios reciben prompt de opt-in en proximo login mobile/desktop
8. Sistema empieza a despachar segun opt-ins

#### Validacion (1 semana piloto, QA + LT)

| # | Tarea | Actor |
|---|---|---|
| 12.B.27 | Setup empresa piloto (alpha) con instancia `alpha-rrhh` | LT |
| 12.B.28 | Onboarding 5-10 funcionarios voluntarios | QA |
| 12.B.29 | Disparar evento real (ej: pedido aprobado) → verificar entrega | QA |
| 12.B.30 | Probar STOP desde funcionario → verificar opt-out automatico | QA |
| 12.B.31 | Probar caida instancia (apagar telefono cliente) → verificar reintentos + alerta admin | QA |
| 12.B.32 | Medir rate limit: enviar 100 msg seguidos → verificar throttling correcto | QA |
| 12.B.33 | Cargar 1000 envios en outbox → verificar throughput scheduler | Dev Lead |

### Riesgos + mitigaciones

| Riesgo | Mitigacion |
|---|---|
| Ban numero por volumen | Rate limit interno + warmup gradual (primeras 2 semanas <50 msg/dia/numero, escalar lento) |
| Ban por contenido (spam) | Templates revisados, opt-in obligatorio, prohibido marketing externo |
| Numero cliente cae (sin bateria, sin chip) | Health check periodico (cada 5 min) + alerta a admin via Fase 12.A |
| Evolution API cae | Outbox persiste, retry exponencial (1min, 5min, 30min, 2h, descartar) |
| Cambio protocolo WhatsApp Web (Meta puede romper Baileys) | Plan B: migrar instancia a engine Cloud API oficial dentro de Evolution (cambio de config, modelo HTTP casi igual) |
| Cliente borra app/sesion del telefono | UI admin muestra estado conexion, boton "Generar nuevo QR" reescanea |
| Funcionario reporta privacidad | Opt-in granular + politica clara + STOP funcional desde dia 1 |
| Costo escalando a N clientes | Cada cliente trae su numero (costo de linea es del cliente). Server escala vertical hasta ~50 instancias en VPS modesto. |

### Decision: cuando migrar a Meta Cloud API oficial

Reevaluar al llegar a alguno de:
- 10+ clientes activos en produccion
- 5000+ msg/mes total agregado
- Primer ban de numero (incidente real)
- Cliente exige soporte oficial Meta para compliance corporativo

Migracion estimada: 1-2 semanas (cambio de cliente HTTP en `WhatsAppApiClient`, alta de cuenta Meta Business + verificacion empresa, mismo modelo de templates).

### Criterio de salida Fase 12.B

- [ ] Instancia piloto (alpha) operativa con 5-10 funcionarios opt-in
- [ ] Al menos 3 categorias activas con plantillas funcionando
- [ ] Mecanismo STOP probado y funcional
- [ ] Rate limit + retry validados bajo carga
- [ ] Politica privacidad + texto opt-in aprobados por legal
- [ ] Procedimiento onboarding nuevo cliente documentado y probado

---

## Reglas del equipo (documentar y comunicar)

1. **Conventional Commits obligatorio.** Sin `feat:`, `fix:`, etc. semantic-release no genera version.
2. **Migraciones de Flyway siempre aditivas (retrocompatibles).** El rollback de codigo NO revierte la DB. **PROHIBIDO eliminar o renombrar columnas/tablas directamente.** Las migraciones solo deben agregar cosas nuevas. Si se necesita eliminar un campo: primero dejar de usarlo en la version N, y recien en la version N+1 (cuando se confirma estabilidad) hacer el DROP. Si una migracion rompe el JAR anterior, el rollback tambien falla y el sistema queda inoperativo.
3. **Deploy a produccion siempre manual.** Se elige version explicita y se requiere aprobacion.
4. **Release ≠ Deploy.** Un merge a `develop` crea un release alpha automaticamente. Pero un deploy a un servidor es una accion separada y manual. No confundir.
5. **No hacer force push a `main` o `develop`.** Branch protection lo previene.
6. **Reviews obligatorios en PRs.** Minimo 1 reviewer para merge.
7. **Changelogs viven en GitHub Releases.** Al no usar `@semantic-release/git`, el `CHANGELOG.md` local del repo no se actualiza automaticamente. El historial de cambios de cada version esta en la pestana "Releases" de GitHub, no en un archivo local.

---

## Checklist de validacion final

Al terminar las 2 semanas, verificar que se cumplen los criterios de exito:

- [x] Un merge a `develop` genera release alpha en backend central (**Validado**)
- [x] Un merge a `develop` genera release alpha en backend filial (**Validado**)
- [x] Un merge a `develop` genera release alpha en desktop (**Validado**)
- [x] Un merge a `develop` genera release alpha en mobile (**Validado 2026-04-06**)
- [ ] Un merge a `main` genera release de produccion (pendiente validar en los 4 repos)
- [ ] Deploy a produccion del backend central requiere aprobacion y funciona con rollback
- [ ] La filial piloto (Linux) se actualiza sola dentro de 15 minutos
- [ ] La filial piloto (Windows) se actualiza sola dentro de 15 minutos
- [x] La app desktop detecta y descarga actualizaciones (**Validado 2026-04-06**, alpha.13→alpha.20, Windows + Linux)
- [ ] La app mobile se puede subir a Play Store con 2 clicks (falta: `GOOGLE_PLAY_SERVICE_ACCOUNT` + probar deploy)
- [ ] Al menos 2 personas del equipo pueden operar el sistema completo

### Checklist Fase 12 (post-impl, opcional pero planificada)

**Fase 12.A — WhatsApp CI/CD:**
- [ ] VPS WA + Evolution API levantado con SSL
- [ ] Numero FRC dedicado vinculado, instancia `frc-cicd` activa
- [ ] Grupo "FRC CI/CD Alerts" creado con miembros equipo
- [ ] Reusable workflow `notify-whatsapp.yml` integrado en los 4 repos
- [ ] PR + release + deploy + rollback notifican correctamente
- [ ] Falla del server WA NO rompe workflows caller

**Fase 12.B — WhatsApp SaaS:**
- [ ] Modulo `whatsapp/` en backend central (servicio + scheduler + outbox)
- [ ] Migracion Flyway aditiva con tablas WA aplicada
- [ ] UI admin desktop (instancias, destinatarios, plantillas, envio masivo, logs)
- [ ] UI mobile funcionario (opt-in, configuracion)
- [ ] Politica privacidad + texto opt-in aprobados por legal
- [ ] Mecanismo STOP probado
- [ ] Empresa piloto con funcionarios reales recibiendo avisos

---

## Contacto y soporte

Si algo falla durante la implementacion:
- **GitHub Actions logs:** Tab "Actions" en cada repo → click en el workflow → ver logs
- **Deploy logs:** SSH al servidor → `journalctl -u frc-central-server -f`
- **Filial logs (Linux):** `/var/log/frc-update.log`
- **Filial logs (Windows):** Ver historial en Task Scheduler o agregar redirect en el script
- **Semantic-release debug:** Agregar `DEBUG=semantic-release:*` a las variables de entorno del step

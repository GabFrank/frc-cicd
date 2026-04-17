# Runbook — Migración Filial Windows a canal beta

**Estado:** v2 — completado para setup desde cero, basado en piloto alpha (`172.25.0.3`) y análisis de filial producción (`172.25.3.2`).

**Última actualización:** 2026-04-17

**Runbooks relacionados:**
- [runbook-migracion-central-beta.md](runbook-migracion-central-beta.md) — servidor central (ejecutar primero)
- [runbook-migracion-filial-linux-beta.md](runbook-migracion-filial-linux-beta.md) — filial Linux

---

## Contexto

Este runbook cubre la migración de una **filial Windows** desde estructura legacy al canal **beta** del pipeline CI/CD. Las filiales Windows reciben auto-updates cada 15 minutos vía Task Scheduler + `check-update.ps1`.

Las filiales Windows de producción **no tienen ninguna implementación CI/CD previa** — todo se configura desde cero. Este runbook asume eso.

**Piloto alpha:** `172.25.0.3` (DESKTOP-MNBIF0R, Windows 11, PG 16 como servicio `postgresql-alpha` puerto 5552, DB `general`, Java 17 Temurin, canal `alpha`)
**Filial producción conocida:** `172.25.3.2` (SUC-GASUR, Windows 10 Pro, PG 16 en Docker puerto 5551, DB `general`, Java 8 legacy, WinSW service `frc-server`)

**Prerrequisito:** el central ya debe estar migrado y desplegando versiones beta (ver [runbook central](runbook-migracion-central-beta.md)).

---

## Diferencias clave vs filial Linux

| Aspecto | Linux | Windows |
|---|---|---|
| Auto-update | cron + `check-update.sh` + `flock` | Task Scheduler + `run-update.bat` + `check-update.ps1` |
| Arranque servicio | systemd (`frc-filial.service`) | Task Scheduler (`FRC-Filial-Server`) + `start-filial.ps1` |
| Lock concurrencia | `flock -n /tmp/...` (kernel lock) | No hay `flock` nativo — Task Scheduler + intervalo previene solapamiento en la práctica |
| Paths | `/opt/frc-filial/` | `C:\frc-filial\` |
| Symlinks | `ln -s` (symlink POSIX) | `mklink /J` (junction NTFS, **no requiere admin**) |
| Permisos | `chmod`, `chown`, sudoers NOPASSWD | No necesario — Task Scheduler corre como el usuario `franco` con permisos directos |
| `.env` parsing | `EnvironmentFile=` en systemd (nativo) | `check-update.ps1` / `start-filial.ps1` parsean `.env` y construyen flags `-D` |
| PostgreSQL | systemd service | Servicio Windows nativo, Docker container, o PG portable |
| Restart mecanismo | `sudo systemctl restart` | `check-update.ps1` mata `java.exe` y relanza con `Start-Process` |
| Logs | journalctl + archivo | Archivos: `logs/update.log`, `logs/app.log`, `logs/app-error.log` |
| jq requerido | Sí (parseo JSON en bash) | **No** — PowerShell usa `Invoke-RestMethod` nativo |
| SSH acceso remoto | sshpass + ssh | sshpass + ssh (requiere OpenSSH Server habilitado) |

---

## Variantes de PostgreSQL en Windows

Las filiales Windows pueden tener PostgreSQL instalado de 3 formas distintas. **Identificar cuál aplica ANTES de empezar:**

### Variante A: Servicio Windows nativo

```powershell
# Detectar: nombre del servicio contiene "postgresql"
sc query type= service state= all | findstr /i postgres
# Ejemplo: postgresql-x64-16, postgresql-alpha

# Puerto
netstat -an | findstr "5432 5551 5552"

# psql está en PATH o en C:\Program Files\PostgreSQL\{version}\bin\
where psql
```

**Comandos PG:** usar `psql` directo (agregar al PATH si no está).

### Variante B: PostgreSQL en Docker

```powershell
# Detectar: contenedor postgres corriendo
docker ps | findstr postgres

# Puerto mapeado (host → container)
docker port postgres
# Ejemplo: 5432/tcp -> 0.0.0.0:5551

# psql via docker exec
docker exec -it postgres psql -U postgres -d general
```

**Comandos PG:** prefixar todo con `docker exec postgres` o `docker exec -it postgres`.

**Gotcha Docker crítico:** Docker Desktop en Windows corre como app de escritorio (tray). Si la máquina reinicia y no hay auto-login configurado, Docker no arranca y la filial queda sin DB. Verificar:
```powershell
# ¿Docker es un servicio que arranca automático?
sc query com.docker.service
# ¿Hay auto-login? (registro de Windows)
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon
```

### Variante C: PG portable (sin servicio, sin Docker)

```powershell
# Detectar: buscar binarios PG sueltos
dir C:\postgres* /b /s 2>nul | findstr pg_ctl
dir C:\pgsql* /b /s 2>nul | findstr pg_ctl

# Puerto: ver netstat
netstat -an | findstr "5432 5551 5552"
```

**Comandos PG:** usar path absoluto, ej: `C:\postgres-alpha\pgsql\bin\psql.exe`.

**Gotcha portable:** PG portable generalmente se arranca con una task del Task Scheduler o un `.bat` en el Startup folder. Si se apaga esa task, PG no arranca y la filial queda sin DB.

---

## Phase 0 — Prerequisitos

### Software requerido

```powershell
# === Java 17+ (requerido por versiones beta del JAR) ===
java -version
# Si Java 8 o no instalado:
#   Opción 1: winget install EclipseAdoptium.Temurin.17.JDK
#   Opción 2: descargar de https://adoptium.net/
#   IMPORTANTE: si Java 8 se necesita para otras apps, instalar Java 17 SIN
#   eliminar Java 8 y usar path absoluto en start-filial.ps1

# Verificar path de Java 17 (si hay múltiples versiones)
where java
# Si retorna Java 8, buscar Java 17:
dir "C:\Program Files\Eclipse Adoptium\*\bin\java.exe"
dir "C:\Program Files\Java\*17*\bin\java.exe"

# === jq NO es necesario === (check-update.ps1 usa Invoke-RestMethod nativo)

# === OpenSSH Server (para acceso remoto) ===
sc query sshd
# Si no está: Settings → Apps → Optional Features → OpenSSH Server → Install
# Habilitar: sc config sshd start= auto && net start sshd
```

### Java 17 — decisión de path

Si la filial tiene Java 8 instalado globalmente (en PATH) Y otras aplicaciones lo usan:

**No cambiar el PATH global.** En su lugar, configurar la variable `$JAVA_EXE` en `check-update.ps1` y el path en `start-filial.ps1` para apuntar al Java 17 explícitamente:

```powershell
# En check-update.ps1, línea ~20:
$JAVA_EXE = "C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot\bin\java.exe"

# En start-filial.ps1, línea ~17:
Start-Process -FilePath "C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot\bin\java.exe" ...
```

### PostgreSQL — verificar conectividad

```powershell
# Ajustar según variante (A/B/C arriba)

# Variante A (servicio nativo):
psql -U postgres -d general -c "SELECT 1;"

# Variante B (Docker):
docker exec postgres psql -U postgres -d general -c "SELECT 1;"

# Variante C (portable):
C:\postgres-alpha\pgsql\bin\psql.exe -h localhost -p 5552 -U postgres -d general -c "SELECT 1;"
```

### Backup de DB (obligatorio)

```powershell
# Variante A:
pg_dumpall -U postgres > C:\Users\franco\backups\backup-filial-windows-prod.sql

# Variante B (Docker):
docker exec postgres pg_dumpall -U postgres > C:\Users\franco\backups\backup-filial-windows-prod.sql

# Variante C (portable):
C:\postgres-alpha\pgsql\bin\pg_dumpall.exe -h localhost -p 5552 -U postgres > C:\Users\franco\backups\backup-filial-windows-prod.sql

# Verificar tamaño (debe ser > 0)
dir C:\Users\franco\backups\backup-filial-windows-prod.sql
```

### PostgreSQL — replicación lógica (obligatorio)

Para que el central pueda crear subscripciones a la filial:

```powershell
# 1. wal_level = logical (requiere restart PG)
# Variante A (servicio nativo):
#   Editar postgresql.conf: wal_level = logical
#   Restart servicio PG

# 2. listen_addresses = '*' (requiere restart PG)
#   Editar postgresql.conf: listen_addresses = '*'

# 3. pg_hba.conf — acceso remoto a la filial PG
#   Agregar en pg_hba.conf:
#     host    all             all             172.25.0.0/16           trust
#     host    replication     all             172.25.0.0/16           md5
#   Reload (no restart): pg_reload_conf() o sc restart

# 4. Password del user franco en PG (requerido para md5 en replication)
# Variante A:
psql -U postgres -d general -c "ALTER USER franco WITH PASSWORD '$DB_PASSWORD';"

# 5. Firewall: abrir puerto PG para acceso entrante
# Variante A (servicio nativo, puerto 5552):
powershell -Command "New-NetFirewallRule -DisplayName 'PostgreSQL 5552' -Direction Inbound -Protocol TCP -LocalPort 5552 -Action Allow -Profile Any"
```

### franco SUPERUSER — obligatorio para `setupFullReplication`

`setupFullReplication` (la mutación GraphQL que configura replicación desde el desktop) ejecuta `CREATE SUBSCRIPTION` como el usuario `franco` de la aplicación. PostgreSQL requiere `SUPERUSER` para esto cuando el servidor remoto tiene `trust` en `pg_hba.conf` para la subnet — el pg_hba `host all all 172.25.0.0/16 trust` hace que PG considere la conexión insegura y rechace la creación de subscripciones para non-superusers (incluso con el rol `pg_create_subscription` en PG 16).

> **¿Por qué no alcanza `pg_create_subscription`?**
> La replicación lógica usa `replication=database` para las conexiones de suscripción, que coincide con la regla `host all all 172.25.0.0/16 trust` (no con `host replication ...`). Si esa regla es `trust`, el servidor no pide password → PG rechaza la sub para non-superuser como medida de seguridad.

```powershell
# En el PG de la filial (como postgres — Variante A):
psql -U postgres -d general -c "ALTER USER franco WITH SUPERUSER;"

# Verificar:
psql -U postgres -d general -c "SELECT rolname, rolsuper FROM pg_roles WHERE rolname = 'franco';"
# Debe mostrar: franco | t
```

```bash
# En el PG central (desde el servidor central, como postgres):
psql -U postgres -h localhost -p 5552 -d beta -c "ALTER USER franco WITH SUPERUSER;"
```

> **Alternativa sin SUPERUSER:** cambiar `trust` → `md5` en la regla `host all all 172.25.0.0/16` de `pg_hba.conf` de la filial. Con md5, el servidor siempre pide password → `pg_create_subscription` alcanza. Pero `trust` se usa para conectividad de administración, así que el tradeoff es intencional.

### Limpieza de slots huérfanos antes de setupFullReplication

> **Desde versión `4.2.0-beta.3`, `setupFullReplication` limpia automáticamente** slots huérfanos, suscripciones y publicaciones como Paso 0 (llama `removeFullReplication` internamente). La limpieza manual descrita abajo solo es necesaria si se está usando una versión anterior.

Si en algún momento se hizo `DROP SUBSCRIPTION ... SET (slot_name = NONE)`, el replication slot queda en el publisher como huérfano. En versiones anteriores, `setupFullReplication` falla con:
```
ERROR: could not create replication slot "beta_filialX_sub": replication slot "beta_filialX_sub" already exists
```

**Limpieza manual (solo versiones < 4.2.0-beta.3):**

```bash
# Verificar slots en la filial (publisher de beta_filialX_sub):
psql -U postgres -h IP_FILIAL -p PUERTO_FILIAL -d general \
  -c "SELECT slot_name, active FROM pg_replication_slots;"

# Si aparece "beta_filialX_sub" con active = f → huérfano, dropear:
psql -U postgres -h IP_FILIAL -p PUERTO_FILIAL -d general \
  -c "SELECT pg_drop_replication_slot('beta_filialX_sub');"

# Verificar slots en central (publisher de central_pub → origen de beta_filialX_central_sub):
psql -U postgres -h localhost -p 5552 -d beta \
  -c "SELECT slot_name, active FROM pg_replication_slots WHERE slot_name LIKE '%filialX%';"

# Si aparece huérfano en central → dropear:
psql -U postgres -h localhost -p 5552 -d beta \
  -c "SELECT pg_drop_replication_slot('beta_filialX_central_sub');"
```

> ⚠️ Solo dropear slots con `active = f`. Un slot activo tiene un worker consumiendo de él — dropearlo causaría pérdida de datos.

### Permiso `pg_subscription`

```powershell
# Variante A:
psql -U postgres -d general -c "GRANT SELECT ON pg_catalog.pg_subscription TO franco;"

# Variante B (Docker):
docker exec postgres psql -U postgres -d general -c "GRANT SELECT ON pg_catalog.pg_subscription TO franco;"

# Variante C (portable):
C:\postgres-alpha\pgsql\bin\psql.exe -h localhost -p 5552 -U postgres -d general -c "GRANT SELECT ON pg_catalog.pg_subscription TO franco;"

# Verificación (ajustar comando según variante):
# Debe retornar filas o conjunto vacío, NO "permission denied"
```

**Nota:** el GRANT es a nivel cluster. Si se recrea el cluster/container, hay que reaplicar.

### Replicación lógica

Las filiales de producción **ya tienen publicaciones y suscripciones funcionando** con nomenclatura antigua. **No tocar la replicación existente.**

```powershell
# Verificar estado (ajustar psql según variante):
psql -U franco -d general -c "SELECT pubname FROM pg_publication;"
psql -U franco -d general -c "SELECT subname, received_lsn, latest_end_time FROM pg_stat_subscription;"
# Ambas deben existir y estar streaming. Si algo está roto, fix ANTES de continuar.
```

---

## Pre-checklist

- [ ] **Central ya migrado** y desplegando versiones beta
- [ ] **Java 17+** instalado y path anotado (si no es el default en PATH)
- [ ] **Variante PostgreSQL identificada** (servicio nativo / Docker / portable) y puerto anotado
- [ ] **Backup DB** realizado y verificado (tamaño > 0)
- [ ] **GRANT pg_subscription** aplicado y verificado
- [ ] **franco SUPERUSER** en PG de la filial: `ALTER USER franco WITH SUPERUSER;` (requerido para `setupFullReplication`)
- [ ] **Slots huérfanos verificados** — `SELECT slot_name, active FROM pg_replication_slots;` en filial y central; dropear cualquier slot con `active = f` que coincida con `filialX`
- [ ] **Replicación funcionando** — publicaciones y suscripciones streaming
- [ ] **Backup snapshot legacy** — copiar `C:\FRC\` completo a `C:\Users\franco\backups\`
- [ ] **Snapshot Task Scheduler** — `schtasks /query /fo LIST > C:\Users\franco\backups\tasks-pre-migration.txt`
- [ ] **Snapshot servicios** — `sc query type= service state= all | findstr /i frc > C:\Users\franco\backups\services-pre-migration.txt`
- [ ] **Buscar paths legacy** — `where /r C:\ frc-server.jar 2>nul` (puede tardar; alternativa: `dir C:\FRC\frc-server\ /b`)
- [ ] **Token GitHub** — PAT clásico con scopes `repo` + `read:packages` (el mismo que usa el central sirve)
- [ ] **Acceso SSH** funcionando desde máquina del operador
- [ ] **`.env` preparado** (ver sección "Archivo `.env`" abajo)
- [ ] **PowerShell execution policy** verificada (no necesita cambiar — `run-update.bat` usa `-ExecutionPolicy Bypass`)
- [ ] **Si Docker:** verificar que Docker arranca automático al reiniciar

---

## Archivo `.env` — referencia completa

El `.env` contiene las variables que `check-update.ps1` y `start-filial.ps1` convierten a flags `-D` de Spring Boot. Cada `KEY=VALUE` se transforma en `-Dkey.converted=value` (lowercase, `_` → `.`).

### Template

```env
# === Conexión a base de datos ===
SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:PUERTO_PG/general
SPRING_DATASOURCE_USERNAME=franco
SPRING_DATASOURCE_PASSWORD=$DB_PASSWORD

# === Servidor ===
SERVER_PORT=8080
SERVER_ADDRESS=0.0.0.0

# === Perfil ===
SPRING_PROFILES_ACTIVE=prod

# === Paths (apuntar al directorio CI/CD, usar backslash o forward slash) ===
USER_HOME=C:\frc-filial
HOMEPATH=C:\frc-filial

# === Identidad de la filial ===
SUCURSALID=NUMERO_SUCURSAL
IPSERVIDORCENTRAL=IP_CENTRAL:PUERTO_CENTRAL

# === Facturación ===
FACTURACOUNTDOWN=2

# === Backup de DB ===
BACKUP_ENABLED=false
# Si se quiere habilitar backup automático:
# BACKUP_ENABLED=true
# BACKUP_LOCAL_PATH=C:\frc-filial\backup\postgres\
# BACKUP_GOOGLE_DRIVE_FOLDER_ID=<id del folder en Google Drive>
# BACKUP_GOOGLE_DRIVE_CLIENT_ID=<client id>
# BACKUP_GOOGLE_DRIVE_CLIENT_SECRET=<client secret>
# BACKUP_MAX_FILES=5
# BACKUP_BACKUP_HOUR=9
```

### Variables que hay que personalizar por filial

| Variable | De dónde sacar el valor | Ejemplo producción (172.25.3.2) |
|---|---|---|
| `SPRING_DATASOURCE_URL` | Puerto PG de la filial | `jdbc:postgresql://localhost:5551/general` |
| `SERVER_PORT` | `application.properties` → `server.port` | `8082` |
| `SUCURSALID` | `application.properties` → `sucursalId` | `2` |
| `IPSERVIDORCENTRAL` | `application.properties` → `ipServidorCentral` | `$CENTRAL_PUBLIC_IP:8082` — **para beta piloto usar `172.25.1.200:8084`** (ver mapa de puertos en [runbook central](runbook-migracion-central-beta.md#mapa-de-puertos--instancias-central-17225120)) |
| `BACKUP_*` | `application.properties` → `backup.*` | Copiar si backup habilitado |

### Cómo migrar desde `application.properties` legacy

```powershell
# Ver el application.properties actual
type C:\FRC\frc-server\application.properties

# Mapeo de nombres:
#   application.properties          →  .env
#   spring.datasource.url=...       →  SPRING_DATASOURCE_URL=...
#   sucursalId = 2                  →  SUCURSALID=2
#   ipServidorCentral=IP:PORT       →  IPSERVIDORCENTRAL=IP:PORT  (sin el prefijo "ipServidorCentral:")
#   server.port=8082                →  SERVER_PORT=8082
#   backup.enabled=true             →  BACKUP_ENABLED=true
#   backup.local-path=...           →  BACKUP_LOCAL_PATH=...
#   backup.google-drive.folder-id=  →  BACKUP_GOOGLE_DRIVE_FOLDER_ID=...
#   server.address:0.0.0.0          →  SERVER_ADDRESS=0.0.0.0
#   user.home=C:\FRC                →  USER_HOME=C:\frc-filial  (CAMBIAR a path nuevo)
#   homepath=C:\FRC                 →  HOMEPATH=C:\frc-filial   (CAMBIAR a path nuevo)

# IMPORTANTE: no dejar espacios alrededor del "=" en el .env
# IMPORTANTE: no usar comillas alrededor de los valores
# IMPORTANTE: cambiar USER_HOME y HOMEPATH a C:\frc-filial (no dejar C:\FRC)
# IMPORTANTE: no dejar líneas vacías ni comentarios que no empiecen con #
```

### Gotchas de encoding

**PowerShell por defecto escribe UTF-16 LE con BOM.** Esto rompe el parsing de `.env`, `.channel`, `.current-version`, etc.

```powershell
# ❌ MAL — agrega BOM
"beta" | Out-File C:\frc-filial\.channel

# ✅ BIEN — ASCII sin BOM
"beta" | Out-File -Encoding ASCII -NoNewline C:\frc-filial\.channel

# ✅ ALTERNATIVA — .NET directo, garantiza UTF-8 sin BOM
[System.IO.File]::WriteAllText("C:\frc-filial\.channel", "beta")
[System.IO.File]::WriteAllText("C:\frc-filial\.current-version", "3.0.9")
```

---

## Scripts — referencia

Los 4 scripts se copian desde `cicd-implementation/scripts/`. Ubicación destino: `C:\frc-filial\`.

### `check-update.ps1` — auto-update principal

El script que ejecuta Task Scheduler cada 15 minutos. Flujo:
1. Lee `.channel`, `.github-token`, `.current-version`
2. Consulta GitHub API (`Invoke-RestMethod`, no necesita `jq`)
3. Si hay versión nueva → descarga `frc-filial-server.jar` a `releases\{version}\`
4. Recrea junction `current` → nueva versión (`mklink /J`, no requiere admin)
5. Mata proceso `java.exe` existente → relanza con flags `-D` desde `.env`
6. Health check `http://localhost:{PORT}/actuator/health` (acepta 200 o 503)
7. Si pasa → notifica GitHub Deployments API (success)
8. Si falla → rollback a versión anterior, notifica failure

**Variables a personalizar (al inicio del archivo):**

| Variable | Valor por defecto | Cuándo cambiar |
|---|---|---|
| `$BASE_DIR` | `C:\frc-filial` | Nunca (path estándar) |
| `$JAR_NAME` | `frc-filial-server.jar` | Nunca |
| `$SERVICE_NAME` | `frc-filial` | No usado actualmente (el script mata java.exe directo) |
| `$REPO` | `GabFrank/franco-system-backend-filial` | Nunca |
| `$JAVA_EXE` | `java` | **Cambiar si Java 17 no es el default en PATH** (ver Phase 0) |
| `$HEALTH_TIMEOUT` | `120` | Incrementar si Spring Boot tarda más de 2 min en arrancar |

### `start-filial.ps1` — arranque del servidor (recomendado)

Script PowerShell que lee `.env`, convierte las variables a flags `-D`, y lanza `java.exe`. **Usar este en vez de `start-filial.bat`** — el `.bat` tiene un bug en la función `toLower` que no funciona en CMD.

### `start-filial.bat` — arranque alternativo (tiene bug)

Versión batch del arranque. La subrutina `:toLower` es un no-op en CMD — las keys quedan en UPPERCASE (`-DSPRING.DATASOURCE.URL=...`). Spring Boot acepta esto por relaxed binding, pero **no es confiable para todas las properties**. Preferir el `.ps1`.

### `run-update.bat` — wrapper para Task Scheduler

Task Scheduler no ejecuta PowerShell scripts directamente de forma confiable. Este `.bat` es el wrapper:

```bat
@echo off
cd /d C:\frc-filial
powershell.exe -ExecutionPolicy Bypass -File "C:\frc-filial\check-update.ps1" >> "C:\frc-filial\logs\check-update.log" 2>&1
```

**El `-ExecutionPolicy Bypass` es obligatorio** — la execution policy por defecto en Windows es `Restricted`.

---

## Decisión: servicio legacy (WinSW) vs Task Scheduler

Las filiales Windows de producción usan **WinSW** como wrapper de servicio Windows (`frc-server` service). El piloto alpha usa **Task Scheduler**.

### Problema con WinSW + `check-update.ps1`

`check-update.ps1` mata el proceso `java.exe` directamente y lo relanza con `Start-Process`. Si WinSW está manejando el proceso:
1. WinSW detecta que el proceso murió → intenta reiniciar con config vieja
2. `check-update.ps1` lanza otro proceso java con la versión nueva
3. **Dos instancias de java compitiendo por el mismo puerto** → error

### Opciones

| Opción | Pro | Contra |
|---|---|---|
| **A: Migrar a Task Scheduler** (como piloto) | `check-update.ps1` funciona sin cambios. Consistente con el piloto. | Hay que eliminar servicio WinSW y crear 2 tasks nuevas. |
| **B: Mantener WinSW + modificar script** | Menos cambios en el arranque. WinSW auto-restart si Java crashea. | Requiere modificar `check-update.ps1` para usar `net stop`/`net start`. Script diverge del piloto. |

### Recomendación: **Opción A — Task Scheduler**

Consistente con el piloto, no requiere modificar scripts, y el auto-restart de WinSW es innecesario porque `check-update.ps1` ya tiene retry y rollback incorporados.

---

## Phase D — Restructurar filial a layout CI/CD

### Pasos

```powershell
# En la filial Windows, como usuario franco (con permisos de admin si es necesario)
# Si accediendo por SSH: ssh franco@172.25.3.X

# ──────────────────────────────────────────────────────────
# PASO 0: Verificaciones previas (no toca nada, solo lee)
# ──────────────────────────────────────────────────────────

# Identificar el servicio/task actual
sc query frc-server                                    # Si usa WinSW
schtasks /query /fo LIST | findstr /i frc              # Si usa Task Scheduler
tasklist | findstr /i java                             # Ver proceso Java corriendo

# Ver application.properties legacy
type C:\FRC\frc-server\application.properties

# Ver paths legacy referenciados
dir C:\FRC\frc-server\ /b

# Ver qué scheduled tasks existen
schtasks /query /fo LIST /v > C:\Users\franco\backups\tasks-pre-migration.txt

# ──────────────────────────────────────────────────────────
# PASO 1: Crear estructura + configs ANTES de parar (minimiza downtime)
# ──────────────────────────────────────────────────────────

# Crear directorios
mkdir C:\frc-filial\releases\3.0.9
mkdir C:\frc-filial\logs

# Crear .env (ver sección "Archivo .env" arriba)
# USAR NOTEPAD o [System.IO.File]::WriteAllText para evitar BOM
notepad C:\frc-filial\.env
# ⚠️ EDITAR: SUCURSALID, IPSERVIDORCENTRAL, SPRING_DATASOURCE_URL (puerto PG), SERVER_PORT, backup vars

# Crear archivos CI/CD (sin BOM)
powershell -Command "[System.IO.File]::WriteAllText('C:\frc-filial\.channel', 'beta')"
powershell -Command "[System.IO.File]::WriteAllText('C:\frc-filial\.current-version', '3.0.9')"
powershell -Command "[System.IO.File]::WriteAllText('C:\frc-filial\.filial-id', 'farmacia-filial-X-windows')"
# ⚠️ EDITAR: .filial-id con identificador real (ej: farmacia-filial-2-windows)

# Crear .github-token con el PAT
powershell -Command "[System.IO.File]::WriteAllText('C:\frc-filial\.github-token', 'ghp_XXXXX')"

# Copiar scripts desde cicd-implementation/scripts/
# (transferir via SCP o copiar manualmente)
# Destino: C:\frc-filial\check-update.ps1
# Destino: C:\frc-filial\start-filial.ps1
# Destino: C:\frc-filial\start-filial.bat
# Destino: C:\frc-filial\run-update.bat

# ⚠️ Si Java 17 no está en PATH, editar $JAVA_EXE en check-update.ps1 y start-filial.ps1:
#   $JAVA_EXE = "C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot\bin\java.exe"

# Crear run-update.bat si no se copió:
powershell -Command "[System.IO.File]::WriteAllText('C:\frc-filial\run-update.bat', '@echo off`r`ncd /d C:\frc-filial`r`npowershell.exe -ExecutionPolicy Bypass -File ""C:\frc-filial\check-update.ps1"" >> ""C:\frc-filial\logs\check-update.log"" 2>&1`r`n')"

# ──────────────────────────────────────────────────────────
# PASO 2: Parar servicio/task existente (downtime empieza)
# ──────────────────────────────────────────────────────────

# Si usa WinSW (servicio Windows):
net stop frc-server

# Si usa Task Scheduler:
schtasks /End /TN "FRC-Filial-Server"

# Si es proceso java suelto:
taskkill /f /im java.exe
# ⚠️ Solo si no hay otros procesos Java en la máquina

# ──────────────────────────────────────────────────────────
# PASO 3: Copiar JAR + crear junction
# ──────────────────────────────────────────────────────────

# Copiar JAR con nombre CI/CD
copy C:\FRC\frc-server\frc-server.jar C:\frc-filial\releases\3.0.9\frc-filial-server.jar

# Crear junction (NO symlink — junction no requiere admin)
mklink /J C:\frc-filial\current C:\frc-filial\releases\3.0.9

# Verificar junction
dir C:\frc-filial\current\

# ──────────────────────────────────────────────────────────
# PASO 4: Desactivar servicio legacy + crear Task Scheduler tasks
# ──────────────────────────────────────────────────────────

# Si había WinSW service, desactivar (no eliminar aún):
sc config frc-server start= disabled

# Crear task de arranque al inicio del sistema
# (usa start-filial.ps1 via un .bat wrapper)
powershell -Command "[System.IO.File]::WriteAllText('C:\frc-filial\start-server.bat', '@echo off`r`ncd /d C:\frc-filial`r`npowershell.exe -ExecutionPolicy Bypass -File ""C:\frc-filial\start-filial.ps1"" >> ""C:\frc-filial\logs\start.log"" 2>&1`r`n')"

schtasks /Create /TN "FRC-Filial-Server" /TR "C:\frc-filial\start-server.bat" /SC ONSTART /RU franco /RP <password> /F

# Iniciar el servidor ahora
C:\frc-filial\start-server.bat
# ← downtime fin

# ──────────────────────────────────────────────────────────
# PASO 5: Verificar que arrancó
# ──────────────────────────────────────────────────────────

# Esperar ~30-60 segundos para que Spring Boot arranque
timeout /t 60

# Health check (usar SERVER_PORT del .env)
powershell -Command "(Invoke-WebRequest -Uri http://localhost:8082/actuator/health -UseBasicParsing).StatusCode"
# Debe retornar 200 o 503 (503 es un bug viejo de 3.0.9, aceptable)

# Verificar proceso Java corriendo
tasklist | findstr java

# Verificar junction
dir C:\frc-filial\current\
type C:\frc-filial\.current-version
```

### Rollback

```powershell
# Matar proceso Java nuevo
taskkill /f /im java.exe

# Re-habilitar servicio legacy
sc config frc-server start= auto
net start frc-server
# JAR original sigue en C:\FRC\frc-server\
```

---

## Phase E — Permisos

En Windows **no hay equivalente a sudoers**. `check-update.ps1` no necesita `sudo` — mata el proceso java directamente y relanza con `Start-Process`, ambas operaciones permitidas para el usuario `franco`.

### Verificar que `franco` puede:

```powershell
# 1. Matar proceso java (suyo propio — no necesita admin)
tasklist /fi "username eq franco" | findstr java
# Si el proceso Java corre como franco → OK

# 2. Crear junctions en C:\frc-filial\ (es owner → OK)

# 3. Escribir en C:\frc-filial\ (es owner → OK)

# 4. Ejecutar PowerShell (Bypass vía .bat → OK)
```

### Caso especial: Java corre como SYSTEM o como otro usuario

Si el proceso legacy corre como `SYSTEM` (ej: WinSW con `LocalSystem`), y el Task Scheduler corre como `franco`, el script **no puede matar el proceso**. Opciones:
1. **Cambiar la task `FRC-Filial-Server` para correr como `SYSTEM`** — pero complica los permisos de archivos
2. **Asegurarse de que Java corre como `franco`** (recomendado) — las tasks creadas en Phase D ya lo hacen

---

## Phase F — Task Scheduler para auto-update

```powershell
# Crear task que ejecuta run-update.bat cada 15 minutos
schtasks /Create /TN "FRC-Filial-Update" /TR "C:\frc-filial\run-update.bat" /SC MINUTE /MO 15 /RU franco /RP <password> /F

# Verificar que se creó
schtasks /Query /TN "FRC-Filial-Update" /FO LIST

# Ejecutar manualmente una vez para verificar
schtasks /Run /TN "FRC-Filial-Update"

# Verificar log de salida
timeout /t 30
type C:\frc-filial\logs\check-update.log
# Debe mostrar: "Already up to date" (si no hay versión beta nueva)
# O "New version available" + descarga (si hay beta publicado)
```

### Gotchas del piloto alpha

- **`/RU` y `/RP` obligatorios** — sin ellos, la task corre como `SYSTEM` y puede no tener acceso a la red (GitHub API)
- **Sin mecanismo de lock:** si `check-update.ps1` tarda más de 15 min (descarga lenta del JAR de ~102MB), Task Scheduler lanza otra instancia. En la práctica rara vez pasa, pero monitorear el log para runs paralelos.
- **La task se ejecuta aunque nadie esté loggeado** — si se creó con `/RU` usuario, el usuario no necesita tener sesión abierta.
- **Si la password de `franco` cambia**, la task falla silenciosamente. Fix: `schtasks /Change /TN "FRC-Filial-Update" /RU franco /RP nuevapassword`

---

## Phase G — Primer auto-update

Tras instalar la task del scheduler, si hay versión beta publicada distinta de `.current-version=3.0.9`, el auto-update se dispara en ≤15 min.

**Qué observar:**

```powershell
# En tiempo real (abrir otra sesión SSH o terminal):
powershell -Command "Get-Content C:\frc-filial\logs\update.log -Wait -Tail 50"

# Secuencia esperada:
# 1. "New version available: X.Y.Z-beta.N (current: 3.0.9)"
# 2. "Downloading frc-filial-server.jar from release vX.Y.Z-beta.N..."
# 3. "Downloaded to ...\releases\X.Y.Z-beta.N\frc-filial-server.jar (102MB)"
# 4. "Updating junction: current -> ...\releases\X.Y.Z-beta.N"
# 5. "Restarting frc-filial..."
# 6. "Health check PASSED (HTTP 200) at XXs"
# 7. "Successfully updated to X.Y.Z-beta.N"
# 8. "GitHub deployment notified: farmacia-filial-X-windows -> X.Y.Z-beta.N (success)"
```

### Pre-condiciones farmacia real
- DB respaldada (ya hecho en pre-checklist)
- Comunicación lista para "sistema puede estar 1-2 min off"
- Operador atento al log de update

### Tabla de errores conocidos

| Error | Causa probable | Fix |
|---|---|---|
| `HTTP 401` al GitHub API | Token sin scopes o expirado | Regenerar PAT con `repo` + `read:packages`, actualizar `.github-token` |
| `Asset not found` | Release no tiene `frc-filial-server.jar` | Verificar que `release.yml` sube asset con ese nombre |
| Health check timeout 120s | DB grande → Flyway + Spring Boot lentos | Incrementar `$HEALTH_TIMEOUT` en `check-update.ps1` |
| `permission denied for table pg_subscription` | Falta `GRANT SELECT` | Reaplicar GRANT (ver Phase 0) |
| Flyway migration failure | Conflicto de schema, tabla ya existe | Rollback automático del JAR, pero DB parcialmente migrada → restore backup |
| `Already up to date` inmediato | `.channel` dice `alpha` en vez de `beta` | `[System.IO.File]::WriteAllText('C:\frc-filial\.channel', 'beta')` |
| Script no se ejecuta | Execution policy o path mal en task | Verificar que `run-update.bat` existe y tiene `-ExecutionPolicy Bypass` |
| Dos instancias de Java | WinSW no fue deshabilitado | `sc config frc-server start= disabled` + `net stop frc-server` |
| Java 8 arranca en vez de 17 | PATH apunta a Java 8 | Usar path absoluto a Java 17 en `$JAVA_EXE` de `check-update.ps1` |
| `.env` no se parsea | BOM o encoding incorrecto | Recrear con `[System.IO.File]::WriteAllText()` |
| Docker PG no arrancó | Docker Desktop no inició (requiere login de Windows) | Configurar auto-login + Docker auto-start, o migrar PG a servicio nativo |
| Task no corre | Password de `franco` cambió | `schtasks /Change /TN "FRC-Filial-Update" /RU franco /RP nueva_pass` |

---

## Phase H — Verificación end-to-end

```powershell
# 1. Health check
powershell -Command "(Invoke-WebRequest -Uri http://localhost:8082/actuator/health -UseBasicParsing).StatusCode"
# ⚠️ usar SERVER_PORT del .env

# 2. Versión actualizada
type C:\frc-filial\.current-version
# Debe mostrar la versión beta (ej: 4.1.0-beta.2)

dir C:\frc-filial\current\
# Junction debe apuntar a releases\X.Y.Z-beta.N

# 3. Replicación streaming (ajustar comando psql según variante PG)
# Variante Docker:
docker exec postgres psql -U franco -d general -c "SELECT subname, received_lsn, latest_end_time FROM pg_stat_subscription;"
# Todas las suscripciones deben estar streaming con timestamps recientes

# 4. Tabla replication_test existe
docker exec postgres psql -U franco -d general -c "\dt configuraciones.replication_test"

# 5. Sin PK conflicts en logs PG
# Variante Docker:
docker exec postgres bash -c "grep -i 'duplicate key' /var/lib/postgresql/data/log/*.log 2>/dev/null | tail -5"

# 5b. Ruido SMB en logs PG (IGNORAR)
# En redes con máquinas Windows es normal ver estos mensajes en el log PG:
#   "could not receive data from client: Connection reset by peer"
#   "incomplete startup packet"
#   "unsupported frontend protocol 65363.19778: server supports 3.0 to 3.0"
# Protocolo 65363.19778 = 0xFF53.0x4D42 = bytes "ÿSMB" — sonda SMB de Windows
# golpeando el puerto PG. PG lo rechaza. No afecta nada.

# 6. Propagación bidireccional
# Central → filial: pedir al operador del central que haga un UPDATE de prueba
# Filial → central: hacer un UPDATE en tabla bidireccional, verificar propagación

# 7. Task Scheduler corriendo
schtasks /Query /TN "FRC-Filial-Update" /FO LIST
# "Última vez que se ejecutó" reciente, "Resultado de última ejecución" = 0

# 8. Log de auto-update
type C:\frc-filial\logs\check-update.log
# Debe mostrar "Already up to date" en runs posteriores al update exitoso

# 9. Log de aplicación sin errores graves
powershell -Command "Select-String -Path C:\frc-filial\logs\app-error.log -Pattern 'ERROR' | Select-Object -Last 10"
# WARNs de Flyway "already exists" son inofensivos
```

---

## Cleanup post-migración

Ejecutar **después de N días de estabilidad** (mínimo 1 semana):

- [ ] Verificar que nada referencia paths legacy: `findstr /r /s "C:\\FRC\\frc-server" C:\*.bat C:\*.ps1 C:\*.xml 2>nul`
- [ ] Eliminar servicio WinSW legacy: `sc delete frc-server` (solo si fue deshabilitado en Phase D)
- [ ] Remove directorio legacy: `rmdir /s /q C:\FRC\frc-server\` (conservar `C:\FRC\backup\` si tiene backups)
- [ ] Remover scheduled tasks viejas que referenciaban el servicio anterior
- [ ] Verificar que scripts de backup (SQLyog, etc.) referencian paths nuevos si aplican a la DB de la filial
- [ ] Limpiar releases viejas: mantener 2-3 versiones en `C:\frc-filial\releases\`, borrar las más antiguas

---

## Inventario filiales Windows producción

| Filial | IP | Hostname | OS | Java | PG variante | PG puerto | sucursalId | server.port | Central apunta a | Servicio legacy |
|---|---|---|---|---|---|---|---|---|---|---|
| 2 | 172.25.3.2 | SUC-GASUR | Win 10 Pro | **Java 8** ⚠️ | Docker (`postgres:16`) | 5551 | 2 | 8082 | `$CENTRAL_PUBLIC_IP:8082` | WinSW `frc-server` |

⚠️ **Filial 2 requiere instalar Java 17 antes de migrar.** El JAR beta requiere Java 17+.

---

## Pendiente validar en piloto beta

- [x] Ejecutar ciclo completo en piloto Windows (`172.25.0.3`) con canal **beta** — `4.0.0-alpha.3 → 4.1.0-beta.2`, downtime 5s, health 200
- [x] Validar que `check-update.ps1` parsea correctamente tags `-beta.X` — OK
- [x] Flyway migrations OK en DB Windows (`postgresql-alpha` servicio nativo)
- [x] `setupFullReplication` validado en piloto Windows — 10 pasos OK, E2E bidireccional OK (2026-04-17)
- [ ] Validar transición WinSW → Task Scheduler en filial producción (pendiente)
- [ ] Validar que Docker PG sobrevive reboot sin intervención manual
- [ ] Probar rollback automático (health check failure → rollback a versión anterior)

---

## Bitácora

| Fecha | Evento | Notas |
|---|---|---|
| 2026-03-28 | Piloto alpha Windows completo (Fase 7) | `172.25.0.3`, PG 16 servicio `postgresql-alpha` 5552, Task Scheduler OK, auto-update `alpha.2 → alpha.3` verificado. |
| 2026-04-17 | Runbook v2 Windows completo | Análisis profundo de piloto + filial producción (172.25.3.2). Variantes PG, WinSW vs Task Scheduler, encoding gotchas, Java 17 path. |
| 2026-04-17 | Migración alpha→beta piloto Windows | `.channel` cambiado a `beta`, `IPSERVIDORCENTRAL` → `172.25.1.200:8084`. Auto-update `4.0.0-alpha.3 → 4.1.0-beta.2`, 5s downtime. |
| 2026-04-17 | Replicación lógica piloto Windows | Requirió: `listen_addresses=*`, `wal_level=logical`, firewall TCP 5552, `pg_hba.conf` replication `md5`, `ALTER USER franco WITH PASSWORD`. `setupReplication` GraphQL falla (franco no-superuser). Sub central creada como postgres. Sub filial creada manualmente. Streaming bidireccional OK. |
| 2026-04-17 | `setupFullReplication` requiere franco SUPERUSER | `pg_create_subscription` no alcanza cuando filial pg_hba tiene `trust` para la subnet (logical replication usa `replication=database`, matchea la regla `host all all ... trust`). Fix: `ALTER USER franco WITH SUPERUSER` en central y en filial. |
| 2026-04-17 | Slots huérfanos bloquean retry de setupFullReplication | `DROP SUBSCRIPTION ... SET (slot_name = NONE)` no dropea el slot en el publisher. Quedan slots activos vacíos que bloquean `CREATE SUBSCRIPTION` con el mismo nombre. Fix: verificar `pg_replication_slots` y usar `pg_drop_replication_slot()` antes de reintentar. |
| 2026-04-17 | setupFullReplication sucursal 3 exitoso (piloto Windows) | Tras SUPERUSER + limpieza de slots: 10 pasos OK, E2E central↔filial OK, workers 2/2 streaming. |
| 2026-04-17 | Deploy `4.2.0-beta.3` — removeFullReplication + idempotencia | PRs #29 + #30 mergeados. `setupFullReplication` ahora limpia automáticamente (Paso 0). Validado vía GraphQL en beta (8084): Paso 0 limpió 3 subs + 2 pubs + 3 slots huérfanos, Pasos 1-10 OK, E2E bidireccional OK. |
| 2026-04-17 | Ruido SMB en logs PG documentado | Protocolo 65363.19778 (ÿSMB) golpeando puerto PG — normal en redes Windows, PG lo rechaza, no afecta replicación. |

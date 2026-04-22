# Runbook — Migración Filial Linux a canal beta

**Estado:** v2 — validado en piloto, completado para setup desde cero.

**Última actualización:** 2026-04-17

**Runbooks relacionados:**
- [runbook-migracion-central-beta.md](runbook-migracion-central-beta.md) — servidor central (ejecutar primero)
- [runbook-migracion-filial-windows-beta.md](runbook-migracion-filial-windows-beta.md) — filial Windows

---

## Contexto

Este runbook cubre la migración de una **filial Linux** desde estructura legacy al canal **beta** del pipeline CI/CD. Las filiales reciben auto-updates cada 15 minutos vía cron + `check-update.sh`.

Las filiales de producción **no tienen ninguna implementación CI/CD previa** — todo se configura desde cero. Este runbook asume eso.

**Piloto:** `172.25.0.172:8082` (cluster PG 5553, DB `general`, user `franco`, servicio `frc-filial-beta.service`, cron `*/5`)
**Farmacia real:** `172.25.3.4` (cluster PG default 5432, DB `general`, user `franco`, servicio a definir, cron `*/15`)

**Prerrequisito:** el central ya debe estar migrado y desplegando versiones beta (ver [runbook central](runbook-migracion-central-beta.md)).

---

## Phase 0 — Prerequisitos

### Software requerido

Verificar en la filial **antes** de empezar:

```bash
# Java 17+ (requerido por versiones beta del JAR)
java -version
# Si no está: sudo yum install java-17-openjdk (RHEL/CentOS) o sudo apt install openjdk-17-jre (Debian/Ubuntu)

# jq (requerido por check-update.sh para parsear GitHub API)
jq --version
# Si no está: sudo yum install jq (RHEL/CentOS) o sudo apt install jq (Debian/Ubuntu)

# curl (generalmente ya está)
curl --version

# flock (parte de util-linux, generalmente ya está)
which flock
```

### PostgreSQL

Se usa el **cluster existente** de la filial (no crear uno nuevo). Verificar:

```bash
# Puerto donde corre PG (generalmente 5432 o 5551)
sudo -u postgres psql -c "SHOW port;"

# DB de la filial (generalmente "general")
sudo -u postgres psql -l | grep general

# Que el user "franco" puede conectarse
PGPASSWORD=$DB_PASSWORD psql -h localhost -U franco -d general -c "SELECT 1;"
```

### Backup de DB (obligatorio)

```bash
# Backup completo del cluster PG
sudo -u postgres pg_dumpall > ~/backups/backup-filial-$(hostname)-$(date +%F).sql

# Verificar tamaño (debe ser > 0)
ls -lh ~/backups/backup-filial-*.sql
```

### Permiso `pg_subscription`

```bash
sudo -u postgres psql -c "GRANT SELECT ON pg_catalog.pg_subscription TO franco;"

# Verificación:
PGPASSWORD=$DB_PASSWORD psql -U franco -d general -c "SELECT subname FROM pg_subscription;"
# Si retorna filas → OK. Si "permission denied" → GRANT no aplicó.
```

**Nota:** el GRANT es a nivel cluster. Si se recrea el cluster, hay que reaplicar.

### Replicación lógica

Las filiales de producción **ya tienen publicaciones y suscripciones funcionando** con nomenclatura antigua (ej: `filial2_pub` en vez de `beta_filial2_pub`). **No tocar la replicación existente.** Se irá estandarizando la nomenclatura gradualmente en una fase posterior.

Verificar estado actual:

```bash
# Publicaciones (lo que la filial publica → central)
PGPASSWORD=$DB_PASSWORD psql -U franco -d general -c "SELECT pubname FROM pg_publication;"

# Suscripciones (lo que la filial recibe ← central)
PGPASSWORD=$DB_PASSWORD psql -U franco -d general -c "SELECT subname, received_lsn, latest_end_time FROM pg_stat_subscription;"

# Ambas deben existir y estar streaming. Si algo está roto, fix ANTES de continuar.
```

---

### Recursos de impresión — `resources/` legacy

La app lee el logo del ticket y las fotos de productos desde `$USER_HOME/FRC/resources/`. En el layout legacy eso es `/home/franco/FRC/resources/`. El pool CI/CD apunta `USER_HOME=/opt/frc-filial`, entonces el binario va a buscar `/opt/frc-filial/FRC/resources/` que **no se crea solo**.

Síntoma si no se copia: al imprimir un ticket la app tira `FileNotFoundException` por `logo.png` o cualquier imagen de producto.

**Copiar antes del primer ticket post-migración:**

```bash
sudo mkdir -p /opt/frc-filial/FRC
sudo cp -r /home/franco/FRC/resources /opt/frc-filial/FRC/resources
sudo chown -R franco:franco /opt/frc-filial/FRC
ls /opt/frc-filial/FRC/resources/images/logo.png   # debe existir
```

El directorio puede ser pesado (imágenes de productos). En filiales con catálogo grande son miles de archivos JPG — copia recursiva puede tardar segundos.

**Si hay update del logo posterior**: copiarlo a **ambas** rutas (legacy y pool) o marcar la legacy como read-only y dejar solo el pool. Decisión pendiente de documentar.

### `application.properties` externo — override de valores hardcoded en el JAR

El JAR beta del filial trae un `application.properties` **embebido** (`BOOT-INF/classes/application.properties`) con varios valores que quedaron hardcoded en el repo de desarrollo y **no son sobrescribibles con `.env` solo**. Razón: el código lee varias keys como `sucursalId`, `facturaCountDown`, `ipServidorCentral`, `jarPath`, etc. en camelCase directo (`@Value("${sucursalId}")` o `System.getProperty("sucursalId")`). El script `check-update.sh`/`start-filial.sh` convierte `KEY_NAME` del `.env` a `-Dkey.name` (lowercase + puntos), lo cual con Spring Boot *relaxed binding* debería matchear — pero el behavior no es 100% consistente y en la filial 2 Windows se observó que el valor `sucursalId=24` del JAR predominó sobre el `SUCURSALID=2` del `.env`, rompiendo INSERTs de `operaciones.cobro` con violación de FK.

**Valores hardcoded en el JAR (verificar con `unzip -p frc-filial-server.jar BOOT-INF/classes/application.properties`):**

| Key | Valor embebido | Debe ser |
|---|---|---|
| `sucursalId` | `24` | **per filial (1..N)** |
| `facturaCountDown` | `0` | **por filial** — leer del legacy `/home/franco/FRC/frc-server/application.properties` |
| `ipServidorCentral` | `localhost:8081` | IP:puerto del central (ej. `159.203.86.103:8082`) |
| `jarPath` | `/Users/gabfranck/Downloads/` (path del dev laptop) | `/opt/frc-filial/current` |

**Fix**: crear `application.properties` en el working directory del pool (`/opt/frc-filial/application.properties`). Spring Boot lo lee con **mayor precedencia** que el classpath del JAR.

```bash
cat > /opt/frc-filial/application.properties <<EOF
sucursalId=${SUCURSAL_ID}
facturaCountDown=${FCD_PER_FILIAL}
ipServidorCentral=159.203.86.103:8082
jarPath=/opt/frc-filial/current
user.home=/opt/frc-filial
homepath=/opt/frc-filial
EOF
chown franco:franco /opt/frc-filial/application.properties
chmod 644 /opt/frc-filial/application.properties
sudo systemctl restart frc.service
```

**`facturaCountDown`** difiere por filial — leer del legacy antes de aplicar:
```bash
grep facturaCountDown /home/franco/FRC/frc-server/application.properties
```

**Verificación post-restart** — que el cobro opere sin FK error:
```bash
PGPASSWORD=franco psql -h localhost -p 5551 -U franco -d general -c \
  "SELECT id, sucursal_id, creado_en FROM operaciones.cobro ORDER BY id DESC LIMIT 5"
```

Si el último `creado_en` es reciente y `sucursal_id` coincide con el de la filial = app inserta correcto.

**¿Y la data que se intentó grabar con `sucursal_id=24` antes del fix?** Nada. El constraint `cobro_sucursal_fk` (+ análogos en las otras tablas) rechazan el INSERT con `ERROR 23503 violates foreign key constraint`; Spring `@Transactional` hace rollback completo → **ninguna fila se persiste**. Los errores quedan en logs pero la base queda consistente. Confirmación:

```bash
# Cero filas con sucursal inválida tras el fix
PGPASSWORD=franco psql -h localhost -p 5551 -U franco -d general -tAc \
  "SELECT COUNT(*) FROM operaciones.cobro
    WHERE sucursal_id NOT IN (SELECT id FROM empresarial.sucursal)"
```

Los cobros que el operador tenía "pendientes de sincronizar" en la UI del desktop FRC se re-envían al server arreglado y se graban ahora con el `sucursal_id` correcto.

### Schedulers de replicación — desactivar hasta normalizar naming

La app Spring Boot del filial incluye los mismos schedulers que el central (`ReplicationPublicationSyncScheduler` cada 1h + `ReplicationRefreshScheduler` cada 2h). Tras migrar al canal beta, intenta `ALTER PUBLICATION farmacia_filialN_pub ADD TABLE ...` / `ALTER SUBSCRIPTION farmacia_filialN_central_sub REFRESH ...`, pero la publicación/suscripción en la filial tiene un **nombre legacy distinto** (ej. `filial5_pub`, `filial_farmacia_5_pub`, `central_filial_5_sub`, etc. — la nomenclatura varía filial por filial). Resultado: ~30 errores `no existe la publicación "farmacia_filialN_pub"` cada hora en el log de postgres + journalctl.

**Agregar al `.env` del pool:**

```env
REPLICATION_SYNC_ENABLED=false
REPLICATION_REFRESH_ENABLED=false
```

Reiniciar el servicio:
```bash
sudo systemctl restart frc.service
```

**Mantener en `false` hasta** que las publicaciones/suscripciones se renombren al estándar `farmacia_filialN_*` (vía `setupFullReplication(sucursalId=N)` GraphQL desde el desktop, que es idempotente y limpia+recrea con el naming nuevo). Re-activar solo cuando los nombres actuales coincidan con los que el scheduler espera.

## Pre-checklist

- [ ] **Central ya migrado** y desplegando versiones beta
- [ ] **Java 17+** instalado
- [ ] **jq** instalado
- [ ] **Backup DB** realizado y verificado (tamaño > 0)
- [ ] **GRANT pg_subscription** aplicado y verificado
- [ ] **Replicación funcionando** — publicaciones y suscripciones streaming
- [ ] **Backup snapshot legacy** — `tar czf ~/backups/filial-legacy-$(date +%F).tgz /home/franco/FRC/`
- [ ] **Snapshot crontabs** — `crontab -l > ~/backups/crontabs-pre-migration.txt`
- [ ] **Snapshot systemd units** — `systemctl list-unit-files --state=enabled | grep -i frc > ~/backups/systemd-pre-migration.txt`
- [ ] **Snapshot unit legacy** — `cp /etc/systemd/system/frc-filial*.service ~/backups/`
- [ ] **Búsqueda paths legacy** — `grep -r 'frc-server.jar\|/home/franco/FRC' /etc /home/franco /usr/local 2>/dev/null > ~/backups/legacy-paths.txt`
- [ ] **Token GitHub** — PAT clásico con scopes `repo` + `read:packages` (el mismo PAT que usa el central sirve)
- [ ] **Acceso SSH** funcionando desde máquina del operador
- [ ] **`.env` preparado** (ver sección "Archivo `.env`" abajo)

---

## Archivo `.env` — referencia completa

El `.env` reemplaza al `application.properties` legacy. Spring Boot lee estas variables como properties (convierte `_` a `.` y lowercase).

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

# === Paths (apuntar al nuevo directorio CI/CD) ===
USER_HOME=/opt/frc-filial
HOMEPATH=/opt/frc-filial

# === Identidad de la filial ===
SUCURSALID=NUMERO_SUCURSAL
IPSERVIDORCENTRAL=172.25.1.200:PUERTO_CENTRAL

# === Facturación ===
FACTURACOUNTDOWN=2

# === Backup de DB ===
BACKUP_ENABLED=false
# Si se quiere habilitar backup automático:
# BACKUP_ENABLED=true
# BACKUP_LOCAL_PATH=/opt/frc-filial/backup/postgres/
# BACKUP_GOOGLE_DRIVE_FOLDER_ID=<id del folder en Google Drive>
# BACKUP_GOOGLE_DRIVE_CLIENT_ID=<client id>
# BACKUP_GOOGLE_DRIVE_CLIENT_SECRET=<client secret>
# BACKUP_MAX_FILES=5
# BACKUP_BACKUP_HOUR=9
```

### Variables que hay que personalizar por filial

| Variable | De dónde sacar el valor | Ejemplo |
|---|---|---|
| `SPRING_DATASOURCE_URL` | Puerto PG de la filial (`SHOW port;`) | `jdbc:postgresql://localhost:5432/general` |
| `SERVER_PORT` | Puerto donde corre la filial actualmente | `8080` (default) o `8082` si es custom |
| `SUCURSALID` | `application.properties` legacy → `sucursalId` | `2`, `3`, etc. |
| `IPSERVIDORCENTRAL` | `application.properties` legacy → `ipServidorCentral` | `172.25.1.200:8082` (farmacia) o `:8081` (bodega) |
| `BACKUP_*` | `application.properties` legacy → `backup.*` | Copiar si backup habilitado |

### Cómo migrar desde `application.properties` legacy

```bash
# Ver el application.properties actual
cat /home/franco/FRC/frc-server/application.properties

# Mapeo de nombres:
#   application.properties          →  .env
#   spring.datasource.url=...       →  SPRING_DATASOURCE_URL=...
#   sucursalId = 2                  →  SUCURSALID=2
#   ipServidorCentral:IP:PORT       →  IPSERVIDORCENTRAL=IP:PORT
#   backup.enabled=true             →  BACKUP_ENABLED=true
#   backup.local-path=...           →  BACKUP_LOCAL_PATH=...
#   backup.google-drive.folder-id=  →  BACKUP_GOOGLE_DRIVE_FOLDER_ID=...
#   backup.google-drive.client-id=  →  BACKUP_GOOGLE_DRIVE_CLIENT_ID=...
#   backup.google-drive.client-secret= → BACKUP_GOOGLE_DRIVE_CLIENT_SECRET=...
#   backup.max-files=5              →  BACKUP_MAX_FILES=5
#   backup.backup-hour=9            →  BACKUP_BACKUP_HOUR=9
#   server.address:0.0.0.0          →  SERVER_ADDRESS=0.0.0.0
#   user.home=/home/franco          →  USER_HOME=/opt/frc-filial
#   homepath=/home/franco           →  HOMEPATH=/opt/frc-filial

# IMPORTANTE: no dejar espacios alrededor del "=" en el .env
# IMPORTANTE: cambiar USER_HOME y HOMEPATH a /opt/frc-filial (no dejar /home/franco)
```

---

## Systemd unit — template

### Opción A: Modificar el unit existente (recomendado si ya funciona)

```bash
# 1. Backup del unit actual
sudo cp /etc/systemd/system/frc-filial.service ~/backups/

# 2. Editar
sudo vim /etc/systemd/system/frc-filial.service
```

Cambiar las líneas relevantes a:

```ini
[Unit]
Description=FRC Filial Server
After=network.target postgresql.service

[Service]
Type=simple
User=franco
Group=franco
WorkingDirectory=/opt/frc-filial
EnvironmentFile=/opt/frc-filial/.env
ExecStart=/usr/bin/java -jar /opt/frc-filial/current/frc-filial-server.jar
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Opción B: Crear unit nuevo (si el legacy tiene nombre diferente o estructura muy distinta)

```bash
# Crear nuevo unit
sudo tee /etc/systemd/system/frc-filial.service <<'EOF'
[Unit]
Description=FRC Filial Server
After=network.target postgresql.service

[Service]
Type=simple
User=franco
Group=franco
WorkingDirectory=/opt/frc-filial
EnvironmentFile=/opt/frc-filial/.env
ExecStart=/usr/bin/java -jar /opt/frc-filial/current/frc-filial-server.jar
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Deshabilitar el viejo
sudo systemctl disable frc-filial-old.service  # nombre del unit legacy
sudo systemctl enable frc-filial.service
```

### Qué personalizar en el unit

| Línea | Personalizar | Notas |
|---|---|---|
| `After=` | Nombre del servicio PostgreSQL | `postgresql.service`, `postgresql-14.service`, etc. Verificar con `systemctl list-units \| grep postgres` |
| `WorkingDirectory=` | Siempre `/opt/frc-filial` | |
| `EnvironmentFile=` | Siempre `/opt/frc-filial/.env` | |
| `ExecStart=` | Path a Java puede variar | Verificar con `which java`. Si Java 17 no es el default, usar path absoluto: `/usr/lib/jvm/java-17-openjdk/bin/java` |

---

## `check-update.sh` — configuración

El script se copia desde `cicd-implementation/scripts/check-update.sh`. Las variables a editar están al inicio del archivo:

```bash
BASE_DIR="/opt/frc-filial"                    # NO cambiar (path estándar)
RELEASES_DIR="${BASE_DIR}/releases"            # NO cambiar
CURRENT_LINK="${BASE_DIR}/current"             # NO cambiar
VERSION_FILE="${BASE_DIR}/.current-version"    # NO cambiar
CHANNEL_FILE="${BASE_DIR}/.channel"            # NO cambiar
TOKEN_FILE="${BASE_DIR}/.github-token"         # NO cambiar
FILIAL_ID_FILE="${BASE_DIR}/.filial-id"        # NO cambiar
LOG_FILE="${BASE_DIR}/logs/update.log"         # NO cambiar
JAR_NAME="frc-filial-server.jar"              # NO cambiar
SERVICE_NAME="frc-filial.service"             # ⚠️ CAMBIAR si el unit tiene otro nombre
REPO="GabFrank/franco-system-backend-filial"  # NO cambiar
HEALTH_PORT=...                               # Se lee automáticamente de .env (SERVER_PORT)
HEALTH_TIMEOUT=120                            # Incrementar si Spring Boot tarda más de 2 min
```

**Lo único que normalmente hay que cambiar:** `SERVICE_NAME` si el systemd unit tiene nombre diferente a `frc-filial.service`.

---

## Phase D — Restructurar filial a layout CI/CD

### Resultado del piloto: ✅ COMPLETA (2026-04-17)

**Aprendizajes:**
- **Renombrar JAR es obligatorio.** Legacy usa `frc-server.jar`, CI/CD usa `frc-filial-server.jar`. Si ExecStart no se actualiza, el primer auto-update rompe el servicio sin rollback.
- **Orden crítico:** stop → crear estructura → mover JAR → symlink → `.current-version` → daemon-reload → start. No invertir pasos.
- **Downtime:** ~22 segundos en piloto. Producción puede ser más lento.

### Pasos

```bash
# En la filial como franco (con sudo para systemctl)

# ──────────────────────────────────────────────────────────
# PASO 0: Verificaciones previas (no toca nada, solo lee)
# ──────────────────────────────────────────────────────────

# Identificar el unit actual
systemctl list-units | grep -i frc
# Ejemplo de salida: frc-filial.service loaded active running FRC Filial Server

# Verificar paths legacy referenciados por otros scripts
sudo grep -r 'frc-server.jar\|/home/franco/FRC' /etc /home/franco /usr/local 2>/dev/null
crontab -l | grep -i frc

# Ver application.properties actual para migrar a .env
cat /home/franco/FRC/frc-server/application.properties

# ──────────────────────────────────────────────────────────
# PASO 1: Preparar .env ANTES de parar (minimiza downtime)
# ──────────────────────────────────────────────────────────

sudo install -d -o franco -g franco /opt/frc-filial
sudo install -d -o franco -g franco /opt/frc-filial/releases/3.0.9
sudo install -d -o franco -g franco /opt/frc-filial/logs

# Crear .env (ver sección "Archivo .env" arriba para template completo)
cat > /opt/frc-filial/.env <<'EOF'
SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5432/general
SPRING_DATASOURCE_USERNAME=franco
SPRING_DATASOURCE_PASSWORD=$DB_PASSWORD
SERVER_PORT=8080
SERVER_ADDRESS=0.0.0.0
SPRING_PROFILES_ACTIVE=prod
USER_HOME=/opt/frc-filial
HOMEPATH=/opt/frc-filial
BACKUP_ENABLED=false
SUCURSALID=CAMBIAR
IPSERVIDORCENTRAL=172.25.1.200:CAMBIAR
FACTURACOUNTDOWN=2
EOF
# ⚠️ EDITAR: SUCURSALID, IPSERVIDORCENTRAL, puerto PG, SERVER_PORT, y backup vars si aplican
vim /opt/frc-filial/.env

# Crear archivos CI/CD
echo "beta" > /opt/frc-filial/.channel
echo "CAMBIAR-FILIAL-ID" > /opt/frc-filial/.filial-id    # ej: farmacia-filial-2-linux
cat > /opt/frc-filial/.github-token <<'EOF'
PEGAR_TOKEN_AQUI
EOF
chmod 600 /opt/frc-filial/.env /opt/frc-filial/.github-token

# Copiar check-update.sh
cp /ruta/a/cicd-implementation/scripts/check-update.sh /opt/frc-filial/
chmod +x /opt/frc-filial/check-update.sh
# ⚠️ Editar SERVICE_NAME si el unit no se llama frc-filial.service
vim /opt/frc-filial/check-update.sh

# ──────────────────────────────────────────────────────────
# PASO 2: Parar servicio + restructurar (downtime empieza)
# ──────────────────────────────────────────────────────────

sudo systemctl stop frc-filial.service     # ← nombre del unit actual

# Copiar JAR con nombre CI/CD
cp /home/franco/FRC/frc-server/frc-server.jar /opt/frc-filial/releases/3.0.9/frc-filial-server.jar

# Crear symlink + version
ln -s /opt/frc-filial/releases/3.0.9 /opt/frc-filial/current
echo "3.0.9" > /opt/frc-filial/.current-version

# ──────────────────────────────────────────────────────────
# PASO 3: Actualizar systemd unit
# ──────────────────────────────────────────────────────────

# Opción A: Modificar existente
sudo cp /etc/systemd/system/frc-filial.service ~/backups/frc-filial.service.bak
sudo tee /etc/systemd/system/frc-filial.service <<'EOF'
[Unit]
Description=FRC Filial Server
After=network.target postgresql.service

[Service]
Type=simple
User=franco
Group=franco
WorkingDirectory=/opt/frc-filial
EnvironmentFile=/opt/frc-filial/.env
ExecStart=/usr/bin/java -jar /opt/frc-filial/current/frc-filial-server.jar
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
# ⚠️ Verificar: After= (nombre servicio postgres), ExecStart (path java)

sudo systemctl daemon-reload
sudo systemctl enable frc-filial.service
sudo systemctl start frc-filial.service    # ← downtime fin

# ──────────────────────────────────────────────────────────
# PASO 4: Verificar
# ──────────────────────────────────────────────────────────

curl -fsS localhost:8080/actuator/health          # ⚠️ usar SERVER_PORT del .env
readlink /opt/frc-filial/current                  # debe apuntar a releases/3.0.9
cat /opt/frc-filial/.current-version              # debe decir 3.0.9
sudo systemctl status frc-filial.service          # active (running)
```

### Rollback

```bash
sudo systemctl stop frc-filial.service
sudo cp ~/backups/frc-filial.service.bak /etc/systemd/system/frc-filial.service
sudo systemctl daemon-reload
sudo systemctl start frc-filial.service
# JAR original sigue en /home/franco/FRC/frc-server/
```

---

## Phase E — Sudoers para franco

`check-update.sh` ejecuta `sudo systemctl restart`. Sin sudoers, cron falla silenciosamente.

```bash
# ⚠️ Cambiar frc-filial.service si el unit tiene otro nombre
sudo bash -c 'echo "franco ALL=(root) NOPASSWD: /usr/bin/systemctl restart frc-filial.service, /usr/bin/systemctl status frc-filial.service" > /etc/sudoers.d/franco-frc-filial'
sudo chmod 0440 /etc/sudoers.d/franco-frc-filial
sudo visudo -cf /etc/sudoers.d/franco-frc-filial   # debe decir "parsed OK"

# Verificar (DEBE funcionar sin pedir password):
sudo -n systemctl status frc-filial.service
```

### Gotchas del piloto
- **`%wheel` group:** `franco` puede estar en `wheel` (requiere password). El NOPASSWD en `/etc/sudoers.d/` prevalece porque `#includedir /etc/sudoers.d` está al final de `/etc/sudoers`. **Verificar** que `#includedir` esté al final: `tail -3 /etc/sudoers`
- **Verificar con `sudo -n`** (no-interactive). Si retorna `sudo: a password is required`, el NOPASSWD **no funciona**.
- **Un archivo sudoers por servicio.** No usar wildcards `frc-*.service`.
- **Verificar si ya existe** `/etc/sudoers.d/franco-frc*` — evitar duplicados que se pisen.

---

## Phase F — Crontab

```bash
# Crear log dir
sudo install -d -o franco -g franco /var/log/frc-filial

# Verificar que NO hay crontabs viejos que interfieran
crontab -l | grep -i frc
# Si hay entries viejas de update o del JAR antiguo, removerlas primero

# Instalar crontab con flock (previene ejecuciones paralelas)
( crontab -l 2>/dev/null | grep -v 'check-update'; echo '*/15 * * * * /usr/bin/flock -n /tmp/frc-filial-update.lock /opt/frc-filial/check-update.sh >> /var/log/frc-filial/check-update.log 2>&1' ) | crontab -

# Verificar
crontab -l | grep check-update
```

### Gotchas del piloto
- **`flock` es esencial.** Sin él, si la descarga del JAR (102M) tarda más que el intervalo del cron, se solapan ejecuciones.
- **Log dir** debe existir ANTES del crontab.
- **El script tiene log propio** en `logs/update.log` dentro de `/opt/frc-filial/`, además del log del cron redirigido.

---

## Phase G — Primer auto-update

Tras instalar el crontab, si hay versión beta publicada distinta de `.current-version=3.0.9`, el auto-update se dispara en ≤15 min.

**Qué observar:**

```bash
# En tiempo real (desde otra terminal o SSH):
tail -f /opt/frc-filial/logs/update.log

# Debe mostrar:
# 1. "New version available: X.Y.Z-beta.N (current: 3.0.9)"
# 2. "Downloading frc-filial-server.jar..."
# 3. "Downloaded to .../releases/X.Y.Z-beta.N/frc-filial-server.jar (102M)"
# 4. "Updating symlink..."
# 5. "Restarting frc-filial.service..."
# 6. "Health check PASSED (HTTP 200) at XXs"
# 7. "Successfully updated to X.Y.Z-beta.N"
# 8. "GitHub deployment notified: ... (success)"
```

### Pre-condiciones farmacia real
- DB respaldada (ya hecho en pre-checklist)
- Comunicación lista para "sistema puede estar 1-2 min off"
- Operador atento al log de update

### Tabla de errores conocidos

| Error | Causa probable | Fix |
|---|---|---|
| `HTTP 401` al GitHub API | Token sin scopes o expirado | Regenerar PAT con `repo` + `read:packages` |
| `Asset not found` | Release no tiene `frc-filial-server.jar` | Verificar que `release.yml` sube asset con ese nombre |
| Health check timeout 120s | DB grande → Flyway + Spring Boot lentos | Incrementar `HEALTH_TIMEOUT` en `check-update.sh` |
| `permission denied for table pg_subscription` | Falta `GRANT SELECT` | `sudo -u postgres psql -c "GRANT SELECT ON pg_catalog.pg_subscription TO franco;"` |
| Flyway migration failure | Conflicto de schema, tabla ya existe | Rollback automático del JAR, pero DB parcialmente migrada → restore backup |
| `No route to host` (en logs del central) | Filial apagada cuando scheduler central intenta conectar | Inofensivo — se resuelve solo cuando la filial vuelve |
| `Already up to date` inmediato | `.channel` dice `alpha` en vez de `beta` | `echo "beta" > /opt/frc-filial/.channel` |
| Script no se ejecuta | `check-update.sh` sin permiso de ejecución | `chmod +x /opt/frc-filial/check-update.sh` |

---

## Phase H — Verificación end-to-end

```bash
# 1. Health
curl -s localhost:8080/actuator/health    # ⚠️ usar SERVER_PORT del .env

# 2. Versión
cat /opt/frc-filial/.current-version      # versión beta esperada
readlink /opt/frc-filial/current          # apunta a releases/X.Y.Z-beta.N

# 3. Replicación streaming
PGPASSWORD=$DB_PASSWORD psql -U franco -d general -c \
  "SELECT subname, received_lsn, latest_end_time FROM pg_stat_subscription;"
# Todas las suscripciones deben estar streaming con timestamps recientes

# 4. Tabla replication_test existe
PGPASSWORD=$DB_PASSWORD psql -U franco -d general -c "\dt configuraciones.replication_test"

# 5. Sin PK conflicts
sudo -u postgres grep -i "duplicate key" /var/lib/pgsql/data/log/*.log 2>/dev/null | tail -5
# (ajustar path de logs PG según distribución)

# 6. INSERT bidireccional
# Central → filial: pedir al operador del central que inserte un registro de prueba
# Filial → central: UPDATE en tabla bidireccional, verificar propagación

# 7. Cron
tail -10 /var/log/frc-filial/check-update.log
# Debe mostrar "Already up to date" en los runs después del update

# 8. Logs limpios
journalctl -u frc-filial --since "30 min ago" | grep -i error | tail -10
# Sin errores nuevos (WARNs de Flyway "already exists" son inofensivos)
```

---

## Cleanup post-migración

Ejecutar **después de N días de estabilidad** (mínimo 1 semana):

- [ ] Verificar que nadie/nada referencia paths legacy: `grep -r '/home/franco/FRC' /etc /home/franco /usr/local 2>/dev/null`
- [ ] Remove directorio legacy: `rm -rf /home/franco/FRC/frc-server/` (conservar `FRC/backup/` si tiene backups)
- [ ] Remover crontab entries viejas que referenciaban paths legacy
- [ ] Actualizar scripts de backup que referencian paths viejos
- [ ] Remove backup del unit legacy de `~/backups/` (solo después de confirmar estabilidad)

---

## Bitácora

| Fecha | Evento | Notas |
|---|---|---|
| 2026-04-17 | Phase D piloto completa | `current/` → symlink, JAR renombrado, ExecStart fixeado. Downtime ~22s. |
| 2026-04-17 | Phase E piloto completa | Sudoers OK. Gotcha: `%wheel` group no interfiere porque `#includedir` al final. |
| 2026-04-17 | Phase F piloto completa | Crontab `*/5` con flock. Log dir creado. |
| 2026-04-17 | Phase G piloto completa | Auto-update `3.0.9 → 4.1.0-beta.1`. Flyway OK, health 20s, GitHub deployment notificado. |
| 2026-04-17 | Phase H verificación | Health UP, replicación bidireccional OK, `replication_test` existe, cron OK, logs limpios. |
| 2026-04-17 | Bug nombres hardcoded | Fix en PR #16 (V62.7 migration). Deployado en `4.1.0-beta.2` via auto-update. |
| 2026-04-17 | `pg_subscription` GRANT | Obligatorio en cluster filial. Se pierde si cluster se recrea. |
| 2026-04-17 | Runbook v2 | Completado para setup desde cero: prerequisitos, `.env` template completo, systemd unit template, configuración check-update.sh, mapeo application.properties → .env. |

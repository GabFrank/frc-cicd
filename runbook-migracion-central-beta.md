# Runbook — Migración Central a canal beta

**Estado:** v1 — validado en piloto (`172.25.1.200:8084`). Listo para ejecutar en farmacia real (`172.25.1.200:8082`).

**Última actualización:** 2026-04-17

**Runbooks relacionados:**
- [runbook-migracion-filial-linux-beta.md](runbook-migracion-filial-linux-beta.md) — filial Linux
- [runbook-migracion-filial-windows-beta.md](runbook-migracion-filial-windows-beta.md) — filial Windows

---

## Contexto

Este runbook cubre la migración del **servidor central** desde la estructura legacy 3.0.9 al canal **beta** del pipeline CI/CD. El central recibe deploys manuales vía `workflow_dispatch` (GitHub Actions).

**Piloto:** `172.25.1.200:8084` (puerto 8084, cluster PG 5552, DB `beta`, user `deploy`, servicio `frc-beta.service`)
**Farmacia real:** `172.25.1.200:8082` (puerto 8082, cluster PG 5551 compartido con bodega/alpha, DB `farmacia`, user `deploy` o `franco`, servicio `frc-farmacia.service`)

### Mapa de puertos — instancias central (`172.25.1.200`)

| Puerto app | Instancia | Canal | Cluster PG | DB |
|---|---|---|---|---|
| 8081 | bodega | stable | 5551 | bodega |
| 8082 | farmacia | producción (migrar a beta) | 5551 | farmacia |
| 8083 | alpha | alpha | 5551 | alpha |
| 8084 | beta (piloto) | beta | 5552 | beta |

---

## Diferencias conocidas piloto vs farmacia real

| Aspecto | Beta (piloto) | Farmacia (producción) |
|---|---|---|
| User del servicio | `deploy` (ya configurado) | `franco` — decidir si migrar a `deploy` o mantener |
| Path JAR | `/opt/frc-backend-central/beta/` (ya existe) | `/home/franco/farma/FRC/frc-server/` (legacy) |
| Cluster postgres | Separado en puerto `5552` | Compartido con bodega/alpha en `5551` |
| `.env` | Ya existe | NO existe — settings en `application.properties` al lado del JAR |
| `application.properties` legacy | Ya migrado a `.env` | Sigue al lado del JAR — al mover JAR al pool, se rompe classpath relativo |
| Coordinación humana | Cero (entorno test) | Ventana mantenimiento + comunicación a personal farmacia |
| Datos en juego | Backups de farmacia (recoverable) | Datos productivos en vivo — backup OBLIGATORIO |

---

## Schedulers de replicación lógica (crítico)

El servidor central tiene **2 schedulers** que afectan la replicación lógica. Se activan por defecto vía `application.properties` empaquetado en el JAR.

### 1. `ReplicationPublicationSyncScheduler`
- **Frecuencia:** cada 1 hora (config: `replication.sync.fixed-delay`, default 3600000ms)
- **Propiedad:** `replication.sync.enabled=true` (`matchIfMissing=false`)
- **Qué hace:** lee `configuraciones.replication_table` y agrega tablas faltantes a publicaciones existentes en central y en cada filial alcanzable vía JDBC remoto
- **Comportamiento en DB clonada:** re-agrega tablas que habíamos quitado. Intenta `ALTER PUBLICATION filialX_pub` para sucursales que no existen en beta → errores inofensivos pero ruidosos

### 2. `ReplicationRefreshScheduler`
- **Frecuencia:** cada 2 horas (config: `replication.refresh.fixed-delay`, default 7200000ms)
- **Qué hace:** ejecuta `ALTER SUBSCRIPTION ... REFRESH PUBLICATION` en suscripciones locales Y remotas
- **Lee de:** `empresarial.sucursal` (filtra `activo=true AND ip IS NOT NULL AND puerto IS NOT NULL`)
- **Comportamiento en DB clonada:** si hay sucursales con IPs de producción, **se conecta a filiales reales** vía JDBC remoto

### Riesgo crítico en DB clonada

**Si la DB fue clonada de producción y no se limpiaron las sucursales**, los schedulers conectan a filiales de producción real.

**Mitigación obligatoria al clonar DB:**
```sql
UPDATE empresarial.sucursal SET ip = NULL, puerto = NULL WHERE id != <sucursal_beta>;
-- Verificar que configuraciones.local apunte al cluster correcto
```

### Tablas que controlan el comportamiento

| Tabla | Qué controla | Verificar en DB clonada |
|---|---|---|
| `empresarial.sucursal` | IPs y puertos de filiales | Solo sucursales beta con `ip`/`puerto` seteados |
| `configuraciones.local` | DB name, IP y puerto del servidor central | Que apunte al cluster correcto |
| `configuraciones.replication_table` | Tablas a replicar, dirección | Si una tabla no existe en filial, REFRESH falla |
| `pg_subscription` (catálogo) | Suscripciones activas | Requiere `GRANT SELECT` para user de la app |

---

## Permiso `pg_subscription` — obligatorio

`LogicalReplicationService` ejecuta `SELECT * FROM pg_catalog.pg_subscription`. Sin el GRANT, falla con `ERROR: permission denied for table pg_subscription`.

**Ejecutar ANTES de Phase C (primer deploy CI/CD):**

```bash
# Cluster central farmacia (5551, compartido con bodega/alpha)
sudo -u postgres psql -p 5551 -c "GRANT SELECT ON pg_catalog.pg_subscription TO franco;"
```

**Verificación rápida:**
```bash
PGPASSWORD=$DB_PASSWORD psql -h localhost -p 5551 -U franco -d farmacia -c "SELECT subname FROM pg_subscription;"
```

**Gotcha del piloto:** el GRANT es a nivel cluster, no DB. Si se recrea el cluster, se pierde. Para farmacia real (cluster 5551 existente) se aplica una vez y persiste.

---

## Pre-checklist farmacia real

- [ ] **Backup completo DB** (`pg_dumpall -p 5551 > backup-farmacia-prod.sql`) en disco local Y copia remota
- [ ] **Backup snapshot de `/home/franco/farma/`** — `tar czf farma-legacy.tgz /home/franco/farma/`
- [ ] **Snapshot servicios systemd** — `systemctl list-unit-files --state=enabled | grep -i frc`
- [ ] **Snapshot replication state** — pubs, subs, slots en cluster 5551
- [ ] **Documentar versión exacta** — `curl localhost:8082/actuator/info` o MANIFEST del JAR
- [ ] **Listar paths legacy** — `grep -r '/home/franco/farma\|frc-server.jar' /etc /usr/local /home/franco`
- [ ] **GRANT pg_subscription** aplicado (ver sección arriba)
- [ ] **Ventana de mantenimiento acordada** — comunicada a personal farmacia
- [ ] **Plan de rollback validado**
- [ ] **Acceso SSH funcionando** desde máquina del operador

---

## Phase A — Restructurar central a layout CI/CD

### Resultado del piloto: ✅ COMPLETA (2026-04-16)

**Aprendizajes clave:**
- Pool `/opt/frc-backend-central/releases/3.0.9/` YA EXISTÍA — farmacia/bodega parcialmente migradas
- `farmacia/current` y `bodega/current` ya son symlinks a `releases/3.0.9`
- **`/actuator/health` retorna 503 en 3.0.9** — bug viejo, `deploy.sh` acepta 503 ✅
- Downtime: ~90 segundos

### Pasos farmacia real

```bash
# En 172.25.1.200
sudo systemctl stop frc-farmacia.service     # <-- downtime empieza

# Crear estructura (si no existe)
sudo install -d -o franco -g franco /opt/frc-backend-central/farmacia
sudo install -d -o franco -g franco /opt/frc-backend-central/releases/3.0.9

# Copiar JAR al pool compartido (si no está ya)
sudo -u franco cp /home/franco/farma/FRC/frc-server/frc-central-server.jar \
                  /opt/frc-backend-central/releases/3.0.9/

# Crear symlink current
sudo -u franco ln -s /opt/frc-backend-central/releases/3.0.9 /opt/frc-backend-central/farmacia/current
echo "3.0.9" | sudo -u franco tee /opt/frc-backend-central/farmacia/.current-version

# Migrar application.properties a .env
sudo -u franco vim /opt/frc-backend-central/farmacia/.env  # crear con vars necesarias

# Actualizar systemd unit
sudo vim /etc/systemd/system/frc-farmacia.service
# ExecStart → /usr/lib/jvm/.../bin/java -jar /opt/frc-backend-central/farmacia/current/frc-central-server.jar
# Agregar: EnvironmentFile=/opt/frc-backend-central/farmacia/.env
# Agregar: WorkingDirectory=/opt/frc-backend-central/farmacia

sudo systemctl daemon-reload
sudo systemctl start frc-farmacia.service    # <-- downtime fin
curl -fsS localhost:8082/actuator/health     # 200 o 503
```

### Pendiente documentar
- Lista completa de variables para `.env`
- Gotcha de `application.properties` legacy (settings únicos que no están en `.env`)

### Rollback

```bash
sudo systemctl stop frc-farmacia.service
sudo cp ~/backups/frc-farmacia.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start frc-farmacia.service
# JAR original sigue en /home/franco/farma/ — legacy unit lo levanta
```

---

## Phase B — `farmacia` en deploy.yml

`farmacia` ya está en `deploy.yml` mapeada al canal `-beta`. **No requiere cambio de código.**

---

## Phase C — Primer deploy CI/CD

```
Actions → Deploy → workflow_dispatch:
  instance: farmacia
  version: <último -beta de central>
```

### Resultado del piloto: ✅ COMPLETA (2026-04-16)

**Aprendizajes clave:**
- **Sudoers para user `deploy` es OBLIGATORIO.** `deploy.sh` ejecuta `sudo systemctl restart`. Sin entry en `/etc/sudoers.d/deploy-frc`, falla con `sudo: a terminal is required to read the password`. Para farmacia real ya existen las entries (verificado).
- **`workflow_dispatch` lee workflow desde branch default (master).** Si master no tiene el cambio, falla. Fix: `--ref release/beta`.
- **Environment `beta` requiere aprobación manual** en GitHub UI.
- **`/actuator/info` retorna `{}`** en 3.0.9 — sin build-info. Validar con `cat .current-version` o `readlink current`.

### Diferencias con farmacia real
- **Variables `.env`:** piloto heredó `.env` existente. Farmacia NO tiene `.env` — crearlo antes de Phase C con TODAS las vars de `application.properties` legacy.

### Rollback

```bash
# deploy.sh hace rollback automático si health check falla
# Si DB corrompida por migration parcial:
sudo systemctl stop frc-farmacia.service
psql -p 5551 farmacia < ~/backups/backup-farmacia-prod.sql
```

---

## Acceso GraphQL — referencia rápida

Útil para verificar la instancia o ejecutar mutaciones de replicación manualmente.

### Login (REST, no GraphQL)

```bash
curl -s -X POST http://172.25.1.200:PUERTO/login \
  -H "Content-Type: application/json" \
  -d '{"nickname": "NOMBRE COMPLETO EN MAYUSCULAS", "password": "PASSWORD EN MAYUSCULAS"}'
# Retorna JSON con campo "token"
```

### Llamar GraphQL

```bash
TOKEN="<token del paso anterior>"
curl -s -X POST "http://172.25.1.200:PUERTO/graphql" \
  -H "Content-Type: application/json" \
  -H "Authorization: Token $TOKEN" \
  --data-raw '{"query":"{ __typename }"}'
```

> ⚠️ **El header es `Authorization: Token <jwt>`, NO `Bearer`.** Con `Bearer` el servidor retorna HTTP 200 con body vacío (el filtro JWT lo ignora silenciosamente).

### Mutaciones de replicación útiles

```graphql
# Setup completo (idempotente — limpia todo antes de crear)
mutation { setupReplication(input: { sucursalId: "3", tables: [] }) { success message } }

# Limpieza completa sin recrear (subs, pubs, slots huérfanos en central y filial)
mutation { removeFullReplication(sucursalId: "3") { success message } }

# Estado actual de la replicación
query { getReplicationSetupState(sucursalId: "3") {
  centralPublicationExists centralSubscriptionExists
  filialReachable filialPublicationExists
  filialSubscriptionBidiExists filialSubscriptionCentralExists
}}
```

---

## Replicación — setupFullReplication y removeFullReplication

Desde versión `4.2.0-beta.3`, `setupReplication` (GraphQL) es **idempotente**: ejecuta `removeFullReplication` como Paso 0 antes de crear objetos. No es necesario limpiar manualmente slots huérfanos, publicaciones o suscripciones.

`removeFullReplication` (también expuesto como mutation) realiza limpieza best-effort en 5 pasos:
1. Drop suscripciones en central (DISABLE → SET slot_name=NONE → DROP)
2. Drop suscripciones en filial (vía JDBC remoto)
3. Drop publicaciones en central y filial
4. Drop slots huérfanos en central (`pg_replication_slots WHERE active=false AND slot_name LIKE '%filialX%'`)
5. Drop slots huérfanos en filial

Cada paso loguea warning si falla pero continúa con el siguiente.

**Prerequisito:** `franco` debe ser `SUPERUSER` en el PG de central y en el PG de la filial. Ver [runbook filial Windows](runbook-migracion-filial-windows-beta.md#franco-superuser--obligatorio-para-setupfullreplication).

---

## Phase H (parcial) — Verificación central

1. `curl localhost:8082/actuator/health` → UP
2. `cat .current-version` → versión beta esperada
3. `readlink current` → apunta a versión correcta en `releases/`
4. Logs de schedulers limpios (`journalctl -u frc-farmacia --since "1 hour ago" | grep -i error`)
5. `pg_subscription` accesible sin errores

---

## Cleanup post-migración

- [ ] Remove `/home/franco/farma/FRC/frc-server/` (después de N días de estabilidad)
- [ ] Remove unit legacy si se creó uno nuevo
- [ ] Verificar que no quedan crontabs/scripts referenciando paths viejos

---

## Decisiones tomadas

1. **User del servicio: `deploy`** (decidido 2026-04-21). Razón: el workflow CI/CD del repo central ya hace `ssh deploy@172.25.1.200`, el piloto beta `:8084` ya corre con `deploy`, y las entries en `/etc/sudoers.d/deploy-frc` ya están aplicadas (verificado en piloto). Ir con `franco` implicaría modificar el workflow, regenerar SSH keys, y romper simetría con bodega y alpha — zero upside. Path: chown `/opt/frc-backend-central/farmacia/` a `deploy`, `User=deploy` en unit.
2. **Cluster postgres 5551 compartido** con bodega/alpha (sin separación). Riesgo acotado — ya es así para bodega estable.

## Decisiones pendientes

1. **Ventana de mantenimiento óptima** — coordinar con farmacia, idealmente noche o domingo (bloqueado por resultado del escaneo, ver `scans/README.md` Fase 12b).

---

## Bitácora

| Fecha | Evento | Notas |
|---|---|---|
| 2026-04-16 | Phase A piloto completa | Pool `releases/3.0.9` ya existía. Health 503 en 3.0.9 (OK para deploy.sh). |
| 2026-04-16 | Phase B piloto: gotcha semantic-release | Tag conflict al mergear develop → release/beta sin commits de master. Fix: PR master → release/beta primero. |
| 2026-04-16 | Phase C piloto completa | Gotchas: sudoers, `--ref release/beta`, environment approval. |
| 2026-04-17 | Gotcha: datos clonados DB | `empresarial.sucursal` conserva IPs producción. Scheduler conecta a filiales reales. Mitigación: limpiar IPs. |
| 2026-04-17 | Schedulers de replicación documentados | SyncScheduler (1h) + RefreshScheduler (2h). Riesgo en DB clonada. |
| 2026-04-17 | `pg_subscription` GRANT | Obligatorio en cluster central. Se pierde si cluster se recrea. |
| 2026-04-17 | Bug nombres hardcoded en scheduler | Fix: PR #27 — generadores dinámicos + V119 migration. Deployado en `4.1.0-beta.2`. |
| 2026-04-17 | Deploy `4.1.0-beta.2` | Via workflow_dispatch con approval. Migraciones OK. |
| 2026-04-17 | Deploy `4.2.0-beta.3` | `removeFullReplication` + `setupFullReplication` idempotente + logging mejorado. PRs #29 (develop) y #30 (release/beta). |
| 2026-04-17 | `setupFullReplication` validado en beta (8084) | Sucursal 3 (172.25.0.3): Paso 0 limpió 3 subs + 2 pubs + 3 slots huérfanos; Pasos 1-10 OK; E2E bidireccional OK, workers 2/2. |

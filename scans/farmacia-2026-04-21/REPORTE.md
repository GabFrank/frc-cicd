# Reporte de escaneo Farmacia — 2026-04-21

## Resumen ejecutivo

- Hosts escaneados: **6/6** (central + 5 filiales)
- **NO-GO** para Phase A central farmacia hasta resolver blockers críticos
- Principales hallazgos:
  1. **Central farmacia** todavía ejecuta el JAR desde `/home/franco/farma/FRC/frc-server/` (legacy). El pool CI/CD `/opt/frc-backend-central/farmacia/` ya existe con `.env` y releases pre-cargadas (3.0.9, 3.0.10, 3.1.0-alpha.{2,3,4,12,13}) owner `deploy`, pero el `systemd unit` apunta al legacy con `User=franco`.
  2. **Java 11** en central — runbook exige 17+ (versiones beta compilan a 17). **BLOCKER**.
  3. **Java 8** en filial 2 (Windows). **BLOCKER crítico**.
  4. **Ninguna filial** tiene la estructura CI/CD instalada (`/opt/frc-filial/` vacío, no hay `check-update.sh`, `.env`, `.channel`, `.filial-id`, `.github-token`, cron).
  5. `jq` missing en filiales 1 y 3 (Linux). 4 y 5 la tienen.
  6. Registry del dashboard **mal clasifica filial 3 como Windows** — es Fedora 38.
- Secciones con `sudo` (PG port, GRANT `pg_subscription`, pubs/subs, slots, `empresarial.sucursal`) no pudieron ejecutarse: sudo requiere password TTY, que no está presente en SSH no-interactivo. **Re-correr esas secciones manualmente** con `sudo -i` en cada host antes de planear la ventana.

## Matriz por host

| Host | IP | Java | jq | PG cluster | GRANT subs | Pool CI/CD | .env pool | check-update | Cron | Pub/Sub | Blocker principal |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Central farmacia | 172.25.1.200 | **11 ❌** | — | 5551 (no validado) | ? sudo | OK (owner deploy) | OK (600 deploy) | N/A | N/A | ? sudo | Unit systemd corre legacy; Java 11 |
| Filial 1 (Fedora 38) | 172.25.3.1 | 17 ✅ | **MISSING ❌** | ? sudo | ? sudo | ❌ vacío | ❌ | ❌ | ❌ | ? sudo | Sin estructura CI/CD, jq missing |
| Filial 2 (Win10 SUC-GASUR) | 172.25.3.2 | **8 ❌❌** | N/A | 5551 listening | ? | ❌ `C:\opt\frc-filial` vacío | ❌ | ❌ | ❌ (sin Task) | ? | Java 8 crítico |
| Filial 3 (Fedora 38) | 172.25.3.3 | 17 ✅ | **MISSING ❌** | ? sudo | ? sudo | ❌ vacío | ❌ | ❌ | ❌ | ? sudo | Sin CI/CD, jq missing, registry lo marca Windows (corregir) |
| Filial 4 (Fedora 43 KDE) | 172.25.3.4 | 25 ✅ | ✅ | ? sudo | ? sudo | ❌ vacío | ❌ | ❌ | ❌ | ? sudo | Sin estructura CI/CD |
| Filial 5 (Fedora 43) | 172.25.3.5 | 17 ✅ | ✅ | ? sudo | ? sudo | ❌ vacío | ❌ | ❌ | ❌ | ? sudo | Sin estructura CI/CD |

## Blockers críticos (bloquean Phase A central y Phase B filial)

### 1. Central — Java 11 → instalar Java 17+
**Host:** 172.25.1.200  
**Qué:** `java -version` actual = OpenJDK 11.0.25. El piloto beta (`:8084`) corre Java 17. Los JARs beta compilarán con target 17. Sin upgrade, el deploy del beta tirará `UnsupportedClassVersionError`.  
**Fix:**
```bash
sudo dnf install java-17-openjdk-headless
sudo alternatives --set java /usr/lib/jvm/java-17-openjdk-*/bin/java
java -version   # verificar 17.x
```
**Timing:** hacer ANTES de Phase A — no implica downtime si se instala sin cambiar el default hasta el momento del cutover.

### 2. Central — Systemd unit apunta a path legacy
**Host:** 172.25.1.200  
**Qué:** `/etc/systemd/system/frc-farmacia.service` actual:
```
User=franco
WorkingDirectory=/home/franco/farma/FRC/frc-server/
ExecStart=/usr/bin/java -jar /home/franco/farma/FRC/frc-server/frc-server.jar
```
El pool `/opt/frc-backend-central/farmacia/current` existe y apunta a `releases/3.0.9`. El `.env` ya está en `/opt/frc-backend-central/farmacia/.env` (600, owner deploy). Falta:
- Cambiar `User=franco` → `User=deploy`
- `WorkingDirectory` y `ExecStart` apuntar al pool
- Agregar `EnvironmentFile=/opt/frc-backend-central/farmacia/.env`

**Ver:** `runbook-migracion-central-beta.md` §Phase A — los pasos ya están documentados y validados contra el piloto.  
**Timing:** requiere ventana de mantenimiento (~90 segundos downtime según piloto). Es el cambio central.

### 3. Filial 2 — Java 8 → instalar Java 17+
**Host:** 172.25.3.2 (SUC-GASUR, Windows 10)  
**Qué:** Java 1.8.0_351. Igual que central, JARs beta no arrancarán.  
**Fix:** instalar OpenJDK 17 (Temurin o MS) + ajustar PATH + actualizar el wrapper de WinSW (`frc-server.exe.xml`) para apuntar al nuevo `java.exe`.  
**Timing:** pre-migración filial 2. No impacta producción si se instala paralelo y se pospone cutover.

## Blockers menores (pre-migración, no paran el plan)

### 4. jq missing en filiales 1 y 3
**Fix:** `sudo dnf install jq`. 30 segundos, sin downtime.  
**Timing:** en cualquier momento.

### 5. Ninguna filial tiene estructura CI/CD
Aplica a las 5 filiales. Ninguna tiene `/opt/frc-filial/{releases,logs,.env,.channel,.filial-id,.github-token,check-update.sh}`.  
**Fix:** seguir `runbook-migracion-filial-linux-beta.md` §Phase A-C para filiales 1, 3, 4, 5 y `runbook-migracion-filial-windows-beta.md` para filial 2. Es literalmente "desde cero" pero el runbook cubre el paso-a-paso.  
**Timing:** después del central, una filial por vez, ~30 min por filial.

### 6. Registry del dashboard incorrecto
Filial 3 está clasificada como Windows en `monitored_servers`, pero es Fedora 38. Corregir el campo `os`.  
**Fix:**
```sql
UPDATE monitored_servers SET os = 'linux' WHERE nombre LIKE 'Farmacia · Filial 3%';
```
Ejecutar en la DB del dashboard del host (`172.25.0.172:3000` → admin UI o directo en `dash.db`).  
**Timing:** ahora, sin impacto.

## Secciones no verificadas — requieren re-ejecución con sudo interactivo

Los siguientes prereqs del runbook **no pudieron confirmarse** porque `sudo` requirió password TTY (SSH no-interactivo no lo tiene):

1. **Puerto PG** en cada host — central debería ser 5551, filiales 5432.
2. **GRANT `SELECT ON pg_catalog.pg_subscription TO franco`** — crítico para que la app lea subs.
3. **Existencia de publicaciones/suscripciones** (`pg_publication`, `pg_subscription`, `pg_replication_slots`).
4. **Contenido de `empresarial.sucursal`** en central — el runbook advierte de IPs clonadas de producción.
5. **Cron de root** y `/etc/cron.d` — confirmar que no hay cron vieja apuntando a paths legacy.
6. **Sudoers de `deploy`** (`/etc/sudoers.d/deploy-frc`) en central — el piloto los dejó.

**Acción recomendada:** operador entra vía SSH + `sudo -i` en cada host y corre los snippets faltantes. Plantilla en `scans/README.md`. Agregar output a `farmacia-2026-04-21/<host>-sudo.txt`.

## Desviaciones respecto al runbook

- **Filial 3 está clasificada mal** en el registry. El runbook asume Windows; hay que tratarla como Linux.
- **Filial 4** tiene Java 25 (muy nuevo) — Java 17+ exigido por runbook se cumple con margen, pero hay que validar que el JAR beta corre OK en 25 (no regressions).
- **Filial 2 (Windows)** tiene archivos sueltos en `C:\FRC\` (PDFs de facturación, installers de dbeaver, frc-app, Docker Desktop, impresión). No son bloqueadores pero conviene limpiar antes de migrar para evitar confusión futura.

## Recomendación

- [ ] **GO** para Phase A central (runbook-migracion-central-beta.md)
- [x] **NO-GO** hasta resolver:
  1. Java 17 en central (no downtime)
  2. Re-ejecución con sudo en los 6 hosts para confirmar PG + GRANT + pubs/subs (no downtime)
  3. Java 17 en filial 2 (no downtime)
  4. jq en filiales 1 y 3 (no downtime)
  5. Arreglar registry dashboard para filial 3 (no downtime)
  6. Validar sudoers deploy-frc en central (no downtime, solo lectura root)

Una vez resueltos esos 6 puntos (todos sin downtime), proponer ventana de ~30 min para ejecutar el cutover del central farmacia al pool CI/CD (cambio del unit systemd + restart). Después seguir con filiales una por una con observación de 24h entre cada.

## Próximos pasos inmediatos

1. Operador entra SSH con sudo a los 6 hosts y corre los snippets marcados como "? sudo" en la matriz. Output a `scans/farmacia-2026-04-21/<host>-sudo.txt`.
2. Instalar Java 17 en central y filial 2 Windows (paralelo, sin downtime).
3. Instalar jq en filiales 1 y 3.
4. Corregir registry dashboard (filial 3 → linux).
5. Revisar este reporte en reunión de equipo para definir ventana de mantenimiento del central (martes o miércoles temprano, según política del plan maestro).

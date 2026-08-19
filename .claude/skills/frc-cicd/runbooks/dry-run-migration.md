# Dry-run de migración — procedimiento reutilizable

Valida que un JAR nuevo (beta/stable) pueda arrancar contra una DB de producción sin romper nada. Usa una instancia sandbox descartable.

## Cuándo usar

- Antes de migrar un grupo de hosts a un canal nuevo (e.g. bodega → stable).
- Cuando el JAR nuevo tiene migraciones Flyway significativas contra datos de producción.
- Cuando hay duda sobre compatibilidad de Java version o schema.

## Prerequisitos

- Una instancia sandbox disponible (servicio parado, DB descartable).
- Acceso SSH a la fuente (host productivo) y al sandbox.
- El JAR nuevo disponible en el sandbox.

## Procedimiento — Central

### 1. Preparar sandbox

```bash
# Parar servicio sandbox
sudo systemctl stop frc-<sandbox>.service

# Si la DB sandbox tiene replication slots, limpiarlos primero (ver gotchas.md)
# Parar filiales que conectan → terminate backends → drop slots → drop DB

# Recrear DB vacía
psql -p <cluster> -d postgres -c "DROP DATABASE IF EXISTS <db>;"
psql -p <cluster> -d postgres -c "CREATE DATABASE <db> OWNER franco;"
```

### 2. Copiar DB de producción

**Mismo host (distintos clusters):**
```bash
pg_dump -p <src_cluster> --no-publications --no-subscriptions <db_src> | psql -p <dst_cluster> -d <db_dst>
```

**Distinto host:**
```bash
# En origen: dump comprimido
pg_dump -p <port> --no-publications --no-subscriptions -Fc <db> -f /tmp/<db>.dump

# Transferir
scp franco@<origen>:/tmp/<db>.dump franco@<destino>:<path>/

# En destino: restore
pg_restore -p <port> -U franco -d <db> <path>/<db>.dump
```

### 3. Verificar copia limpia

```sql
SELECT * FROM pg_publication;    -- debe ser 0 rows
SELECT * FROM pg_subscription;   -- debe ser 0 rows
SELECT tgname, tgrelid::regclass FROM pg_trigger
  WHERE tgname LIKE '%repl%' OR tgname LIKE '%sync%';  -- debe ser 0 rows
```

### 4. Ajustar configuración del sandbox

En el `.env` o `application.properties` del sandbox:

- **Mantener:** datasource apuntando a la DB copiada, port del sandbox
- **Agregar:**
  - `REPLICATION_SYNC_ENABLED=false`
  - `REPLICATION_REFRESH_ENABLED=false`
- **SIFEN:** mantener `SIFEN_ENABLED=true` (no es desactivable, ver gotchas). Apuntar cert paths a una ubicación válida. Poner `SIFEN_SCHEDULER_ENABLED=false`.
- **Backup:** `BACKUP_ENABLED=false`

### 5. Test con JAR de producción (opcional, sanity check)

Si el sandbox usa distinta versión de Java que producción, ajustar `ExecStart` en el service file temporalmente. Arrancar, verificar que Flyway no aplica migraciones ("No migration necessary"), confirmar arranque OK. Parar.

### 6. Test con JAR nuevo (momento de verdad)

Restaurar Java version correcta para el JAR nuevo. Apuntar symlink/copiar JAR. Arrancar.

**Qué monitorear:**
- **Flyway:** ¿aplica migraciones? ¿Alguna falla?
- **Spring Boot:** ¿arranca completo? ("Started FrancoSystemsApplication in X seconds")
- **Healthcheck:** `curl localhost:<port>/actuator/health`

### 7. Documentar

Guardar resultados en `scans/<topic>-<fecha>/dry-run-<componente>.md`:
- Migraciones aplicadas (versión, descripción)
- Errores encontrados y workarounds
- Conclusión GO/NO-GO

## Procedimiento — Filial

Mismo flujo con estas diferencias:

- La DB suele llamarse `general` en todas las filiales.
- El dump es cross-host (usar `pg_dump -Fc` + SCP, no pipe directo).
- El JAR se llama `frc-filial-server.jar` (no `frc-central-server.jar`).
- Parámetros `-D` de arranque: `sucursalid`, `facturaCountDown`, `ipservidorcentral` deben coincidir con la filial fuente.
- En Windows: arrancar via batch file + PowerShell `Start-Process`, no `start /b` (ver gotchas).

## Errores conocidos en dry-runs

| Error | Causa | Fix |
|---|---|---|
| `publication "central_pub" does not exist` (V111.2) | DB copiada sin pubs | `CREATE PUBLICATION central_pub;` |
| `NoSuchBeanDefinitionException: SifenService` | `SIFEN_ENABLED=false` | Mantener `true`, solo desactivar scheduler |
| `{"status":"DOWN"}` en health | AMQP legacy en central | Ignorar — cosmético |
| FK constraint en `pg_restore` | Datos inconsistentes pre-existentes en fuente | Ignorar si es 1-2 errores no críticos |

## Primera ejecución registrada

- **2026-04-23:** dry-run bodega central + filial 24. Resultados en `scans/bodega-2026-04-23/dry-run-bodega-stable.md` y `dry-run-filial-stable.md`.

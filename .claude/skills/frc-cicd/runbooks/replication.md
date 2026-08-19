# Replicación PostgreSQL — estado actual y gotchas

## Arquitectura

- **Central** → publica en `central_pub` (logical replication publication) datos maestros que van a todas las filiales.
- **Cada filial** → publica en `filial<N>_pub` o `farmacia_filial<N>_pub` (naming varia por filial, ver abajo) datos de venta/cobro/conteo que viajan al central.
- **Central** → tiene subscription `filial<N>_sub` a cada filial. Pulls data from there.
- **Cada filial** → tiene subscription `central_sub` al central. Pulls master data.

## Schedulers en el código

El backend tiene dos scheduled jobs en `ReplicationPublicationSyncScheduler` y `ReplicationRefreshScheduler`:
- **sync** (cada 1h) → compara `configuraciones.replication_table` (meta-config) contra `pg_publication_tables`. Si falta una tabla en el publication, la agrega.
- **refresh** (cada 2h) → `ALTER SUBSCRIPTION ... REFRESH PUBLICATION`. Pull del schema más reciente del publisher.

Habilitados via env vars:
```
REPLICATION_SYNC_ENABLED=true
REPLICATION_REFRESH_ENABLED=true
```

## Estado actual (2026-04-22): DESHABILITADOS

En **central farmacia** + las **5 filiales farmacia**:
```
REPLICATION_SYNC_ENABLED=false
REPLICATION_REFRESH_ENABLED=false
```

**Por qué:** el código busca publications con el naming `farmacia_filial<N>_pub`, pero algunas filiales tienen el naming legacy `filial<N>_pub` (sin el prefix `farmacia_`). El scheduler no encuentra el pub esperado → genera error logs cada 5 segundos. Ruido alto, sin valor operacional.

**Decisión:** mantener OFF hasta normalizar el naming. No es crítico — la replicación en curso sigue funcionando con los subs/pubs que ya existen; solo pausa la auto-sincronización de nuevas tablas.

## Fix durable (pendiente)

Normalizar el naming con la operación `setupFullReplication(sucursalId=N)` vía GraphQL, por filial. Esto:
1. Dropea publications/subscriptions existentes.
2. Recrea con el naming esperado (`farmacia_filial<N>_pub`, `farmacia_filial<N>_sub`, etc.).
3. Marca las tablas correctas desde `configuraciones.replication_table`.

**Por qué no se hizo todavía:** requiere coordinación con cada filial (ventana de no-operación), y migraciones de datos en flight. Diferido hasta tener margen operativo.

## Tabla `evento_inutilizacion_de` — central-only

**Síntoma histórico:** filial 5 (la única con IP configurada en `empresarial.sucursal` del central) se quejaba de `relation "financiero.evento_inutilizacion_de" does not exist` al aplicar el publication.

**Por qué:** la tabla existe solo en central. Se había agregado erróneamente a `central_pub` en algún punto. Filiales no la tienen y fallaban al replicarla.

**Fix:** migración `V118__remove_inutilizacion_from_central_pub.sql` en el repo central:
```sql
ALTER PUBLICATION central_pub DROP TABLE financiero.evento_inutilizacion_de;
ALTER PUBLICATION central_pub DROP TABLE financiero.evento_inutilizacion_de_documento_electronico;
```

Ya mergeada en `master` + publicada en `v4.1.0-beta.3` del repo central. Aplicada al desplegar beta.3 al central farmacia.

## Issues abiertos de replicación (2026-07-23)

GitHub issues creados durante el fix bidireccional. Todos requieren cambio de código, NO operación de DB:

- **central #153** — race condition en generación de `id` de `movimiento_stock` (`findMaxId+1` no atómico) → colisiones de PK y **pérdida silenciosa de movimientos** (varias/día). Se ve en el log como N PIDs distintos fallando en el mismo segundo con ids contiguos impares. NO es rebote de replicación.
- **central #154** — `setupReplication` crea las pubs de subida SIN row filter y con `publish delete`: riesgo de que una fila con `sucursal_id` ajeno rompa el apply, y un DELETE en filial borra la fila en central.
- **central #155** — V118 incompleta: `evento_inutilizacion_de*` sigue en `central_filial{1,2,3}_pub` de farmacia → error permanente.
- **central #165 / filial #80** (par) — `movimiento_caja`: en central es peso muerto (0 filas propias, ~2.6M replicadas sin lector) → sacarla de la replicación branch→main; en filial reemplazar la validación de saldo por agregado on-demand (el cierre `PdvCajaService.generarBalance` ya lo hace sin la tabla) y dejar de materializarla. **Por esto NO se backfilleó `movimiento_caja` (Frente B cancelado).**
- **filial #77** — `inicio_sesion` colisión de PK entre filiales (`(504,0)`): entidad no sigue el patrón `@IdClass`+`findMaxId` de `Jornada`/`Marcacion`, resolver sin fallback, `/login` devuelve `sucursal.id=0`. 687 filas imposibles de replicar hasta el fix.
- **desktop #180 / mobile #78** — login no filtra `sucursal.id===0` antes de enviarlo (defensivo; el origen es el `/login` del filial).
- **filial #81** — el scheduler de sync de publicaciones reintenta `ALTER PUBLICATION ... ADD TABLE financiero.venta_tarjeta` cada ~5min; la tabla existe en central (vacía) pero NO en las filiales → error de log permanente en toda la flota. Ruido, no rompe nada, no cuenta en apply_error_count.
- **frc-cicd #4** — el dashboard no detecta filiales desconectadas (`apply_error_count` no sube ante fallos de conexión). **Ampliado 2026-07-23:** tampoco sirve el valor absoluto — `apply_error_count` es acumulado y no se resetea; filial 1 marcaba 16.455 estático con la sub al día. Usar **frescura** (`now()-last_msg_receipt_time`) Y **delta** del contador, no el absoluto.

## Diagnóstico: `apply_error_count` alto en una sub de bajada (central→filial)

Resuelto 2026-07-23 para `bodega_filial1_central_sub` (16.455). Método y conclusión, para no repetir la investigación:

1. **Chequear si SUBE o es estático** (dos lecturas con 60s). Si estático + sub al día (`last_msg_receipt_time` fresco, LSN corriente) → es **acumulado histórico**, no un problema activo. El contador nunca se resetea (`stats_reset` null).
2. **Ir al log del cluster de la filial.** En filiales bodega el PG corre en **Docker** (`logging_collector=off`, loguea a stderr): `sudo docker logs postgres 2>&1 | grep ERROR | sed 's/timestamp//' | sort | uniq -c | sort -rn`. Da el ranking de errores de toda la vida del cluster.
3. **Distinguir apply de replicación vs errores del backend Java.** Un STATEMENT con params posicionales (`insert into ... values ($1,$2,...)`) o un `ALTER PUBLICATION` es el **backend**, NO el apply worker. Solo los apply-worker errors inflan `apply_error_count`.
4. **Causas típicas del acumulado histórico (ya resueltas):**
   - **Schema drift transitorio:** `logical replication target relation X is missing replicated columns` — la filial estaba atrasada en una migración Flyway; central le replicaba columnas que la filial no tenía. Se autocorrige cuando el auto-update aplica la migración. Verificar comparando `information_schema.columns` de ambos nodos: si hoy coinciden, ya pasó.
   - **Duplicate key en tablas maestras** (`persona`, `cliente`, `timbrado_detalle`, `lote_de`): colisiones de bootstrap / churn bidireccional de cuando se armó la réplica.

## Findings de integridad sin issue todavía

## Findings de integridad sin issue todavía

- **`venta_item` con `presentacion_id` fantasma:** farmacia suc 1, presentación 5191 — central tiene 3 venta_item apuntándola pero la presentación no existe en ningún nodo. Venta con ítem que referencia catálogo inexistente. Excluida del backfill de bajada; pendiente diagnóstico.
- **Apply errors masivos central→filial:** bodega filial 1=16.455, farmacia filial 4=15.065, farmacia 2=3.653. **RESUELTO 2026-07-23 (bodega 1):** contador acumulado histórico (schema drift transitorio ya resuelto + duplicates de bootstrap), NO problema activo — la sub está al día. Ver "Diagnóstico" arriba. Farmacia 4 y 2 probablemente igual (mismo patrón); verificar con el mismo método si preocupa.
- **Reloj desfasado farmacia suc 1:** 587 ventas de ~2026-06-03 fechadas 2026-07-30/31 (confirmado por continuidad de id/referencia). Impacto contable probable en `venta`/factura/libro IVA.
- **Farmacia filial 2 sin ventas desde 2026-06-11** con replicación sana — la sucursal no opera o su POS está caído.

## Dar de baja una filial cerrada — procedimiento validado (2026-08-11, farmacia 2)

Aplica cuando una sucursal **cierra definitivamente**. Si solo está apagada, **no** hacer esto: se pierde el camino de replicación y hay que rehacerlo desde cero.

**Antes:** confirmar que no hay datos varados en la máquina. La señal es que la última fila replicada coincida con la fecha de cierre:
```sql
select max(creado_en) from operaciones.venta where sucursal_id = <id>;
```
Si hay actividad posterior a esa fecha en la filial, encender la máquina y dejar drenar **antes** de soltar nada.

**Gotcha central:** `DROP SUBSCRIPTION` intenta conectarse al publisher para borrar el slot remoto. Con la filial apagada, **se cuelga**. Hay que desacoplarlo primero:
```sql
ALTER SUBSCRIPTION filial_farmacia_<n>_sub DISABLE;
ALTER SUBSCRIPTION filial_farmacia_<n>_sub SET (slot_name = NONE);   -- ← sin esto, DROP se cuelga
DROP SUBSCRIPTION filial_farmacia_<n>_sub;

-- slots que la filial creó EN central (inactivos): liberan la retención de WAL
SELECT pg_drop_replication_slot('central_farmacia_<n>_sub');
SELECT pg_drop_replication_slot('central_filial_farmacia_<n>_sub');

DROP PUBLICATION central_filial<n>_pub;
UPDATE empresarial.sucursal SET activo=false WHERE id=<sucursal_id>;   -- se replica a toda la flota
```
Dejar registrado el `restart_lsn` y la última fila replicada antes de borrar — es el único rastro que queda del punto de corte.

**⚠️ Borrar slots NO garantiza liberar disco.** La retención de WAL la fija el **slot más antiguo**, no la suma de todos. Si otra filial caída tiene un `restart_lsn` más viejo, el WAL sigue anclado ahí y no baja ni un MB (verificado: tras soltar farmacia 2 el total quedó igual en 3680 MB, porque farmacia 5 anclaba desde una fecha anterior). Para saber quién manda:
```sql
select slot_name, active, pg_size_pretty(pg_current_wal_lsn() - restart_lsn)
from pg_replication_slots order by pg_current_wal_lsn() - restart_lsn desc;
```

## Fechar hace cuánto cayó una filial (sin acceso a la máquina)

Tres fuentes que hay que cruzar — dan fechas **distintas** y cada una significa otra cosa:

| Fuente | Qué mide |
|---|---|
| `max(creado_en)` de sus ventas en central | cuándo dejó de llegar lo que **produce** (dirección filial→central) |
| mtime del segmento de su `restart_lsn`, vía `pg_ls_waldir()` | cuándo dejó de **consumir** (dirección central→filial) |
| `pg_size_pretty(pg_current_wal_lsn() - restart_lsn)` | cuánto WAL acumuló desde entonces |

```sql
select name, modification, pg_size_pretty(size) from pg_ls_waldir()
where name = (select pg_walfile_name(restart_lsn) from pg_replication_slots where slot_name='<slot>');
```
`pg_ls_waldir()` funciona por SQL — **no hace falta acceso al filesystem** (el `data_directory` no es legible por `franco`).

En farmacia 2 las dos fechas diferían por 2 meses: consumía de central hasta el 10-ago, pero sus ventas no llegaban desde el 11-jun. Una filial puede estar viva y con **media replicación rota** — asumir que ambas direcciones cayeron juntas lleva a diagnósticos falsos.

## Slots y subs conocidos problemáticos

### `central12_sub` — slot INACTIVE con lag creciente

Observado durante el escaneo de central farmacia: slot con 2.4GB de lag acumulado y estado `INACTIVE`. Corresponde a una suscripción a una filial (probablemente 12 = bodega legacy) que ya no está operativa.

**Riesgo:** lag acumulado consume disco del central (WAL files no reciclan).

**Pendiente:** identificar si el publisher todavía existe. Si no, dropear el slot con `SELECT pg_drop_replication_slot('central12_sub');` tras confirmar con stakeholder.

### Publisher `172.25.1.14` unreachable

Observado en central: un sub intenta conectar a 172.25.1.14 cada 5 segundos y falla con "host unreachable". El IP no corresponde a ninguna filial actual en `empresarial.sucursal`.

**Pendiente:** identificar qué sub apunta a 172.25.1.14. Drop de ese sub si el publisher ya no existe.

## Tabla `empresarial.sucursal` — sensible

Contiene el catálogo de sucursales con IP + puerto + activo. Los schedulers de replicación usan esta info para saber a qué publishers conectarse.

**Gotcha:** si se clona la DB de central a un ambiente de staging sin actualizar `empresarial.sucursal`, el staging va a intentar conectarse a las IPs productivas y armar replication contra los pubs reales. **Cada vez que se clona una DB, revisar y limpiar esta tabla antes de arrancar el server.**

## Migraciones Flyway que tocan publicaciones

### V111.2 (central) — `disable_truncate_replication`
```sql
ALTER PUBLICATION central_pub SET (publish = 'insert, update, delete')
```
Falla si `central_pub` no existe (e.g. DB restaurada con `--no-publications`). En producción siempre existe. Para dry-runs/staging: `CREATE PUBLICATION central_pub;` antes de arrancar.

### V62.4 (filial) — `disable_truncate_replication`
Versión filial de la misma migración. NO referencia `central_pub` — usa lógica diferente. No requiere workaround.

### V118 / V119 (central) — operaciones sobre `central_pub`
Remueven/agregan tablas a `central_pub`. Misma dependencia: la publicación debe existir.

## Copia de datos cross-nodo (dblink) — técnica probada

Para copiar filas entre nodos que YA tienen replicación lógica activa (backfill de una tabla que se dejó de replicar, restaurar una filial, mover ventas filial→central), el patrón usado en producción es **dblink**, no `pg_dump`. Runbook de referencia guardado: `restauracion_filial_25.sql` en el dashboard host, `~/DEV-FRC/frontend/frc-sistemas-integrados-angular/` (restauración completa de una filial desde cero, con orden de carga por niveles de FK).

- **Extensión `dblink` instalada** en el cluster bodega (5552) del central. Verificar en cada nodo destino antes (`select extname from pg_extension`).
- Patrón: `INSERT INTO schema.tabla SELECT * FROM dblink('host=... port=... dbname=... user=franco password=franco', 'SELECT * FROM schema.tabla WHERE ...') AS t1(<lista tipada de columnas>);` — la lista tipada de columnas es obligatoria y debe calcarse del `\d` de la tabla origen (incluye tipos enum con schema, e.g. `operaciones.tipo_entrada`).
- **Orden por niveles de FK** (0=sin deps → 5): cargar maestras antes que dependientes. El runbook_25 tiene el orden completo documentado con checklist de progreso.
- Duplicados: `ON CONFLICT DO NOTHING` cuando puede haber solapamiento.
- **Peligro de bidireccionalidad (CLAVE):** si el nodo destino tiene una publication propia que incluye la tabla (e.g. filial `bodega_filialN_pub` incluye `movimiento_stock`), el INSERT del backfill se captura y **replica de vuelta al otro nodo** → duplica/conflictúa. Para evitarlo, marcar la sesión de backfill con un **replication origin**: `SELECT pg_replication_origin_session_setup('backfill_x')` dentro de la transacción. Funciona porque las subs del otro lado son `origin=none` y filtran cambios con origin marcado. **NO usar `session_replication_role = replica`** — eso desactiva triggers pero NO evita que el walsender capture el write en réplica lógica nativa (ver gotcha específico en gotchas.md; era un error de una versión vieja de este doc). Alternativa más burda: quitar temporalmente la tabla de la pub del destino.
- **Anti-join por PK, no ventana de tiempo.** Comparar/filtrar por la PK real con `NOT EXISTS` (la PK es COMPUESTA `(id, sucursal_id)` en las transaccionales). Traer solo los `id` primero, después las filas completas de esos `id`. El screening por `count(*)` subestima (ver gotchas.md).
- **`ALTER PUBLICATION ADD TABLE` en autocommit**, ANTES del `REFRESH` — si el ADD va en un `DO` no commiteado y el REFRESH sale por `dblink_exec` (otra sesión), el refresh no ve la tabla y la sub queda sin ella (silencioso). Verificar `pg_subscription_rel.srsubstate='r'`.
- **`dblink` en filiales está en el schema `general`** (calificar `general.dblink(...)`); en central es `dblink(...)`. Naming de sub filial→central: bodega `bodega_filialN_central_sub`, farmacia `central_farmacia_N_sub` (invertido) — identificar la conexión a central por host `172.25.1.200`, no por nombre.
- Secuencias: tras cargar, `setval` de las secuencias afectadas si la tabla usa serial (movimiento_stock NO — usa IDs generados por app, impares central / pares filial, sin colisión).

## Backfill bidireccional central↔filial — procedimiento validado (2026-07)

Reparación de la réplica bidireccional de bodega + farmacia (`movimiento_stock` causa raíz + Frente A: ventas/cobros/facturas/documentos huérfanos en ambas direcciones). Runbook de referencia en el repo `frc-cicd`: `runbook-sync-bidireccional-central-filial.md`.

- **Causa raíz de la de bajada:** `configuraciones.replication_table.replicate_central_to_branch_with_filter` en `false` para `movimiento_stock` → `setupReplication` reconstruyó las pubs `central_bodega_filialN_pub` sin la tabla (2026-04-23). Corregido a `true` en bodega Y farmacia (en farmacia era bomba de tiempo: sus pubs estaban sanas solo por no haberse regenerado). **Verificar SIEMPRE contra `pg_publication_tables`, no contra la meta-config** (la meta-config no refleja la realidad).
- **Fase 1 (estructura):** `ALTER PUBLICATION ... ADD TABLE ... WHERE (sucursal_id=N)` (autocommit) + `ALTER SUBSCRIPTION ... REFRESH PUBLICATION WITH (copy_data=false)`. `copy_data=false` OBLIGATORIO (con `true` choca con las filas ya presentes y rompe la sub).
- **Fase 2 (backfill):** transacción única por filial, con replication origin, anti-join por PK, `ON CONFLICT DO NOTHING`. Idempotente.
- **Subida filial→central (más delicada, escribe en la fuente de verdad):** cargar TODAS las tablas de la pub de la filial en **orden de FK** (`cobro → venta → venta_item → factura_legal_item`; `cobro → cobro_detalle`; independientes: `factura_legal`, `documento_electronico`, `movimiento_stock`). Validar FK contra central ANTES (padres ausentes = como filial 4 bodega, faltaba catálogo). Excluir tablas de estado (`stock_por_producto_sucursal`, se reconcilia pisando no insertando) y las de PK sin `sucursal_id` (`maletin`).
- **Verificación por filial:** anti-join en 0, `apply_error_count` sin cambios en ambos lados (baseline antes), y chequeo en el log del cluster (`journalctl -u postgresql-beta`) de que no aparezcan `duplicate key` nuevos. Con `ON CONFLICT DO NOTHING` un duplicate key en el log NO puede ser del backfill → es otra cosa (p.ej. la race de `movimiento_stock` en central, issue #153).

## Checklist al reactivar schedulers (post-normalización naming)

- [ ] Todos los pubs de filiales con naming `farmacia_filial<N>_pub` y `farmacia_filial<N>_slot`.
- [ ] Todos los subs del central apuntan a filiales con IPs actuales y activas.
- [ ] `configuraciones.replication_table` refleja las tablas a replicar (no más ni menos).
- [ ] `evento_inutilizacion_de*` fuera de `central_pub`.
- [ ] Slots muertos (`central12_sub`, etc.) dropeados.
- [ ] En `.env` de central: `REPLICATION_SYNC_ENABLED=true`, `REPLICATION_REFRESH_ENABLED=true`.
- [ ] En `.env` de cada filial: idem.
- [ ] Restart de servicios y observación de logs por 1h sin errores.

## Chequeo rápido de salud post-deploy (validado 2026-08-13)

Después de aplicar migraciones en central o filial, la pregunta es una sola: **¿algún
apply worker quedó en crash-loop?** El síntoma clásico es
`missing replicated columns` — central emite DML con columnas que la filial no tiene,
porque **la replicación lógica no propaga DDL**.

No hace falta entrar a cada filial. **Se diagnostica entero desde central**, mirando los
slots: un worker sano mantiene su slot `active` y el WAL retenido en decenas de bytes;
uno en crash-loop deja el slot **inactivo y el contador creciendo**.

```bash
# dos muestras separadas ~45s: lo que importa es si 'bytes' crece
psql -h localhost -p 5551 -d farmacia -qAtX -F'|' -c "
  SELECT slot_name, active,
         pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS bytes
  FROM pg_replication_slots
  WHERE slot_name NOT LIKE 'bodega%'
  ORDER BY slot_name"
```

Lectura del resultado:

| Patrón | Significa |
|---|---|
| `active=t`, decenas de bytes, estable entre muestras | sano (es el heartbeat normal) |
| `active=f`, bytes **creciendo** | worker caído **y** el publisher sigue generando → investigar ya |
| `active=f`, bytes **congelados** | suscriptor apagado sin tráfico nuevo. No empeora mientras siga abajo |

Complemento (el otro sentido, filial→central):

```bash
psql ... -c "
  SELECT s.subname, s.subenabled, (st.pid IS NOT NULL) AS worker_vivo,
         st.last_msg_receipt_time::timestamp(0)
  FROM pg_subscription s
  LEFT JOIN pg_stat_subscription st ON st.subname = s.subname
  WHERE s.subname NOT LIKE 'bodega%' ORDER BY s.subname"
```

`last_msg_receipt_time` de hace segundos = al día.

> **Gotcha del filtro:** conectado a la DB `farmacia` también se ven las subs
> `bodega_*` (deshabilitadas, sin worker). Sin el `NOT LIKE 'bodega%'` parece que
> hubiera media docena de subs rotas.

> **Gotcha de `max(version)` en Flyway:** `flyway_schema_history.version` es **texto**,
> así que `max(version)` devuelve `'99.5'` en vez de `'197.5'`. Para saber hasta dónde
> llegó una migración, ordenar por `installed_rank DESC`, no por `version`.

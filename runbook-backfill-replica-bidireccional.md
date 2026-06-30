# Runbook — Backfill de un gap de réplica lógica sin romper la bidireccional

Cómo rellenar datos faltantes en el **central** cuando una suscripción filial→central estuvo congelada/salteada un tiempo (gap), **sin que las filas insertadas reboten a la filial** por la réplica inversa.

Caso de referencia: **filial 5 bodega**, gap del 26–28 jun 2026 (~9.500 filas en 17 tablas). Resuelto el 2026-06-30.

---

## 1. Contexto: por qué el insert directo es peligroso

La réplica de bodega es **bidireccional** (réplica lógica nativa de PostgreSQL):

- **filial → central**: `bodega_filialN_pub` (en la filial) → `bodega_filialN_sub` (en el central).
- **central → filial**: `central_pub` y `central_bodega_filialN_pub` (en el central) → 2 subs en la filial. **Todas `origin = none`.**

Algunas tablas se re-publican **central → filial** (en bodega: `operaciones.venta`, `operaciones.venta_item`, `financiero.factura_legal`, `financiero.factura_legal_item`). Si insertás esas filas directo en el central, viajan de vuelta a la filial → **choque de clave duplicada** (ya existen ahí) → rompe el stream inverso.

**Solución:** insertar dentro de una sesión marcada con un **replication origin**. Como las subs de la filial son `origin = none`, filtran cualquier cambio que llegue con un origin marcado → **no rebota**.

> Endpoints y credenciales: ver `.env` local (NO versionado). Central bodega real = `:5552` db `bodega` (el `:5551` es un cluster legacy con subs deshabilitadas). Filiales = `:5551` db `general` (Postgres en Docker).

---

## 2. Diagnóstico del gap (solo lectura)

Conectarse por TCP a ambos lados (`psql "postgresql://franco:***@HOST:PUERTO/DB"`).

**a) Confirmar que la sub forward está viva pero hubo skip** (central):
```sql
SELECT s.subname, s.subenabled, st.pid IS NOT NULL AS worker,
       ss.apply_error_count
FROM pg_subscription s
LEFT JOIN pg_stat_subscription st ON st.subname=s.subname
LEFT JOIN pg_stat_subscription_stats ss ON ss.subname=s.subname
WHERE s.subname='bodega_filialN_sub';
```
`apply_error_count` alto + sub enabled = hubo conflicto en loop (síntoma del skip).

**b) Medir el déficit por tabla** (ventana absoluta UTC, idéntica en ambos servidores para evitar líos de timezone). Comparar `count(*)` filial vs central por tabla de la publicación, filtrando `sucursal_id=N` y la ventana del gap. La diferencia = filas faltantes.

**c) Confirmar que la cabeza está al día**: `max(creado_en)` igual en ambos lados ⇒ el hueco es histórico, no pérdida en curso.

**d) Forma del hueco**: un bloque **contiguo de `id` salteado** (filas antes y después presentes) confirma "transacciones omitidas", no fallo difuso.

---

## 3. Preparación

1. **Mapear FKs entre las tablas afectadas** para definir el orden de inserción (padres antes que hijos):
   ```sql
   SELECT (ns.nspname||'.'||cl.relname) AS hijo, (nsf.nspname||'.'||clf.relname) AS padre
   FROM pg_constraint con
   JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
   JOIN pg_class clf ON clf.oid=con.confrelid JOIN pg_namespace nsf ON nsf.oid=clf.relnamespace
   WHERE con.contype='f' AND (ns.nspname||'.'||cl.relname) = ANY(<tablas afectadas>);
   ```
   Orden usado en filial 5:
   `conteo → conteo_moneda → delivery → cobro → pdv_caja → movimiento_caja → gasto → retiro → retiro_detalle → cobro_detalle → venta → venta_item → factura_legal → factura_legal_item → venta_credito → venta_credito_cuota → movimiento_stock`

2. **Verificar paridad de columnas** filial vs central de cada tabla (un desfasaje posicional corrompe datos en silencio):
   ```sql
   SELECT string_agg(column_name,',' ORDER BY ordinal_position)
   FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2;
   ```
   Deben ser idénticas en ambos lados.

3. **Identificar qué tablas se re-publican central→filial** (las que rebotarían). El origin trick se usa para TODA la carga igual, pero es bueno saber dónde está el riesgo real:
   ```sql
   SELECT schemaname||'.'||tablename, string_agg(pubname,', ')
   FROM pg_publication_tables
   WHERE pubname IN ('central_pub','central_bodega_filialN_pub')
     AND schemaname||'.'||tablename = ANY(<tablas afectadas>)
   GROUP BY 1;
   ```

---

## 4. Backfill (escritura) — método

### 4.1 Validar primero con un piloto chico
Empezar por **1 tabla chica** (ej. `financiero.pdv_caja`, ~10 filas) + sus padres FK. Después un **checkpoint sobre una tabla re-publicada** (`operaciones.venta`, slice de ~5 filas) — esa es la prueba real del filtro de origin. Verificar (sección 5) antes de seguir.

### 4.2 Dump desde la filial (CSV)
Por tabla, en orden FK, ventana del gap:
```bash
psql "$FILIAL" -c "\copy (SELECT * FROM <tabla> WHERE creado_en >= 'INI+00' AND creado_en < 'FIN+00' AND sucursal_id=N) TO '/tmp/bf_xx.csv' CSV"
```

### 4.3 Carga en el central — UNA transacción atómica con origin
```sql
\set ON_ERROR_STOP on
-- crear el origin una sola vez:
SELECT pg_replication_origin_create('backfill_filialN')
  WHERE NOT EXISTS (SELECT 1 FROM pg_replication_origin WHERE roname='backfill_filialN');

BEGIN;
SELECT pg_replication_origin_session_setup('backfill_filialN');   -- ← clave anti-rebote

-- repetir por tabla EN ORDEN FK:
CREATE TEMP TABLE tmp_x (LIKE <schema.tabla>) ON COMMIT DROP;
\copy tmp_x FROM '/tmp/bf_xx.csv' CSV
INSERT INTO <schema.tabla> SELECT * FROM tmp_x ON CONFLICT DO NOTHING;
-- ...

COMMIT;
SELECT pg_replication_origin_session_reset();
```

Notas:
- `ON CONFLICT DO NOTHING` salta las filas ya presentes (idempotente; se puede re-correr).
- Tablas temporales `ON COMMIT DROP` → no se publican ni dejan rastro.
- Todo en una transacción: si una FK falla, **rollback total**.
- `franco` es superuser en el central (requerido para las funciones de replication origin).

---

## 5. Verificación post-backfill

**a) Déficit = 0 por tabla** (mismo conteo de ventana filial vs central).

**b) La filial NO recibió rebotes** (lo más importante) — comparar contra el baseline tomado ANTES:
```sql
-- en la FILIAL:
SELECT subname, apply_error_count, sync_error_count
FROM pg_stat_subscription_stats
WHERE subname LIKE '%filialN%';        -- apply_error_count NO debe subir
```
Workers inversos vivos (`pid` no nulo, `last_msg_receipt_time` reciente) y filas insertadas **únicas** en la filial (sin duplicar).

**c) Integridad de datos** — checksum **TZ-independiente** (los timestamptz se renderizan distinto según el timezone de sesión de cada server; usar epoch):
```sql
SELECT md5(string_agg(id||'|'||extract(epoch FROM creado_en)||'|'||..., ',' ORDER BY id))
FROM <tabla> WHERE sucursal_id=N AND id IN (<ids insertados>);
```
Debe coincidir filial vs central.

**d) Seguir el log de la filial en vivo** durante la carga (Postgres en Docker, `logging_collector=off`):
```bash
docker logs -f --tail 30 <contenedor_postgres> 2>&1 \
  | grep --line-buffered -iE 'ERROR|duplicate key|conflict|apply'
```
Si el filtro de origin funciona, **no aparece ningún `duplicate key`**.

---

## 6. Casos límite

- **Excedente en el central (central tiene más que la filial):** no necesariamente un error. Verificar el origen de esas filas. En bodega, `operaciones.movimiento_stock` tipo `COMPRA`/`TRANSFERENCIA`/`AJUSTE` se genera **en el central** (la filial solo tiene `VENTA`) → son legítimas, **no borrar**.
- **Tablas de estado** (ej. `stock_por_producto_sucursal`): no son append-only; un gap pierde UPDATEs. Reconciliar pisando valores, no insertando. (En bodega esta tabla está vacía.)
- **DELETEs durante el gap:** filas borradas en la filial cuyo DELETE se salteó quedan "de más" en el central. Detectar con anti-join central→filial. Confirmar caso por caso antes de borrar.

---

## 7. Prevención

Poner **`disable_on_error = true`** en las suscripciones:
```sql
ALTER SUBSCRIPTION bodega_filialN_sub SET (disable_on_error = true);
```
Así, ante un conflicto de apply, la suscripción **se desactiva y queda visible** (el dashboard frc-cicd lee `apply_error_count`), en vez de quedar en loop infinito y forzar un skip destructivo que genera el gap.

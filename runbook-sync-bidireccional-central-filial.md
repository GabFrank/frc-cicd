# Runbook — Sincronización bidireccional central↔filial de tablas transaccionales

Cómo detectar y reparar huecos de datos en la réplica lógica bidireccional (central↔filial) de las tablas transaccionales de FRC (`movimiento_stock`, `venta`, `venta_item`, `cobro`, `cobro_detalle`, `factura_legal`, `factura_legal_item`, `documento_electronico`, `retiro`, etc.), sin que las escrituras del backfill reboten al otro nodo.

Caso de referencia: reparación de bodega + farmacia, 2026-07-20 a 2026-07-23. `movimiento_stock` había dejado de replicarse central→filial en la red bodega desde 2026-04-23; además aparecieron huecos de subida filial→central (ventas/cobros/facturas huérfanos del cutover) en ambos entornos.

> Endpoints y credenciales: `.env` local del repo (NO versionado). Central bodega = `172.25.1.200:5552` db `bodega`; central farmacia = `:5551` db `farmacia`. Filiales bodega = `:5551` db `general`; filiales farmacia = `:5551` db `general`. `franco` es superuser en central (requerido para replication origin).

---

## 0. Conceptos que hacen falta antes de tocar nada

**La PK de las tablas transaccionales es COMPUESTA `(id, sucursal_id)`.** Cada sucursal reusa el mismo espacio de `id`. Joinear/deduplicar por `id` solo da basura. Todo anti-join y `ON CONFLICT` va por la PK completa. Verificar la PK real con `pg_constraint`/`conkey`, no asumirla.

**La réplica es bidireccional.** Cada filial publica hacia central (`bodega_filialN_pub` / `filial_farmacia_N_pub`) y central publica hacia la filial (`central_bodega_filialN_pub` / `central_filial_farmacia_N_pub`). Todas las subs son `origin = none`.

**Anti-rebote = replication origin, NO `session_replication_role`.** Ver §3.

**Verificar contra `pg_publication_tables`, nunca contra `configuraciones.replication_table`.** La meta-config no refleja la realidad (dice `false` para tablas que igual replican, y viceversa).

---

## 1. Diagnóstico del hueco (solo lectura)

**a) ¿Qué publica realmente cada nodo?**
```sql
SELECT pubname, count(*) AS tablas,
       bool_or(tablename='<tabla>') AS tiene_la_tabla
FROM pg_publication_tables WHERE pubname LIKE 'central_%filial%'
GROUP BY pubname ORDER BY pubname;
```

**b) Medir el hueco por ANTI-JOIN de PK, no por `count(*)`.** El conteo subestima (en el caso de referencia dio 1.757 cuando el real era 3.185, −45%): los conteos coinciden por casualidad o los huecos de ambas direcciones se compensan. Por cada (filial, tabla):
```sql
-- filas en el ORIGEN que NO están en el DESTINO, por PK compuesta
SELECT count(*) FROM <origen> o
WHERE o.sucursal_id = N
  AND NOT EXISTS (SELECT 1 FROM dblink('<destino>', 'SELECT id, sucursal_id FROM <tabla>')
                    AS d(id bigint, sucursal_id bigint)
                  WHERE d.id=o.id AND d.sucursal_id=o.sucursal_id);
```
Para eficiencia: traer solo los `id` (liviano), calcular faltantes, y recién traer las filas completas de esos `id`.

**c) Verificar el estado de la subscription, no solo el conteo.** Una tabla puede estar en la publication y NO en la subscription (ver §2, trampa del REFRESH):
```sql
SELECT c.relname, sr.srsubstate  -- 'r' = ready
FROM pg_subscription_rel sr
JOIN pg_class c ON c.oid=sr.srrelid
JOIN pg_subscription s ON s.oid=sr.srsubid
WHERE s.subname='<sub de bajada>';
```

**d) Excluir filiales apagadas** del recorrido (`subenabled=true` pero inalcanzables cuelgan el loop): filtrar por nombre en el `WHERE` y usar `connect_timeout=8`.

---

## 2. Estructura — restaurar la tabla en la réplica (bajada central→filial)

Causa raíz del caso bodega: `setupReplication` reconstruyó las pubs sin la tabla porque `replication_table.replicate_central_to_branch_with_filter` estaba en `false`. Corregir primero la meta-config (cosmético hoy con schedulers OFF, pero evita que se repita):
```sql
UPDATE configuraciones.replication_table
SET replicate_central_to_branch_with_filter = true
WHERE table_name = 'operaciones.movimiento_stock';   -- en bodega Y farmacia
```

Por filial N:
```sql
-- en central, AUTOCOMMIT (sentencia suelta, no dentro de un DO):
ALTER PUBLICATION central_bodega_filialN_pub
  ADD TABLE operaciones.movimiento_stock WHERE (sucursal_id = N);
```
```sql
-- en la filial:
ALTER SUBSCRIPTION central_bodega_filialN_sub REFRESH PUBLICATION WITH (copy_data = false);
```

⚠️ **`copy_data = false` OBLIGATORIO** — con `true`, PG intenta copiar todo el histórico, choca con las filas que la filial ya tiene (PK duplicada) y rompe la sub.

⚠️ **El `ALTER PUBLICATION` debe COMMITEAR antes del REFRESH.** Si el ADD va dentro de un bloque `DO` no commiteado y el REFRESH sale por `dblink_exec` (otra sesión), el refresh lee la pub vieja → la sub queda SIN la tabla aunque la pub SÍ la tenga. El backfill histórico funciona igual (dblink directo) pero la replicación en vivo no fluye, en silencio. Verificar siempre con `srsubstate='r'`.

---

## 3. Backfill sin rebote — replication origin

El nodo destino tiene su propia publication que incluye la tabla, así que un INSERT normal se captura y **rebota al otro nodo**, duplicando/conflictuando.

**Solución: marcar la sesión con un replication origin.** Las subs del otro lado son `origin=none` y filtran cualquier cambio con origin marcado.

```sql
-- crear el origin una vez:
SELECT pg_replication_origin_create('backfill_x')
  WHERE NOT EXISTS (SELECT 1 FROM pg_replication_origin WHERE roname='backfill_x');

BEGIN;
SELECT pg_replication_origin_session_setup('backfill_x');   -- ← clave anti-rebote

INSERT INTO <tabla>
SELECT t.* FROM dblink('<origen>', 'SELECT <cols> FROM <tabla> WHERE sucursal_id=N AND id IN (<ids faltantes>)')
  AS t(<lista tipada de columnas>)
WHERE NOT EXISTS (SELECT 1 FROM <tabla> c WHERE c.id=t.id AND c.sucursal_id=t.sucursal_id)
ON CONFLICT DO NOTHING;

COMMIT;
SELECT pg_replication_origin_session_reset();
```

**NO usar `SET session_replication_role = replica`** — desactiva triggers pero NO evita que el walsender capture el write en réplica lógica nativa. Es el mecanismo de Slony/Bucardo, no de la réplica nativa de PG.

Detalles de dblink: la extensión vive en el schema **`general`** en las filiales (calificar `general.dblink(...)`), en `dblink(...)` a secas en central. La lista tipada de columnas es obligatoria y debe calcarse del catálogo (incluye enums calificados con schema, ej. `operaciones.tipo_movimiento`).

---

## 4. Subida filial→central — la dirección delicada

Escribe en central, que es la fuente de verdad (alimenta contabilidad y SIFEN). Extra cuidado:

- **Cargar TODAS las tablas de la pub de la filial en ORDEN DE FK**, no solo una. Lo perdido suelen ser ventas enteras, no movimientos sueltos (si falta `venta`, faltan sus `venta_item` y su `factura_legal`). Orden del caso de referencia:
  ```
  cobro → venta → venta_item → factura_legal_item
  cobro → cobro_detalle
  pdv_caja → retiro → retiro_detalle
  independientes: factura_legal, documento_electronico, movimiento_stock, gasto, lote_de
  ```
- **Validar FK contra central ANTES de escribir.** Un padre externo ausente (`producto`, `presentacion`, `pdv_caja`, `cliente`) rompe el insert — es lo que pasó con filial 4 bodega (faltaba una subfamilia + 2 productos). Distinguir "padre en el set de carga" (se carga antes, OK) de "padre externo ausente" (hay que completarlo o excluir la fila).
- **Una transacción por filial**, todo adentro. Si algo falla, rollback total; nada de una venta sin sus items.
- **Excluir:** tablas de estado (`stock_por_producto_sucursal` — se reconcilia pisando valores, no insertando) y tablas de PK sin `sucursal_id` (`maletin`).
- **Datos corruptos en el origen:** filas cuyo padre no existe en NINGÚN nodo (ej. `venta_item` con `presentacion_id` fantasma) — excluir del backfill y reportar aparte, no forzar un padre falso.

---

## 5. Verificación post-backfill

**a) Anti-join en 0** por PK, por tabla, para esa filial (§1.b).

**b) `srsubstate='r'`** para la tabla en la subscription (§1.c) — que la replicación en vivo también fluya, no solo el histórico.

**c) Sin rebote — por tres vías:**
- `apply_error_count` de las subs sin cambios respecto del baseline tomado ANTES (en AMBOS nodos).
- En el log del cluster (`journalctl -u postgresql-beta.service` para bodega): no aparecen `duplicate key` nuevos. **Con `ON CONFLICT DO NOTHING` un `duplicate key` en el log NO puede ser del backfill** → es otra cosa (ej. la race condition de `movimiento_stock` en central).
- Conteos por tipo filial vs central coinciden.

**d) Naming de subs (INVERTIDO entre entornos):** bodega `bodega_filialN_central_sub`, farmacia `central_farmacia_N_sub`. No adivinar el nombre — identificar la conexión a central por host (`subconninfo LIKE '%host=172.25.1.200%'`).

---

## 6. Lo que NO se resuelve con backfill

- **`inicio_sesion`** — colisión de PK entre filiales (`(504,0)`): las filas ya existentes son imposibles de insertar (la PK está ocupada en central). Requiere fix de código (issue filial #77).
- **`movimiento_caja`** — decidido NO backfillear: en central es peso muerto y en filial se va a reemplazar por validación on-demand (issues central #165 / filial #80).

Ver la skill `frc-cicd` (`runbooks/replication.md`) para la lista completa de issues abiertos y findings de integridad.

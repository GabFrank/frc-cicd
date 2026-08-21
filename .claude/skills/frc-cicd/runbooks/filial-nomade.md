# Filial nómade — bajar y reincorporar la replicación

Para filiales que operan por temporadas o eventos y están apagadas la mayor parte del año.
Hoy aplica a **Suc. Fiesta (`sucursal_id=25`, `172.25.1.26`)**, bodega.

## Por qué existe este modelo

Una filial dormida que conserva sus suscripciones **ancla WAL en el central productivo para
siempre**. El slot no avanza, y PostgreSQL no puede reciclar ningún segmento posterior a su
`restart_lsn`. Medido el 2026-08-21 en Suc. Fiesta: **11 GB retenidos desde el 2026-08-14**, que
era el 99% del WAL del cluster bodega entero. Al soltarla, el cluster pasó a 80 MB.

**Deshabilitar la suscripción NO alcanza.** Una sub `DISABLE` cuyo slot sigue existiendo ancla
WAL exactamente igual. Lo que libera disco es **dropear el slot**.

## Baja — hacerla con la máquina PRENDIDA

Con la filial encendida y en red, cada `DROP SUBSCRIPTION` se conecta al publicador y limpia su
slot remoto solo. Con la filial apagada, el `DROP` **se cuelga** y hay que desacoplarlo a mano
(`ALTER SUBSCRIPTION ... SET (slot_name = NONE)` primero) y después borrar los slots huérfanos
uno por uno. Mucho más trabajo y más riesgo.

### Paso 0 — confirmar que no hay datos varados

Innegociable. Comparar lo que la filial tiene contra lo que llegó a central:

```sql
-- en la filial y en central, mismo query
select 'venta' t, count(*), max(creado_en) from operaciones.venta where sucursal_id=<N>
union all
select 'cobro', count(*), max(creado_en) from operaciones.cobro where sucursal_id=<N>;
```

Lo que importa es que **el `max(creado_en)` coincida**. Los `count` pueden diferir legítimamente
(central acumula histórico que la filial purgó o perdió en una reinstalación). Si la filial tiene
datos más nuevos que central, **dejar drenar antes de soltar nada**.

### Paso 1 — en la FILIAL: dropear sus suscripciones a central

Libera los slots que anclan WAL en central. `DROP SUBSCRIPTION` no corre dentro de una
transacción: una sentencia por `-c`.

```bash
psql -p 5551 -d general -c 'DROP SUBSCRIPTION bodega_filial<N>_central_sub'   # ← el de central_pub, el que ancla
psql -p 5551 -d general -c 'DROP SUBSCRIPTION central_bodega_filial<N>_sub'   # ← el filtrado por sucursal
```

Cada uno debe responder `NOTICE: eliminando el slot de replicación «...» en publicador`. Si no
aparece ese NOTICE, el slot quedó en central y hay que borrarlo a mano.

### Paso 2 — en CENTRAL: dropear la suscripción hacia la filial

```bash
psql -h localhost -p 5552 -d bodega -c 'DROP SUBSCRIPTION bodega_filial<N>_sub'
```

### Paso 3 — verificar

```sql
-- en central: no debe quedar NADA con el numero de la filial
select slot_name, active from pg_replication_slots where slot_name like '%<N>%';
select subname from pg_subscription where subname like '%<N>%';

-- y el WAL tiene que haber bajado
select pg_size_pretty(sum(size)) from pg_ls_waldir();
```

**Las publicaciones se dejan en pie** (`central_bodega_filial<N>_pub` en central,
`bodega_filial<N>_pub` en la filial). Una publicación sin suscriptor no retiene WAL ni cuesta
nada, y `setupFullReplication` las recrea igual cuando la filial vuelve.

## Reincorporación — ANTES del evento, no después

Esta es la mitad riesgosa. **Mientras no replique, todo lo que la filial produzca queda varado en
la máquina**, así que reconectarla después de operar significa reconciliar a mano.

### Paso A — paridad de schema, antes de tocar la replicación

Una filial que estuvo meses afuera acumuló drift, y la replicación lógica **no propaga DDL**.
Verificar contra central antes de reconectar:

```sql
-- enums: comparar labels de los tipos publicados
select t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
  from pg_enum e join pg_type t on t.oid = e.enumtypid
 group by t.typname order by 1;

-- columnas de las tablas publicadas
select table_schema, table_name, column_name from information_schema.columns
 where (table_schema, table_name) in (select schemaname, tablename from pg_publication_tables);
```

Cualquier diferencia se arregla **en la filial y de forma aditiva** antes de reconectar. Un label
de enum faltante rompe el apply worker en crash-loop (ver el gotcha del enum `tipo_dispositivo`).

> Suc. Fiesta quedó fuera del barrido del enum del 2026-08-21 porque no está en el `.env` ni
> estaba en el inventario. **Tiene el enum viejo.** Al reincorporarla, aplicar:
> ```sql
> ALTER TYPE configuraciones.tipo_dispositivo ADD VALUE IF NOT EXISTS 'WEB';
> ALTER TYPE configuraciones.tipo_dispositivo ADD VALUE IF NOT EXISTS 'WEB_MOBILE';
> ```

### Paso B — dejar que aplique el backlog de migraciones, mirando

Al arrancar el JAR aplica de una vez todas las migraciones acumuladas del canal. **No dejarlo
correr desatendido**: si una falla, el server queda a medias y la filial no sirve para el evento.
Arrancar el servicio y seguir el log hasta ver que Flyway terminó.

### Paso C — recrear la replicación

`setupFullReplication(sucursalId=<N>)` vía GraphQL. **Es destructivo por diseño**: su Paso 0
dropea sub/pub/slot, y si el Paso 7 falla la filial queda sin replicación. Ya causó pérdida de
datos en la filial 24 de bodega el 2026-04-23. Con la filial recién reincorporada y sin datos
propios pendientes el riesgo es bajo, que es justamente por qué conviene hacerlo **antes** de
que empiece a vender.

### Paso D — verificar antes de habilitar la caja

```sql
-- en central: los 3 canales arriba y con worker
select s.subname, s.subenabled, (st.pid is not null) as worker, st.last_msg_receipt_time
  from pg_subscription s left join pg_stat_subscription st using (subname)
 where s.subname like '%<N>%';

-- slots en decenas de bytes, no creciendo
select slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
  from pg_replication_slots where slot_name like '%<N>%';
```

Y confirmar que `pg_subscription_rel.srsubstate = 'r'` para las tablas que importan — una tabla
puede estar en la publicación y no en la suscripción, en silencio.

## Checklist de cierre del evento

- [ ] Confirmar que las ventas del evento llegaron a central (Paso 0 de la baja)
- [ ] Bajar los tres canales con la máquina **todavía prendida**
- [ ] Verificar que no quedan slots ni subs con el número de la filial
- [ ] Anotar el WAL liberado

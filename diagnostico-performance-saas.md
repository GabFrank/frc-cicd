# Diagnóstico de performance — Franco Systems SaaS

**Fecha:** 2026-08-24 · **Revisión 2** (tras auditoría cruzada)
**Alcance:** `franco-system-backend-servidor` (central), `franco-system-backend-filial` (filial), `frc-sistemas-integrados-angular` (desktop/PDV). Rama analizada: `develop`.
**Motivo:** quejas recurrentes de lentitud en PDV y en gestiones administrativas. Pruebas de red ya realizadas descartan problema de enlace.

> **Nota sobre esta revisión.** La v1 de este informe afirmaba cinco causas con más confianza de la que la evidencia soportaba. Dos auditorías independientes encontraron errores de hecho que invalidan parte de aquel diagnóstico. La §2 lista lo que se retira y por qué. **Lo que sigue distingue explícitamente entre defectos confirmados en código y causas candidatas todavía no medidas.**

---

## 0. Resumen ejecutivo

**La pregunta "¿por qué está lento?" todavía no tiene respuesta demostrada.** Lo que sí hay es un inventario de defectos reales y un conjunto de candidatos que ninguna lectura de código puede separar entre sí. Distinguirlos cuesta **un día de mediciones** (§8) y no requiere tocar producción.

### Defectos confirmados en código

| # | Hallazgo | Dónde duele | Esfuerzo |
|---|---|---|---|
| **D1** | Búsqueda de producto del PDV: **≈91 queries** por tecleo, y en el filial **no existe la ruta Lucene** → siempre cae al `LIKE '%x%'` con subconsulta que agrega toda `movimiento_stock` de la sucursal | PDV | Alto |
| **D2** | `financiero.cambio` sin índice sobre `(moneda_id, creado_en)`; se consulta **una vez por producto** de cada resultado | PDV + admin | Bajo |
| **D3** | Pool Hikari de 10 **amplificado por `RetryableDataSource`**: 10 reintentos con backoff sobre `getConnection()` | Ambos | Bajo |
| **D4** | 132 clases resolver, **cero DataLoaders**; ~278 queries dentro de loops en central, ~78 en filial | Admin sobre todo | Alto |
| **D5** | Cierre de caja: 2 queries por venta (`generarBalance`) | PDV | Medio |
| **D6** | `RestTemplate` del **filial sin ningún timeout**, usado para llamar al central por WAN | PDV | Muy bajo |
| **D7** | 1 thread para los 14 `@Scheduled` del central; JDBC remoto a filiales **sin `connectTimeout`/`socketTimeout`** | Central | Bajo |
| **D8** | Sin caché en Apollo (59 `no-cache` + 8 `network-only` de 68) | Admin | Bajo |
| **D9** | Angular: 378/453 componentes en CD `Default`, dos `interval(1000)`, cero lazy loading | Todo | Medio |
| **D10** | `JasperCompileManager.compileReport` en runtime, **24 usos, sin caché** | Impresión | Muy bajo |
| **D11** | **269 `new ModelMapper()`** inline (157 central + 112 filial) pese a existir un `@Bean` configurado que nadie usa | Ambos | Muy bajo |

### Candidatos no medidos que explican el síntoma igual de bien

El síntoma reportado —«no es lentitud constante, son picos que se destraban solos»— lo producen **cualquiera** de estos, sin necesidad de ninguno de los defectos de arriba:

| Candidato | Por qué encaja | Costo de descartarlo |
|---|---|---|
| **C1 · JVM sin `-Xmx` ni flags de GC** en toda la infraestructura | Sin `-Xmx` la JVM toma ¼ de la RAM. Filial 1 es *además* estación de trabajo con KDE. Un Full GC de 3-8 s produce exactamente ese patrón | 5 min (`-Xlog:gc` + histórico del dashboard) |
| **C2 · `REPLICA IDENTITY FULL` en tablas replicadas** | El apply worker de la filial ubica cada fila comparando **todas** las columnas → seq scan por fila cambiada, sobre las mismas tablas que lee el PDV, compitiendo por el mismo disco | 1 query (`pg_stat_subscription`) |
| **C3 · Slots de replicación inactivos** | Filial 5 apagada desde 2026-05-31 ancla ~3,8 GB de WAL; `bodega_filial25` otros 991 MB. Un slot inactivo retiene `catalog_xmin` → **bloquea el VACUUM de catálogos** → planning más lento en *todas* las queries | 1 query (`pg_replication_slots`) |
| **C4 · `app.disableHardwareAcceleration()`** en Electron | Todo el compositing va por CPU. Explica lentitud percibida con cero tráfico y cero queries | Medir con y sin, en una caja real |
| **C5 · `LOGGING_LEVEL_*=DEBUG` olvidado en un `.env`** | Ya pasó en bodega (`gotchas.md:723`), «miles de líneas DEBUG por segundo». No hay control que lo prevenga | Auditar 23 `.env` |

**Recomendación central: no ejecutar ninguna fase de fix antes de la Fase 0 (§9).** Los datos para decidir ya existen en parte — el dashboard guarda `heapUsed/heapMax`, `threads`, `activeConnections` y `latencyMs` por filial (`dashboard/lib/schema.ts`).

---

## 1. Preguntas sin responder que valen más que todo este informe

Ninguna auditoría de código puede contestarlas, y cada una descarta familias enteras de causas:

1. **¿Cuándo empezó?** El filial no cambia desde **2026-08-12**; el central cambia semanalmente. Si la lentitud es reciente y el filial no cambió, la causa está en el central, en la replicación, en la infra o en el volumen de datos — **no** en los N+1 del filial, que llevan años ahí.
2. **¿Una filial o todas?** Si es una, es hardware o replicación local, y estos defectos —idénticos en las 23— no lo explican.
3. **¿Una pantalla o todas?** «Todas» apunta a GC, CPU o replicación. «El buscador de productos» apunta a D1/D2.
4. **¿Correlaciona con la hora?** Picos en hora punta apuntan a D3; picos aleatorios, a C1.

---

## 2. Correcciones a la revisión 1

Se retiran o corrigen las siguientes afirmaciones. Se documentan porque varias eran la base de recomendaciones.

### 2.1 · RETIRADO — «el PDV rutea al central por WAN»

**Falso.** El PDV lee del filial en sus tres operaciones calientes:

| Operación | Archivo | Flag |
|---|---|---|
| Código de barras | `pdv/layout/buscador/buscador.component.ts:206,276` | `false` |
| Diálogo de búsqueda | `buscador.component.ts:141` | `false` |
| Guardar venta | `venta-touch/venta-touch.service.ts:46` | `false` |
| Monedas y formas de pago | `venta-touch/pago-touch/pago-touch.component.ts:374,384` | `false` |

En `src/app/modules/pdv/` hay **10 llamadas con `false` explícito contra 3 con `true`**.

También era falso que «las 37 llamadas a `monedaService.onGetAll()` van todas al central»: son 31 al central por default, 2 con `true` explícito y **4 al filial**.

**Qué queda en pie:** el ruteo al central sigue siendo real para **gestiones administrativas** (426 de 804 invocaciones), y ahí sí es una causa de lentitud. Pero no explica el PDV.

### 2.2 · RETIRADO — «`saveVenta` abre 30-40 transacciones SERIALIZABLE»

**Falso.** `VentaGraphQL.java:183` ya tiene `@Transactional`. La v1 citó la línea 184 y no leyó la anterior.

Consecuencia que **invierte** el diagnóstico: ningún `@Transactional` interno del camino de venta usa `REQUIRES_NEW`, así que con propagación `REQUIRED` **todos joinean la transacción externa**, y Spring **ignora en silencio el `isolation`** de los internos (`validateExistingTransaction=false` por defecto). Es decir: `VentaService.save`, `CobroService.save`, `CobroDetalleService.save` y `MovimientoStockService.save` **no corren en SERIALIZABLE** cuando se llega por `saveVenta`. Es **una** transacción, no 30-40, y no hay competencia por predicate locks por esta vía.

**Qué queda en pie:** no hay reintento de `SerializationFailureException` en ningún servicio, y `deshacerVenta` sigue existiendo como compensación manual. Pero **no tocar isolation sin medir antes** errores `40001` en el log y `pg_stat_database.xact_rollback`.

### 2.3 · CORREGIDO — el mecanismo de `open-in-view`

Dos errores separados:

**(a) OSIV no retiene la conexión.** Ninguno de los dos repos setea `hibernate.connection.handling_mode` (verificado). Con `RESOURCE_LOCAL` + Hibernate 5, el default es `DELAYED_ACQUISITION_AND_RELEASE_AFTER_TRANSACTION`: la conexión se adquiere perezosamente y se libera después de cada operación cuando no hay transacción activa. OSIV retiene el **EntityManager**, no la conexión.

Por lo tanto, «200 threads compitiendo por 10 conexiones se serializa en 10 requests» **no se sigue**. Se serializa en 10 *operaciones JDBC simultáneas*.

**(b) `spring.jpa.open-in-view=false` no hace nada acá.** Esa property solo controla el interceptor que registra la autoconfiguración. Ambos repos declaran el filtro **como `@Bean` explícito** (`FrancoSystemsApplication.java`, ~línea 96 central / 72-74 filial). La property deja el bean intacto. **Se elimina del plan.**

Y el bean es *load-bearing*: su comentario dice que existe para que el GraphQL-Servlet resuelva lazy loads durante la ejecución. Quitarlo tira `LazyInitializationException` en producción — **y los DataLoaders no lo arreglan**, porque batchean llamadas a servicio, no resuelven el lazy loading del grafo de entidades. Eso requiere fetch joins o proyecciones DTO.

**Lo que sí es real y la v1 no explotó:** `RetryableDataSource` (en **ambos** repos, instalado con `@Order(HIGHEST_PRECEDENCE)` sobre todo bean `DataSource`) reintenta `getConnection()` con `@Retryable(maxAttempts = 10, backoff = @Backoff(multiplier = 1.3, maxDelay = 10000))`. Con `connection-timeout=60000` en el central, un timeout de pool **no falla a los 60 s**: puede reintentar durante minutos. Ese es el multiplicador real del cuello de botella.

### 2.4 · RETIRADO — la comparación «259 índices vs 56»

**La evidencia no la sustenta.** El central tiene **290** migraciones (no 166) e incluye `V0__initial_schema.sql`, un dump de `pg_dump` de 15.324 líneas que aporta la mayoría de los `CREATE INDEX`. El filial **arranca en `V3`**: no tiene V0/V1/V2, y su esquema base se provisiona **fuera de Flyway** (`baseline-on-migrate=true`).

Contar `CREATE INDEX` en las migraciones del filial no dice nada sobre cuántos índices tiene realmente su base. **La comparación y la lista de «69 tablas sin índice en el filial» quedan sin sustento hasta correr `pg_indexes` contra una filial real.**

Errores derivados de lo mismo:
- **«`productos.producto` no tiene ningún índice propio»** — falso: `V0:9678` crea `producto_un_producto UNIQUE (descripcion)`, que materializa un B-tree. No sirve para `LIKE '%x%'` (la recomendación de trigram sigue en pie), pero la afirmación literal es falsa.
- **«`financiero.cambio` no tiene ningún índice»** — impreciso. Tiene el de la PK. Lo correcto: **no hay índice sobre `moneda_id` ni sobre `(moneda_id, creado_en)`**; el FK `cambio_moneda_id_fkey` **no genera índice** en Postgres. La conclusión operativa se sostiene.
- **«`presentacion(producto_id)` falta en ambos»** — falso: existe en central (`V0:10681`, `V21:31`) y en filial (`V26:88`). Falta el **compuesto** `(producto_id, principal)`, así que hoy hace index scan + filtro, no seq scan. El beneficio del fix es **mucho menor** de lo que decía la v1.

**Hallazgo colateral que sí vale:** `filial/V26__creacion_indices.sql:20-23` tiene un bug de copy-paste — el bloque comprueba `cobro_detalle_cobro_id_idx` pero vuelve a crear `venta_caja_id_idx ON operaciones.venta`. **El índice de `cobro_detalle` nunca se creó por esa vía**, y es justamente el del cierre de caja (D5).

### 2.5 · CORREGIDO — los dos `ProductoResolver` no son el mismo

La v1 los trató como uno. El de `imagenPrincipal` que hace I/O + `migrateFromOldSystem` (escritura en BD dentro de una lectura) es **solo del central**. El filial usa `imageService.getImageWithMediaType(...)`: solo lectura de disco.

Y **`imagenPrincipal` no está en `productoSearchPdv`** (está comentado, `graphql-query.ts:125`), igual que `sucursales`. Por lo tanto las «1.100 queries» y los «6,6 MB de JSON» son de **pantallas administrativas**, no del hot path del PDV.

### 2.6 · Conteos corregidos

| v1 | Real |
|---|---|
| 875 invocaciones de `GenericCrudService` | **804** (la v1 se contradecía: decía 802 en otra sección) |
| 516 al central | **426** |
| 6 al local | **8** |
| «100% de las queries sin caché» | 59 `no-cache` + 8 `network-only` (que **sí escriben** al caché) + 1 `cache-and-network` |
| 10 métodos en `GenericCrudService` | **12** (10 fijan `fetchPolicy`) |
| 5 métodos que cuelgan el Observable en error | **7** (faltaban `onGetById` y `onSaveCustom`) |
| 166 migraciones central | **290** |
| 319 queries en loops central / 83 filial | **~278 / ~78** (heurística; el peor real es `PagoProveedorService` con 28, no mencionado en v1) |
| 24 `Isolation.SERIALIZABLE` | **22 activos** + 2 comentados |
| 169 funciones en templates | **No reproducible.** Solo interpolación: 78. Con `[prop]`/`*ngIf`: ~360. El número depende del regex |
| «132 field-resolvers» | 132 **clases** resolver (79+53). Los campos resueltos son más. Terminología incorrecta |
| 146 defaults `= true` / 5 `= false` · 453 componentes / 75 OnPush · 44 vs 25 subscribe · 14 `@Scheduled` · 0 DataLoaders · 0 `loadChildren` · 0 `runOutsideAngular` · 37 `onGetAll()` de monedas | **Exactos** |

**Y se retira la afirmación de la §14 de la v1** de que «los conteos son exactos y reproducibles». Varios no lo son.

---

## 3. El caso de la cotización

La hipótesis original era: *cualquier consulta que necesite una cotización depende de tener salida a WAN, porque además busca la cotización exterior*.

**Lo que no pasa (confirmado por ambos auditores).** `NorteCambiosScraper` se invoca únicamente desde `CotizacionMercadoScheduler.scheduledUpdate()` (`@Scheduled`, cada 10 min) y desde la **mutation** `actualizarCotizacionesMercado` (botón manual en Cambios y en Gestión de Compras). **Ninguna lectura lo dispara**, y **el scraper no existe en el filial**.

**Lo que sí pasa, y es el defecto real (D2).** El campo `cambio` de Moneda lo resuelve `MonedaResolver.cambio` → `CambioService.findLastValorEnGsByMonedaId` →

```sql
select * from financiero.cambio c where c.moneda_id = ?1 order by creado_en desc limit 1
```

Sin índice sobre `moneda_id`, cada llamada es un scan + sort. Y se ejecuta **una vez por fila**: `productoSearchPdv` pide `costo { moneda { cambio } }`, así que una búsqueda de 10 productos hace **10 de estas**.

**Corrección respecto de la v1:** esto **no** sale por WAN en el PDV — `pago-touch` lee monedas del filial. El N+1 cae sobre la **tabla sin índice de la filial**, que es donde más duele.

**Fix:** índice `financiero.cambio (moneda_id, creado_en DESC)` en ambos. Es la mejora individual más barata del informe.

---

## 4. El hot path del PDV

### 4.1 · Costo real de una búsqueda: ≈91 queries

Camino verificado: PDV → **filial** → `ProductoGraphQL.productoSearch` → `ProductoService.findByAll` → `ProductoRepository.findbyAll` (`limit 10`).

Por producto, con los campos que **realmente** pide `productoSearchPdv`:

| Campo | Queries | Detalle |
|---|---|---|
| `codigoPrincipal` | 3 | `findByPrincipalAndProductoId` + `presentacionResolver.codigoPrincipal()` llamado **2×** (en el `if` y en el `return`) |
| `precioPrincipal` | 2 | vuelve a resolver la presentación principal |
| `costo` | 1 | `findLastByProductoId` |
| `costo.moneda` | 1 | `@ManyToOne(LAZY)` sin resolver → proxy — **omitido en la v1** |
| `costo.moneda.cambio` | 1 | scan sobre `cambio` (D2) |
| `envase` | 1 | `@ManyToOne(LAZY)` |
| **Total** | **9** | × 10 productos + 1 de búsqueda = **≈91** |

La v1 decía 81: **subestimaba**. Y el filial **no tiene `default_batch_fetch_size`**, así que los dos lazy loads no se agrupan.

### 4.2 · En el filial no existe la ruta Lucene

La v1 mencionaba `buscarPorTextoLucene` como mitigación parcial. **Esa ruta solo existe en el central.** El filial no tiene Hibernate Search: ni dependencia en el `pom.xml`, ni propiedades, ni clases (verificado). **En el PDV siempre se ejecuta el SQL con `LIKE '%…%'`.**

Esto **fortalece** el hallazgo respecto de la v1: la query que sigue es el único camino de búsqueda del PDV.

```sql
select distinct on (p.id, p.descripcion) p.*
from productos.producto p
left outer join productos.presentacion p2 on p2.producto_id = p.id
left outer join productos.codigo c on c.presentacion_id = p2.id
left join (
   select m.producto_id, sum(m.cantidad) as stock_actual
   from operaciones.movimiento_stock m
   where m.sucursal_id = CAST(:sucursalId AS bigint) and m.estado = true
   group by m.producto_id          -- agrega TODA la tabla de la sucursal
) st on st.producto_id = p.id
where (CAST(p.id as text) like '%…%' or UPPER(p.descripcion) like '%…%'
       or UPPER(p.descripcion_factura) like '%…%' or c.codigo like '%…%')
```

Dos problemas: la subconsulta **agrega toda `movimiento_stock` de la sucursal** sin filtrar por los productos que matchean, y el `LIKE` con comodín inicial impide usar índice.

**Advertencia sobre el fix propuesto en la v1:** un índice trigram sobre `descripcion` **probablemente no se use**. El `WHERE` es un `OR` de cuatro ramas sobre **dos tablas distintas** (`c.codigo` vive en `productos.codigo`, unida). Postgres solo arma un `BitmapOr` con ramas de la misma relación; con una rama sobre la tabla unida cae a seq scan igual. **El índice sirve solo después de reescribir la query.** Se mueve a Fase 3.

*(Además nadie corrió un `EXPLAIN` sobre esta query. Vale verificar que el `DISTINCT ON` + `ORDER BY p.descripcion` no falle: Postgres exige que el `ORDER BY` empiece por las expresiones del `DISTINCT ON`.)*

### 4.3 · Impresión y facturación dentro de la transacción de la venta

`saveVenta` es `@Transactional` (§2.2) y **dentro** ejecuta `facturaService.crearFacturaLegalDesdeVenta(...)` y `facturaLegalGraphQL.printTicket58mmFactura(...)`, que llama a `PrinterOutputStream.getPrintServiceByName(...)` — **enumeración de servicios javax.print/CUPS**. En filial 1 la impresora está en **otra máquina** (`ipp://192.168.0.145:631/...`). Un lookup CUPS lento mantiene abierta la transacción de la venta.

Esto es probablemente **lo que más siente el cajero**, y es barato de mover fuera de la transacción.

### 4.4 · Cierre de caja

`PdvCajaService.generarBalance()` (filial, 413-421): por cada venta, `cobroService.findById()` + `cobroDetalleService.findByCobroId()`. Una caja con 300 ventas = **600 queries**. Y el índice de `cobro_detalle` **nunca se creó** por el bug de `V26` (§2.4).

`VentaService.ventaPorPeriodo()` es peor: loop por día × loop por venta × `findByCobroId` ≈ **15.000 queries** para 30 días con 500 ventas/día.

*(Corrección menor: las dos llamadas duplicadas a `findByPdvCajaId` están en dos métodos privados distintos, no «en el mismo método» como decía la v1. La duplicación efectiva existe igual.)*

---

## 5. Configuración

| Parámetro | Central | Filial | Efectivo |
|---|---|---|---|
| Pool Hikari | sin configurar | sin configurar | **10** |
| `connection-timeout` | 60000 | sin configurar | 60 s / 30 s |
| `RetryableDataSource` | activo | activo | **×10 reintentos** sobre el timeout |
| `default_batch_fetch_size` | 10 | **ausente** | filial sin batching |
| Pool del `TaskScheduler` | sin configurar | sin configurar | **1 thread** |
| `RestTemplate` | 10 s / 30 s | **sin timeout** | filial cuelga indefinidamente |
| JDBC remoto a filiales | **sin timeout** | — | cuelga hasta el timeout TCP del SO |
| `-Xmx` / flags de GC | **ausente** | **ausente** | ¼ de la RAM física |

Verificado que **no hay override del pool** en `.properties`, `.yml`, `.github/workflows/` ni `deploy.sh` en ninguno de los dos repos.

### 5.1 · Los schedulers que realmente bloquean

La v1 culpaba al dispatcher FCM y al scraper. Hay peores: `ReplicationRefreshScheduler` (cada 2 h) y `ReplicationPublicationSyncScheduler` (cada 1 h) **iteran las filiales abriendo JDBC remoto**, y `createRemoteJdbcTemplate` (`LogicalReplicationService.java:1132`) usa `DriverManagerDataSource` **sin `connectTimeout` ni `socketTimeout`**. Una filial detrás de una VPN caída puede colgar el único thread del scheduler **durante minutos**, deteniendo FCM, cotizaciones, SIFEN y RRHH.

**Fix más rentable que subir el pool del scheduler:** `?connectTimeout=3&socketTimeout=10` en la URL JDBC remota.

### 5.2 · El indexador de Lucene compite con el tráfico (central)

`ProductoSearchStartupIndexer` corre en `ApplicationReadyEvent` —**después** de que el puerto acepta tráfico— de forma sincrónica, con `threadsToLoadObjects(4)` sobre `Producto` y `Codigo`. Esas conexiones salen del **mismo pool de 10**: cada restart del central arranca sirviendo con el 40-50% del pool tomado.

---

## 6. Replicación — el hueco más grande de la v1

No auditado en absoluto en la revisión anterior. Es sistémico y afecta a todo por igual, lo que encaja con «el sistema está lento» mejor que cualquier N+1 puntual.

### 6.1 · `REPLICA IDENTITY FULL` en todas las tablas replicadas

`LogicalReplicationService.ensureReplicaIdentityFull()` (`:1936`) ejecuta `ALTER TABLE ... REPLICA IDENTITY FULL` sobre **cada** tabla antes de publicarla, y el scheduler horario lo reaplica.

- **Publisher:** cada UPDATE/DELETE escribe la fila vieja **completa** al WAL.
- **Subscriber:** el apply worker localiza la fila destino **comparando todas las columnas**. Sin índice usable, hace **seq scan por cada fila cambiada** — sobre las mismas tablas que lee el PDV, compitiendo por el mismo buffer pool y el mismo disco.
- El apply worker es **un solo proceso serial por suscripción**: si se atrasa, el lag crece sin límite.

**Esto cruza con los índices:** los que se propongan no solo aceleran el PDV, aceleran el apply worker. Es un beneficio doble que la v1 no contabilizaba.

### 6.2 · Slots inactivos anclando WAL

Ya documentado en la propia skill operativa (`gotchas.md:257`, `hosts.md`): **filial 5 apagada desde 2026-05-31 con 2 slots anclando ~3,8 GB de WAL**, y `bodega_filial25_central_sub` inactivo con 991 MB.

Un slot lógico inactivo retiene `catalog_xmin` → **bloquea el VACUUM de catálogos** → bloat de `pg_class`/`pg_attribute` → **planning más lento en todas las queries**, más crecimiento monótono de `pg_wal`.

**Hay que resolver esto antes de medir cualquier otra cosa**: contamina cualquier baseline.

---

## 7. Frontend

Se mantiene lo verificado de la v1: **378 de 453 componentes en CD `Default`**, cero `runOutsideAngular`, dos `interval(1000)` permanentes (`header.component.ts:70` emitiendo un objeto nuevo por tick, consumido con `| async`; `hora-servidor.service.ts:37`), **cero `loadChildren`**, un overlay de spinner por operación.

`@UntilDestroy({checkProperties:true})` sobre `GenericCrudService`, que es `providedIn:"root"` y nunca se destruye → **los `untilDestroyed(this)` de sus 12 métodos no cancelan nada jamás**. Y **7** métodos (no 5) dejan el Observable colgado en la rama de error.

**Nuevo (C4):** `app/main.ts:16` y `app/main.js:25` llaman `app.disableHardwareAcceleration()`. Todo el compositing y la rasterización van por CPU. En cajas modestas eso hace que scroll, diálogos, ripples de Material y cada repintado del reloj de 1 s se sientan pesados, **con cero tráfico de red**. No hay evidencia de por qué se puso (¿driver roto en alguna filial?); hay que medir con y sin.

**Se retira** el conteo de «169 funciones en templates»: no es reproducible (§2.6). El defecto existe, la magnitud no está establecida.

---

## 8. Otros defectos baratos que la v1 no vio

- **`JasperCompileManager.compileReport` en runtime, 24 usos, sin caché alguno.** Compilar un `.jrxml` genera y compila Java: cientos de ms a segundos, **en cada impresión**. Cachear en un `Map<String,JasperReport>` es media hora de trabajo y es el mejor ratio de todo el sistema de impresión.
- **269 `new ModelMapper()` inline** (157 central + 112 filial) pese a existir un `@Bean ModelMapper` configurado con `MatchingStrategies.STRICT` que **nadie inyecta**. Cada instancia reconstruye su `TypeMap` por reflexión en cada llamada — **y usa STANDARD (fuzzy)**, o sea que el bean existe para prevenir un bug de mapeo que igual está presente. Uno de ellos está dentro de `saveVenta`.
- **`operaciones.stock_por_producto_sucursal` ya existe** desde `V16`/`V10`, con entidad, repositorio, servicio, y está en `replication_table` como `BRANCH_TO_MAIN`. `MovimientoStockService` **la inyecta y nunca la usa**. La v1 proponía «materializar el stock» como trabajo nuevo de semanas sin ver que hay una implementación a medio terminar ya replicándose.
- **`venta.service.ts:170-179`**: `onDeleteVentaItem(id, sucId, servidor = true)` declara el parámetro y **lo ignora**, pasando `false` hardcoded.
- **`search-list-dialog.component.ts:243-248`** implementa el patrón correcto (central con `timeout(5000)` → `catchError` → fallback local). Es el modelo a generalizar.
- `graphql.servlet.async-mode-enabled=false` en central: todo corre en el thread de Tomcat.
- `ParserOptions.maxTokens(500_000)` en `FrancoSystemsApplication:48` — alguien tuvo queries GraphQL enormes y nadie preguntó por qué.

---

## 9. Plan de fix

### Fase 0 — Evidencia (1 día, riesgo cero). **Bloquea todo lo demás.**

1. Responder las preguntas de §1: cuándo empezó, qué filiales, qué pantallas, si correlaciona con la hora.
2. Extraer del dashboard el histórico de `heapUsed/heapMax`, `threads`, `activeConnections`, `latencyMs` por filial. **Ya existe** (`dashboard/lib/schema.ts`).
3. En una filial de alto volumen: `-Xlog:gc*` 2 h, `pg_stat_statements`, `pg_stat_user_tables`, y `EXPLAIN (ANALYZE, BUFFERS)` de `findbyAll`, `findByCodigo` y `findLastByCambioId`.
4. `SELECT slot_name, active, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots;` en central y filial. **Resolver filial 5 y `bodega_filial25` antes de medir nada más.**
5. `SELECT relname, relreplident FROM pg_class WHERE relreplident='f';` + `pg_stat_subscription` — cuantificar C2.
6. **`SELECT * FROM pg_indexes WHERE schemaname IN ('productos','operaciones','financiero');`** en una filial real — es la única forma de sustentar o descartar la tesis de índices (§2.4).
7. `SHOW max_connections; SHOW shared_buffers; SHOW work_mem;` + `free -g` + `nproc` por filial. **Nadie sabe esto hoy** — el único scan de la flota no registra RAM, cores ni disco.
8. Auditar los 23 `.env` por `LOGGING_LEVEL_*=DEBUG` olvidado (C5).

### Fase 1 — Barato y reversible, **sin release** (horas)

Se aplica por el **overlay `/opt/frc-filial/application.properties`** en el `WorkingDirectory`, que tiene precedencia sobre el classpath del JAR (`runbooks/application-properties-overlay.md`). Permite probar en **una** filial, hoy, sin tocar `develop`, sin auto-update, y revertir con `rm` + restart. La v1 proponía editar el `application.properties` del repo, que se propaga a las 23 filiales en 15 minutos, de golpe y sin canary.

1. **`-Xmx`/`-Xms` explícitos + `-Xlog:gc`** en el `ExecStart` de systemd y en `start-filial.{bat,ps1}`.
2. **Timeouts en el JDBC remoto** de `createRemoteJdbcTemplate` (§5.1). El fix más rentable del central.
3. **Timeout en el `RestTemplate` del filial** (D6) — hoy no tiene ninguno y llama al central por WAN.
4. **Hikari: filial 15, central 25** — *no 50*. Ver §10.
5. **`default_batch_fetch_size=25`** en el filial (falta por completo) y subir el del central de 10 a 25.
6. `leak-detection-threshold=20000` y `connection-timeout=10000`.
7. **Revisar `RetryableDataSource`**: 10 reintentos sobre `getConnection()` convierten un timeout de 60 s en minutos.

> **Se elimina `spring.jpa.open-in-view=false` del plan** (§2.3): no hace nada, y desactivar OSIV de verdad rompe producción hasta que existan proyecciones DTO.

### Fase 1b — Código, barato, sin tocar la DB (días)

8. **Cachear los `JasperReport` compilados** en un mapa estático (§8).
9. **Inyectar el `@Bean ModelMapper`** en lugar de los 269 `new ModelMapper()` (§8).
10. **Mover `getPrintServiceByName` + impresión fuera de la transacción de `saveVenta`** (§4.3). Lo que más siente el cajero.
11. Corregir `GenericCrudService`: quitar el `@UntilDestroy` del singleton y cerrar los 7 Observables colgados.
12. `ProductoSearchStartupIndexer`: executor propio con concurrencia 1, o diferirlo (§5.2).
13. **Medir Electron con y sin `disableHardwareAcceleration()`** en una caja real (C4).

### Fase 2 — Índices (ventana por filial, **por `psql`, no por Flyway**)

> **Crítico:** `-- flyway:executeInTransaction=false` requiere Flyway 9.14+. **El filial pinea `flyway-core 5.2.3`** (`pom.xml:307`) y el central hereda 8.5.x. **La mitigación propuesta en la v1 no existe en ninguno de los dos** → `CREATE INDEX CONCURRENTLY` dentro de la transacción de Flyway falla → **la app no arranca**.
>
> Y un `CREATE INDEX` no concurrente toma `ShareLock`: **bloquea todo INSERT/UPDATE/DELETE** de la tabla mientras construye. Sobre `movimiento_stock` (3,1 M filas) en hardware modesto son **minutos con el PDV sin poder vender**, de forma desatendida durante la ventana de auto-update.

Procedimiento: `CREATE INDEX CONCURRENTLY` **a mano, por `psql`, en ventana nocturna, filial por filial**, midiendo la primera antes de seguir. Recién cuando estén en todas, mergear una migración con `CREATE INDEX IF NOT EXISTS` (que ya no hará nada, pero deja el estado declarado).

14. `financiero.cambio (moneda_id, creado_en DESC)` — el de mejor ratio (D2).
15. `operaciones.cobro_detalle (cobro_id)` — **nunca se creó** por el bug de `V26` (§2.4).
16. `movimiento_stock (sucursal_id, producto_id) WHERE estado` — el existente `(producto_id, sucursal_id)` **no sirve** para la subconsulta de `findbyAll`, que filtra por `sucursal_id`.
17. `presentacion (producto_id) WHERE principal` (parcial), y **borrar el prefijo redundante** para no pagar doble escritura en una tabla replicada.
18. `producto_por_sucursal (producto_id, sucursal_id)` — este sí falta en ambos.
19. Los que la Fase 0.6 demuestre que faltan realmente en el filial.
20. **Nada de `pg_trgm` todavía** (§4.2).

### Fase 3 — Estructural, ya con números

21. **Revisar `REPLICA IDENTITY FULL`**: donde la tabla tiene PK estable, `DEFAULT` alcanza y es mucho más barato (§6.1).
22. **Reescribir `findbyAll`**: filtrar primero, calcular stock de los ids que matchean después. **Recién ahí** el GIN trigram.
23. **Terminar `stock_por_producto_sucursal`**, que ya existe y ya se replica (§8).
24. **Caché en Apollo** para catálogos (`cache-first`), empezando por monedas, sucursales y formas de pago.
25. **Ruteo al filial en pantallas administrativas** — ver §10 para el riesgo real.
26. **DataLoaders** — ver §10 para el costo real en el filial.
27. Paralelizar y acotar el fan-out de `FilialCajaProxyService`, con circuit breaker por filial.
28. Lazy loading en Angular y `OnPush` en el PDV.

---

## 10. Riesgos y decisiones que la v1 tenía mal

### Hikari 50 es el número equivocado
El filial corre en cajas modestas (filial 1 es *además* estación de trabajo con KDE). PostgreSQL rinde máximo alrededor de `2–4 × núcleos` de conexiones **activas**; con 2-4 cores, 50 backends es thrashing de context switch más `work_mem` × 50. Son 250-500 MB extra de RSS en una máquina que ya sufre. Y nadie verificó `max_connections` (default 100), del que además hay que reservar para los apply workers de 2 suscripciones, walsenders y backups.

Con `connection-timeout=10000` y 50 conexiones, un pico ya no encola: abre 50 conexiones simultáneas contra queries que hacen seq scan. **Peor latencia p99, no mejor.**

**Filial 15, central 25.** Y **primero medir `hikaricp_connections_pending`**, que Actuator ya expone.

### Invertir el flag `servidor` es peligroso por las ESCRITURAS, no por las lecturas
`GenericCrudService` usa el **mismo flag** para lecturas y mutaciones: `onSave`, `onSaveCustom`, `onDelete`, `onDeleteWithSucId`, `onCustomMutation` y `onSaveConDetalle` son **todos `servidor = true`**. Invertir el default de un service invierte también sus escrituras.

Y las tablas candidatas (`moneda`, `cambio`, `producto`, `presentacion`, `codigo`, `precio_por_sucursal`, `costo_por_producto`) son **todas `MAIN_TO_ALL`**: flujo unidireccional central→filial. Escribir localmente en una de ellas **no vuelve nunca al central** y consume un id de la secuencia local que **va a chocar con una fila futura del central** → el apply worker tira `duplicate key` y **la suscripción se detiene entera**. No degrada: para toda la replicación `MAIN_TO_ALL` de esa filial, hasta intervención manual.

**Regla operativa que faltaba:** `replication_table.direction` ∈ {`MAIN_TO_ALL`, `BRANCH_TO_MAIN`, `MAIN_TO_SPECIFIC`}. **Leer de la filial solo `MAIN_TO_ALL`; escribir siempre al central salvo `BRANCH_TO_MAIN`.** Y hay tablas del hot path administrativo que **no están en `replication_table` en absoluto** (`caja_virtual`, `movimiento_cliente`, `movimiento_proveedor`, `movimiento_bancario`, `compra`, `recepcion_mercaderia`, `pedido`, `transferencia`): ahí `servidor=false` devuelve **vacío**, no lento.

**Propuesta:** separar `servidorLectura` / `servidorEscritura`, o no tocar `GenericCrudService` y hacerlo caso por caso solo en los `onGetAll`/`onCustomQuery` de catálogos `MAIN_TO_ALL`.

### DataLoaders en el filial: no son «semanas»
El filial es **Java 8** con `graphql-java-tools 6.1.0` + `graphql-spring-boot-starter 7.1.0` + `graphql-java-servlet 4.0.0`, sobre Spring Boot 2.1.15 (**EOL desde 2019**). Un `DataLoaderRegistry` por request ahí requiere un `GraphQLServletContextBuilder` custom en un stack de 2019, o subir versiones. **Es un proyecto de migración, no una tarea** — y el PDV corre justamente ahí. Puede que la respuesta correcta sea subir el stack del filial primero.

### `spring.task.scheduling.pool.size=5` esconde el problema
Un scraper que bloquea 30 s con pool 5 bloquea 1 de 5 threads en vez de 1 de 1. El problema —I/O de red sin timeout dentro de un `@Scheduled`— sigue. La corrección real son los **timeouts** (Fase 1.2) más sacar la I/O a un executor. Y en el **filial es innecesario**: tiene 4 `@Scheduled` y tres son no-ops (`UpdateService.checkForNewRelease` está enteramente comentado, backup deshabilitado). El problema del thread único es **exclusivo del central**.

### El fix 1.5 de la v1 (FCM async) tiene una trampa de Spring
`dispatchAsync()` es `@Async` **en la misma clase** que `scheduledDispatch()`: llamarlo desde ahí es **auto-invocación, no pasa por el proxy, no se ejecuta async**. Hay que extraer el envío a otro bean. Además `fetchAndLockBatch()` es `synchronized` en la JVM, no `SELECT ... FOR UPDATE SKIP LOCKED`: si se paraleliza mal, **se duplican pushes**.

### Rollout: el auto-update de 15 minutos no perdona
- **«Probar en alpha» no sirve** para esto: alpha es `mauro`, una máquina de test con una DB chica que jamás va a exhibir un `CREATE INDEX` de 20 minutos sobre 3,1 M filas. Y de alpha se pasa a beta —**la farmacia facturando**— en 15 minutos y en las 6 filiales a la vez. **No existe canary por filial.**
- **`HEALTH_TIMEOUT=240`** (`scripts/check-update.sh:27`) genera un bucle de outage: Flyway corre antes de que `/actuator/health` responda; si el índice tarda >4 min, el script revierte el JAR y reinicia, **pero la DB no se revierte**, `.current-version` vuelve atrás, y **el siguiente cron a los 15 min baja el mismo JAR y repite** — retomando el lock de escritura en horario comercial. Hay que subir `HEALTH_TIMEOUT` o sacar Flyway del arranque **antes** de cualquier migración pesada.
- Runbook de reversión escrito **antes** del primer cambio. Y no pushear un viernes (regla ya vigente).

### Índices redundantes
El plan agrega sin limpiar. El filial ya tiene `presentacion_producto_id_idx (producto_id)`; agregar `(producto_id, principal)` sin borrar el prefijo paga doble escritura en una tabla replicada con `REPLICA IDENTITY FULL`. Extender `scan-filial-linux.sh` para capturar RAM, cores, disco y settings de PostgreSQL — hoy no registra nada de eso.

---

## 11. Nota de método

Todo sale de lectura de código en las ramas `develop`. **No se ejecutó nada contra bases de datos ni servidores de producción**, así que ningún tiempo absoluto de este informe es una medición.

La revisión 1 afirmaba que sus conteos eran «exactos y reproducibles». **No lo eran**: §2.6 lista los que no reproducen. Los que sobrevivieron a la verificación cruzada están marcados como exactos en esa misma tabla.

La conclusión honesta de la revisión 2: hay **once defectos confirmados** que vale la pena corregir por sí mismos, y **cinco candidatos** —GC, replicación, slots, aceleración por hardware, logging— que explican el síntoma reportado tan bien como los defectos, y que **nadie ha medido**. La Fase 0 cuesta un día y decide cuál de las dos familias atacar primero.

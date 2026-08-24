# Diagnóstico de performance — Franco Systems SaaS

**Fecha:** 2026-08-24
**Alcance:** `franco-system-backend-servidor` (central), `franco-system-backend-filial` (filial), `frc-sistemas-integrados-angular` (desktop/PDV). Rama analizada: `develop` en los tres repos.
**Motivo:** quejas recurrentes de lentitud en PDV y en gestiones administrativas. Pruebas de red ya realizadas por el equipo descartan problema de enlace.

---

## 0. Resumen ejecutivo

La lentitud **no tiene una sola causa**. Hay cinco problemas estructurales que se multiplican entre sí. Ordenados por impacto estimado:

| # | Hallazgo | Impacto | Esfuerzo |
|---|---|---|---|
| **E1** | El cliente rutea **516 de 875 llamadas al servidor CENTRAL por WAN**, ignorando el servidor filial local | Muy alto | Medio |
| **E2** | **`fetchPolicy: "no-cache"` en el 100% de las queries** — el caché de Apollo nunca se usa | Muy alto | Bajo |
| **E3** | **Pool de 10 conexiones + `OpenEntityManagerInView` + N+1 masivo** → el backend se serializa en ~10 requests concurrentes, con espera en cola de hasta 60 s | Muy alto | Bajo |
| **E4** | **132 field-resolvers GraphQL sin un solo DataLoader** → N+1 sistémico (una búsqueda de producto en PDV ≈ **81 queries**) | Muy alto | Alto |
| **E5** | **El filial tiene 56 índices; el central 259.** El PDV corre en el filial, el menos indexado | Alto | Bajo |

Los cinco son acumulativos: un request del PDV paga ruteo WAN (E1), sin caché (E2), contra un backend saturado (E3), que ejecuta 81 queries (E4) sobre tablas sin índice (E5).

**Sobre el bug de cotización que reportaste:** confirmado el síntoma, con un mecanismo distinto al que suponías. Detalle en §1.

---

## 1. El caso de la cotización (tu hipótesis, corregida)

Tu observación fue: *"cualquier consulta que necesite alguna cotización depende de tener salida a WAN pues también busca la cotización exterior"*.

**El síntoma es real. El mecanismo es otro** — y es peor, porque afecta a más cosas.

### Lo que NO pasa
El scraper de nortecambios.com.py (`NorteCambiosScraper`) **no** se dispara en consultas de lectura. Solo corre:
- en un `@Scheduled` cada 10 min (`CotizacionMercadoScheduler`),
- al pulsar el botón de refresh en Cambios o en Gestión de Compras (`actualizarCotizacionesMercado`).

### Lo que SÍ pasa

**(a) La cotización se pide al CENTRAL por WAN, no al filial.**

`src/app/modules/financiero/moneda/moneda.service.ts:64`
```ts
onGetAll(servidor: boolean = true): Observable<Moneda[]>   // true = servidor CENTRAL
```
`src/app/modules/financiero/cambio/cambio.service.ts:33`
```ts
return this.genericService.onCustomQuery(this.ultimoCambioPorMonedaIdGQL, {id: monedaId}, true);
```

Ese `true` significa `clientName: "servidor"`, que en `graphql-connection.service.ts` rutea al **servidor central**. Hay **37 llamadas a `monedaService.onGetAll()`** en la app, todas al central. El PDV usa `moneda.cambio` intensivamente (`pago-touch.component.ts` líneas 214, 390-396, 570-726) para calcular vueltos, descuentos y totales.

Si la WAN está lenta o caída, el `createCentralTimeoutLink` corta a los 3 s y el POS cae a cotización `1` — comportamiento ya documentado en un comentario de `MonedaResolver.cambio`.

**(b) El campo `cambio` de Moneda es un N+1 sobre una tabla sin índice.**

`MonedaResolver.cambio` → `CambioService.findLastValorEnGsByMonedaId` → 
```sql
select * from financiero.cambio c where c.moneda_id = ?1 order by creado_en desc limit 1
```
**`financiero.cambio` no tiene ningún índice** en ninguno de los dos backends (verificado sobre las 166 migraciones del central y las 98 del filial). Cada llamada es un *seq scan + sort* de la tabla completa.

Y ese campo se pide **por cada fila**: la query `productoSearchPdv` incluye `costo { moneda { cambio } }`, así que una búsqueda que devuelve 10 productos hace **10 seq scans** sobre `cambio`.

### Corrección concreta
1. Índice `financiero.cambio (moneda_id, creado_en DESC)` — en central y filial.
2. Cambiar el default de `servidor` a `false` para monedas/cotización (leerlas del filial, que ya las tiene replicadas).
3. Cachear el catálogo de monedas en el cliente (cambia una vez al día, se pide 37 veces).

---

## 2. E1 — Ruteo al central por WAN

`GenericCrudService` (`src/app/generics/generic-crud.service.ts`) expone 10 métodos, **todos con `servidor: boolean = true`**, y `true` → `clientName: "servidor"` → servidor central.

Conteo sobre las 875 invocaciones del repositorio:

| Destino | Llamadas |
|---|---|
| CENTRAL (hardcoded `true`, `null`, u omitido → default) | **516** |
| Variable `servidor` propagada desde el service | 353 |
| LOCAL (`false` explícito) | **6** |

De los 151 defaults declarados en los services, **146 son `= true`** y solo 5 son `= false`.

**Consecuencia:** una filial tiene un servidor local con la base replicada, y prácticamente no lo usa. Cada pantalla paga RTT de WAN por operación, y una pantalla que encadena 5 queries paga 5 RTT secuenciales.

**Además**, `graphql-connection.service.ts` abre **siempre** un WebSocket al central (`"always required"`) con `reconnect: true`. Sin WAN, reintenta indefinidamente.

---

## 3. E2 — El caché de Apollo está desactivado por completo

Los 68 `fetchPolicy` del repositorio:

```
59 × 'no-cache'
 8 × 'network-only'
 1 × 'cache-and-network'
```

Los 10 métodos de `GenericCrudService` fijan `fetchPolicy: "no-cache"` de forma incondicional. El `new InMemoryCache()` de `createApolloOptions` **nunca se usa**.

Efecto: catálogos que no cambian (monedas, sucursales, formas de pago, familias, tipos de precio, timbrados) se re-piden por red en cada pantalla, cada diálogo y cada apertura de tab. Las monedas, 37 veces.

**Problema secundario en el mismo archivo:** `@UntilDestroy({ checkProperties: true })` está aplicado sobre `GenericCrudService`, que es `providedIn: "root"` — un singleton que **nunca se destruye**. Por lo tanto los `untilDestroyed(this)` de todos los métodos **no cancelan nada jamás**: al cerrar una pantalla, sus queries en vuelo siguen corriendo.

**Tercero:** en `onGetAll`, `onCustomQuery`, `onGetByTexto`, `onCustomSub` y `onGetByFecha`, la rama de error (`res.errors != null`) muestra el snackbar pero **nunca llama a `obs.next()` ni `obs.complete()`** — el Observable queda colgado indefinidamente y su suscriptor nunca se libera.

---

## 4. E3 — Saturación del pool de conexiones (el más barato de arreglar)

Configuración actual, verificada:

| Parámetro | Central | Filial | Default aplicado |
|---|---|---|---|
| `OpenEntityManagerInViewFilter` | registrado explícitamente | registrado explícitamente | — |
| Pool Hikari (`maximum-pool-size`) | no configurado | no configurado | **10** |
| `spring.datasource.hikari.connection-timeout` | 60000 | no configurado | 60 s / 30 s |
| Threads Tomcat | no configurado | no configurado | **200** |
| `default_batch_fetch_size` | 10 | **ausente** | sin batching |
| Pool del `TaskScheduler` | no configurado | no configurado | **1 thread** |

### Por qué esto es el cuello de botella principal

`OpenEntityManagerInViewFilter` mantiene la sesión Hibernate —y con ella **la conexión de BD**— tomada desde que entra el request hasta que termina de serializarse la respuesta. Con los N+1 de §5, un request del PDV retiene su conexión durante cientos de ms o segundos.

Con **200 threads de Tomcat compitiendo por 10 conexiones**, el sistema se serializa efectivamente en 10 requests concurrentes. El resto espera en la cola de Hikari **hasta 60 segundos** antes de fallar.

Eso explica el patrón que reportan los clientes: no es lentitud constante, son **picos de congelamiento** en horario pico, que se destraban solos.

### El filial no tiene batching
El central tiene `default_batch_fetch_size=10`; **el filial no lo tiene**. Cada asociación LAZY en el filial se carga de a una — N+1 puro, sin mitigación, justo donde corre el PDV.

### Un solo thread para 14 schedulers
No hay `ThreadPoolTaskScheduler` configurado, así que los **14 `@Scheduled` del central comparten 1 thread**. Entre ellos:
- `NotificationDispatchService` con `dispatch-interval=1000` (**cada segundo**), que llama a FCM (WAN) **en serie** dentro de un `for` sobre un batch de hasta 100 tokens;
- `CotizacionMercadoScheduler`, cuyo scraper tiene `connectTimeout=5s` + `readTimeout=10s` en dos conexiones → **hasta 30 s de bloqueo** si no hay salida WAN;
- la sincronización de replicación, SIFEN, retiros de tesorería.

Cualquiera que se cuelgue detiene a todos los demás.

---

## 5. E4 — N+1 sistémico en GraphQL

**132 field-resolvers (79 central + 53 filial). Cero `DataLoader` / `BatchLoader`.**

Cada campo resuelto por un `GraphQLResolver` ejecuta su propia query, una vez por elemento de la lista.

### `ProductoResolver` — el peor, y está en el hot path del PDV

11 campos, 18 llamadas a service. Detalle de los problemas:

**`sucursales(Producto p)`** — para cada producto:
```java
List<Sucursal> sucursalList = sucursalService.findAll2();     // todas las sucursales (17+)
for (Sucursal s : sucursalList) {
    movimientoStockService.stockByProductoIdAndSucursalId(...); // agregación sobre movimiento_stock
    costosPorProductoService.findLastByProductoId(p.getId());   // ← INVARIANTE del loop, se repite N veces
    productoPorSucursalService.findByProIdSucId(...);           // sin índice (producto_id, sucursal_id)
    pedidoService.findById(pedidoId);                            // condicional
}
```
`findLastByProductoId(p.getId())` **no depende de la sucursal** y se ejecuta una vez por sucursal. Con 18 sucursales son 17 queries idénticas desperdiciadas **por producto**. Total: ~1 + 18×3 = **55 queries por producto**. Una lista de 20 productos que pida `sucursales` → **1.100 queries**.

**`codigoPrincipal(Producto p)`** — llama `presentacionResolver.codigoPrincipal(presentacion)` **dos veces** (una en el `if`, otra en el `return`), duplicando la query:
```java
if(presentacionResolver.codigoPrincipal(presentacion)!=null){
    return presentacionResolver.codigoPrincipal(presentacion).getCodigo();
```

**`imagenPrincipal(Producto p)`** — hace **I/O de disco + conversión a base64 dentro del resolver**, por producto. Y si no encuentra la imagen, llama `migrateFromOldSystem(...)`, que **escribe en la base de datos dentro de una query de lectura**. Base64 infla el payload 33%: 50 productos con imagen de 100 KB ≈ **6,6 MB de JSON**, por WAN.

**Tres campos distintos (`imagenPrincipal`, `codigoPrincipal`, `precioPrincipal`) llaman cada uno a `presentacionService.findByPrincipalAndProductoId(true, p.getId())`** — la misma query, tres veces por producto.

### Costo real de una búsqueda en el PDV

`productoSearchPdv` devuelve hasta 10 productos (`limit 10` en `findbyAll`). Por producto:

| Campo | Queries |
|---|---|
| `codigoPrincipal` | 3 (1 presentación + 2 código duplicado) |
| `precioPrincipal` | 2 |
| `costo` | 1 |
| `costo.moneda.cambio` | 1 *(seq scan, tabla sin índice)* |
| `envase` (LAZY) | 1 |

**≈ 8 queries × 10 productos + 1 de búsqueda ≈ 81 queries por cada tecleo en el buscador**, retenidas bajo una sola conexión del pool de 10.

### Queries dentro de loops en todo el backend

| Repositorio | Ocurrencias | Archivos |
|---|---|---|
| Central | **319** | 92 |
| Filial | **83** | 27 |

Los peores del hot path operativo:
- `LiquidacionSueldoService` (23), `LiquidacionFinalService` (18)
- `RecepcionMercaderiaItemGraphQL` (13), `ProductoService` (13)
- `SifenSchedulerService` filial (20)

### El cierre de caja

`PdvCajaService.generarBalance()` (filial), líneas 413-421:
```java
for (Venta venta : ventaList) {
    Cobro cobro = cobroService.findById(venta.getCobro().getId()).orElse(null);
    List<CobroDetalle> cobroDetalleList = cobroDetalleService.findByCobroId(cobro.getId());
```
Una caja con 300 ventas = **600 queries**. Y `operaciones.cobro` y `operaciones.cobro_detalle` **no tienen índices en el filial** (§6), así que cada `findByCobroId` es un seq scan completo.

En el mismo método, `movimientoCajaService.findByPdvCajaId(pdvCaja.getId())` se llama **dos veces** (líneas 673 y 698).

`VentaService.ventaPorPeriodo()` es peor: por cada día del rango busca todas las ventas, y por cada venta busca sus cobro-detalles. Un reporte de 30 días con 500 ventas/día ≈ **15.000 queries**.

---

## 6. E5 — Divergencia de índices entre central y filial

| | Central | Filial |
|---|---|---|
| Sentencias `CREATE INDEX` | 396 | 62 |
| Índices únicos (tabla, columnas) | **259** | **56** |
| Tablas con al menos un índice | **102** | **22** |

**El PDV corre en el filial, que es el menos indexado.**

Tablas indexadas en central pero **no** en filial, del hot path operativo:

- `productos.codigo` → el escaneo de código de barras hace `where c.codigo = ?1` con **seq scan**
- `operaciones.venta_item`
- `operaciones.cobro`, `operaciones.cobro_detalle` → cierre de caja (§5)
- `financiero.caja_virtual`, `financiero.movimiento_caja_virtual`
- `financiero.movimiento_cliente`, `financiero.movimiento_proveedor`, `financiero.movimiento_bancario`
- `operaciones.producto_vencimiento`

…y 69 tablas más.

### Índices faltantes en **ambos** backends

| Tabla | Índice necesario | Query que lo usa |
|---|---|---|
| `financiero.cambio` | `(moneda_id, creado_en DESC)` | `findLastByCambioId` — **por cada producto/moneda** |
| `productos.producto` | trigram sobre `UPPER(descripcion)` | `findbyAll` con `LIKE '%texto%'` |
| `productos.presentacion` | `(producto_id, principal)` | `findByPrincipalAndProductoId` — 3× por producto |
| `productos.producto_por_sucursal` | `(producto_id, sucursal_id)` | loop de `ProductoResolver.sucursales` |

`productos.producto` **no tiene ningún índice propio** más allá de la PK, en ninguno de los dos backends. El central sí tiene trigram sobre `productos.codigo` (`V151`), pero no sobre la descripción.

---

## 7. Queries individuales problemáticas

### `ProductoRepository.findbyAll` — la búsqueda del PDV

```sql
select distinct on (p.id, p.descripcion) p.*
from productos.producto p
left outer join productos.presentacion p2 on p2.producto_id = p.id
left outer join productos.codigo c on c.presentacion_id = p2.id
left join (
   select m.producto_id, sum(m.cantidad) as stock_actual
   from operaciones.movimiento_stock m
   where m.sucursal_id = CAST(:sucursalId AS bigint) and m.estado = true
   group by m.producto_id          -- ← agrega TODA la tabla de la sucursal
) st on st.producto_id = p.id
where (... UPPER(p.descripcion) like CONCAT('%', UPPER(:texto), '%') ...)
```

Dos problemas graves:
1. **La subconsulta agrega toda `movimiento_stock` de la sucursal** (millones de filas — el propio código menciona 3,1 M) **en cada tecleo del buscador**, sin filtrar por los productos que realmente matchean.
2. `LIKE '%texto%'` con comodín inicial sobre una columna sin índice trigram → **seq scan** garantizado.

Existe una ruta alternativa por Lucene (`buscarPorTextoLucene`, `app.search.producto.enabled=true`) que evita parte de esto, pero **solo indexa descripción** y solo aplica si `textoBusquedaValido(texto)`; el resto cae al SQL de arriba.

### `ProductoRepository.searchWithFilters` — listado administrativo

JPQL con subconsultas correlacionadas por producto:
```sql
p.id IN (SELECT ms.producto.id FROM MovimientoStock ms WHERE ms.estado = true
         GROUP BY ms.producto.id HAVING SUM(ms.cantidad) > 0)
```
más `NOT IN (SELECT ...)` con `MAX(c2.creadoEn)` correlacionado sobre `CostoPorProducto`. Devuelve un `Page`, así que Hibernate ejecuta **además un `count(*)`** con toda esa maquinaria. Es la query del listado de productos con filtros.

### Sin paginación real
- `productos(page, size)` **ignora ambos parámetros** y llama `findAllForPdv()`, que trae todos los productos activos.
- `findForReport(texto)` no tiene `LIMIT`.

---

## 8. Transacciones: `SERIALIZABLE` en el hot path

**24 usos de `@Transactional(isolation = Isolation.SERIALIZABLE)`.** En el filial cubren el camino completo de una venta:

`VentaService.save` · `VentaService.saveAndSend` · `CobroService.save` · `CobroDetalleService.save` · `MovimientoStockService.save` · `PdvCajaService` (×3) · `ConteoService` (×2)

En PostgreSQL, SERIALIZABLE usa *Serializable Snapshot Isolation*: mantiene predicate locks y aborta transacciones con `could not serialize access due to read/write dependencies`. **No encontré lógica de reintento** en ninguno de esos servicios: la venta simplemente falla.

Peor aún: **`saveVenta` no es una transacción única.** `VentaGraphQL.saveVenta` (filial, línea 184) encadena:
1. `cobroGraphQL.saveCobro(...)` → transacción SERIALIZABLE
2. una transacción por cada `CobroDetalle`
3. `service.saveAndSend(venta)` → otra
4. `ventaItemGraphQL.saveVentaItemList(...)` → una por item + una por movimiento de stock
5. factura legal + documento electrónico + impresión

Una venta de 10 ítems abre del orden de **30-40 transacciones SERIALIZABLE independientes**, cada una tomando y devolviendo una conexión del pool de 10. Y como no hay atomicidad, ante un fallo parcial se llama a `deshacerVenta(...)` — compensación manual.

**Efecto en caja:** dos cajas vendiendo simultáneamente en la misma filial compiten por predicate locks sobre `movimiento_stock` del mismo producto. Bajo carga, o esperan o abortan.

---

## 9. Bloqueos sincrónicos sobre la red

### Fan-out secuencial a todas las filiales

`FilialCajaProxyService.cajasAbiertasPorUsuarioDesdeFiliales(...)` — expuesto como resolver GraphQL en `PdvCajaGraphQL:185`:

```java
for (Sucursal sucursal : sucursalService.findAllExcludingServer()) {
    PdvCaja caja = consultarCajaAbiertaEnSucursal(sucursal, usuarioId, headers, "CAJAS FILIAL");
```

Llamadas HTTP **secuenciales** a las 17+ filiales, con el `RestTemplate` global (`FrancoSystemsApplication:61-68`): `connectTimeout = 10 s`, `readTimeout = 30 s`.

Con 3 filiales caídas o detrás de una VPN lenta, ese único request tarda **30-90 segundos**, reteniendo todo ese tiempo un thread de Tomcat **y su conexión de BD** (por `OpenEntityManagerInView`). Peor caso teórico: 17 × 30 s = 8,5 minutos.

### Busy-wait dentro de un resolver

`VentaTarjetaGraphQL.saveVentaTarjeta` (central, líneas 71-93):
```java
private static final int VENTA_LOOKUP_MAX_INTENTOS = 5;
private static final long VENTA_LOOKUP_ESPERA_MS = 300;
...
Thread.sleep(VENTA_LOOKUP_ESPERA_MS);
```
Hasta **1,2 s de `Thread.sleep`** dentro del request, esperando que la replicación traiga la venta desde la filial.

---

## 10. Frontend Angular

### Change detection global cada segundo

- **453 componentes; solo 75 con `ChangeDetectionStrategy.OnPush`** → 378 en `Default`.
- **Cero `runOutsideAngular`** en todo el repositorio.
- Dos temporizadores de 1 segundo permanentemente activos:
  - `header.component.ts:70` — `now$ = timer(0, 1000)`, consumido con `(now$ | async)` en `header.component.html:66`. Emite un **objeto nuevo** en cada tick.
  - `hora-servidor.service.ts:37` — `interval(1000)` que empuja a `horaActual$`.

Con zone.js, cada tick dispara un ciclo de change detection sobre **todo** el árbol. El componente principal del PDV (`venta-touch.component.ts`) tiene **1.759 líneas** y usa estrategia `Default`.

### Funciones invocadas desde templates
**169 llamadas en 43 archivos** — viola la regla del `CLAUDE.md` del proyecto. Se re-evalúan en cada ciclo de CD (es decir, al menos una vez por segundo). Peores: `autorizar-gasto-dialog` (15), `list-pre-gastos` (15), `adicionar-pre-gasto` (14), `recepcion-mercaderia-verificar-item-dialog` (13).

### Suscripciones sin limpiar
`venta-touch.component.ts`: **44 `.subscribe(` contra 25 `untilDestroyed`** → ~19 suscripciones potencialmente huérfanas en el componente más usado del sistema. Como la navegación es por tabs (no por rutas), los componentes se acumulan.

### Sin lazy loading
**Cero `loadChildren`** en toda la aplicación. `app-routing.module.ts` declara 2 rutas; los 19 módulos se importan de forma eager. Todo el bundle (incluido `echarts`) se carga y evalúa al arrancar. Sin `budgets` definidos en `angular.json`.

### Un spinner por query
`CargandoDialogService.openDialog()` llama a `spinnerService.show()` (NgxSpinner) y arma un `setTimeout` de 60 s en **cada una** de las 802 invocaciones de `GenericCrudService`. Monta y desmonta un overlay por operación.

### N+1 de red en el header
`CotizacionHeaderService.fetchAll()` lanza **una query separada por moneda** en vez de una sola batch — al login y cada 10 minutos, contra el central.

---

## 11. Plan de fix

### Fase 1 — Inmediato (horas, sin cambios de código de negocio)

Es donde está la mejor relación impacto/riesgo. Estimo que la Fase 1 sola resuelve buena parte de la percepción de lentitud.

**1.1 Pool de conexiones y threads** — `application.properties`, ambos backends:
```properties
spring.datasource.hikari.maximum-pool-size=50
spring.datasource.hikari.minimum-idle=10
spring.datasource.hikari.connection-timeout=10000
spring.datasource.hikari.leak-detection-threshold=20000
spring.jpa.open-in-view=false
spring.task.scheduling.pool.size=5
```
> ⚠️ `open-in-view=false` **romperá** los resolvers que dependen de la sesión abierta durante la serialización. Debe hacerse **después** de la Fase 3, o bien probarse exhaustivamente en alpha primero. El resto de la Fase 1.1 es seguro y se puede aplicar ya.

**1.2 Batching en el filial** — falta y el central ya lo tiene:
```properties
spring.jpa.properties.hibernate.default_batch_fetch_size=25
```
(subir también el del central de 10 a 25)

**1.3 Índices faltantes** — migración `V{n}.5__perf_indices.sql` en ambos repos:
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cambio_moneda_fecha
    ON financiero.cambio (moneda_id, creado_en DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_presentacion_producto_principal
    ON productos.presentacion (producto_id, principal);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_producto_por_sucursal_prod_suc
    ON productos.producto_por_sucursal (producto_id, sucursal_id);

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_producto_descripcion_trgm
    ON productos.producto USING gin (UPPER(descripcion) gin_trgm_ops);
```
> `CONCURRENTLY` no puede correr dentro de una transacción de Flyway: la migración debe llevar `-- flyway:executeInTransaction=false` o usar la variante no concurrente en una ventana de mantenimiento.

**1.4 Portar los índices del central al filial.** El diff completo son 69 tablas; priorizar `productos.codigo`, `operaciones.venta_item`, `operaciones.cobro`, `operaciones.cobro_detalle`.

**1.5 Bajar la frecuencia del dispatcher de notificaciones:**
```properties
app.notifications.dispatch-interval=5000
```
y mover el envío a FCM al `notificationExecutor` que ya existe, en vez de hacerlo en serie dentro del thread del scheduler.

---

### Fase 2 — Corto plazo (días)

**2.1 Caché en Apollo.** En `GenericCrudService`, reemplazar el `no-cache` incondicional por una política parametrizable, con `cache-first` por defecto para catálogos:
```ts
onGetAll(gql: Query, page?, size?, servidor = true, fetchPolicy: WatchQueryFetchPolicy = 'cache-first')
```
Empezar por monedas, sucursales, formas de pago, familias, subfamilias, tipos de precio. Solo las monedas ahorran 37 round-trips de WAN por sesión.

**2.2 Ruteo al filial.** Invertir el default de `servidor` a `false` en los services de entidades que están replicadas en la filial (monedas, cambio, productos, presentaciones, códigos, precios). Hacerlo por módulos, validando contra `replication_table` qué está efectivamente replicado. **No** invertir el default global de golpe.

**2.3 Corregir `GenericCrudService`:**
- quitar `@UntilDestroy` del servicio singleton (no hace nada) y pasar la cancelación a los componentes llamadores;
- cerrar los Observables en la rama de error (`obs.error()` o `obs.complete()`) en los 5 métodos donde falta.

**2.4 Timeouts y paralelismo en `FilialCajaProxyService`:**
- `connectTimeout` 2 s, `readTimeout` 5 s para llamadas filial-a-filial (no el `RestTemplate` global);
- paralelizar el fan-out con un `ExecutorService` acotado + `CompletableFuture`;
- circuit breaker por filial: saltear las que fallaron en los últimos N minutos.

**2.5 Quitar el `Thread.sleep`** de `VentaTarjetaGraphQL`: devolver un estado "pendiente de sincronización" y que el cliente reintente.

**2.6 Frontend:**
- mover el reloj del header a `runOutsideAngular` + `markForCheck` manual, o emitir solo cuando cambia el minuto visible;
- unificar los dos `interval(1000)` en uno;
- pasar a `OnPush` los componentes del PDV (empezando por `venta-touch` y `pago-touch`);
- resolver las 169 llamadas a funciones en templates → propiedades calculadas o pipes puros;
- auditar las 19 suscripciones sin `untilDestroyed` en `venta-touch`.

---

### Fase 3 — Estructural (semanas)

**3.1 DataLoaders.** `graphql-java-kickstart` soporta `DataLoaderRegistry` por request. Implementarlos para los resolvers más calientes primero:
`Producto` → `Presentacion` → `Codigo` / `PrecioPorSucursal` / `CostoPorProducto` / `Moneda.cambio`.
Esto por sí solo convierte las ~81 queries de una búsqueda de PDV en ~6.

**3.2 Limpiar `ProductoResolver`** (se puede hacer antes que 3.1, es trivial):
- sacar `costosPorProductoService.findLastByProductoId` fuera del loop de sucursales;
- llamar una sola vez a `presentacionResolver.codigoPrincipal(...)` en `codigoPrincipal`;
- resolver `findByPrincipalAndProductoId` una vez y compartirla entre los tres campos que la usan;
- **quitar `imagenPrincipal` del payload por defecto**: servir las imágenes por URL/endpoint HTTP cacheable en vez de base64 embebido, y nunca disparar `migrateFromOldSystem` desde una lectura.

**3.3 Reescribir `findbyAll`:** filtrar primero los productos que matchean y recién después calcular el stock solo de esos ids, en vez de agregar toda `movimiento_stock` de la sucursal. Alternativamente, materializar el stock por (producto, sucursal) en una tabla mantenida por trigger o por el propio `MovimientoStockService`.

**3.4 Transacción única en la venta.** Anotar `VentaGraphQL.saveVenta` con un `@Transactional` que envuelva cobro + venta + items + stock, y **bajar el aislamiento de SERIALIZABLE a READ_COMMITTED** con bloqueo optimista (`@Version`) donde de verdad haga falta. Si se mantiene SERIALIZABLE en algún punto, agregar reintento con backoff. Esto elimina también el `deshacerVenta` manual.

**3.5 Sacar impresión y SIFEN del request de venta:** encolar el documento electrónico y el ticket, responder al POS apenas la venta está persistida.

**3.6 Lazy loading en Angular:** convertir los 19 módulos a `loadChildren` y definir budgets en `angular.json`.

**3.7 Paginar de verdad** `productos(page, size)` y `findForReport`.

---

## 12. Cómo verificar

Antes de tocar nada, conviene tener línea de base. Sobre el filial de una sucursal con carga real:

```properties
# temporal, en alpha
logging.level.org.hibernate.SQL=DEBUG
spring.jpa.properties.hibernate.generate_statistics=true
```

Y en PostgreSQL:
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- top 20 queries por tiempo total acumulado
SELECT calls, total_exec_time, mean_exec_time, rows,
       left(query, 120) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;

-- seq scans sobre tablas grandes (candidatas a índice)
SELECT relname, seq_scan, seq_tup_read, idx_scan,
       seq_tup_read / NULLIF(seq_scan, 0) AS avg_tup_per_scan
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_tup_read DESC
LIMIT 20;
```

Métricas a seguir, antes y después de cada fase:
1. queries por búsqueda de producto en PDV (objetivo: 81 → menos de 10);
2. `mean_exec_time` de `findLastByCambioId` (debería caer a microsegundos con el índice);
3. tiempo de cierre de caja con 300 ventas;
4. conexiones activas de Hikari en hora pico (`hikaricp_connections_active`);
5. tiempo de respuesta de `cajasAbiertasPorUsuarioDesdeFiliales` con una filial apagada.

---

## 13. Riesgos del plan

| Cambio | Riesgo | Mitigación |
|---|---|---|
| `open-in-view=false` | `LazyInitializationException` en resolvers que hoy dependen de la sesión abierta | Hacerlo **después** de los DataLoaders (3.1); probar en alpha con carga real |
| Invertir `servidor` a `false` | Leer de una filial cuya réplica está atrasada o incompleta | Validar contra `replication_table` tabla por tabla; migrar por módulos |
| Bajar SERIALIZABLE | Condiciones de carrera en stock | `@Version` en `MovimientoStock`; test de concurrencia con dos cajas simultáneas |
| Índices `CONCURRENTLY` | No corren dentro de transacción Flyway | `-- flyway:executeInTransaction=false` |
| Caché en Apollo | Datos obsoletos en pantalla | `cache-first` solo para catálogos; `network-only` explícito en lo operativo |
| Portar índices al filial | Escrituras más lentas; deploy automático cada 15 min propaga a todas las filiales | Aplicar primero en canal alpha; medir tamaño en disco |

---

## 14. Nota de método

Todo lo anterior sale de lectura de código en las ramas `develop` de los tres repositorios. **No se ejecutó nada contra bases de datos ni servidores de producción**, así que los tiempos absolutos son estimaciones derivadas del conteo de queries, no mediciones. Los conteos de código (516 llamadas al central, 132 resolvers, 319 queries en loops, 259 vs 56 índices, 453 vs 75 componentes) sí son exactos y reproducibles.

La Fase 1 y el §12 están pensados para convertir esas estimaciones en mediciones antes de encarar la Fase 3.

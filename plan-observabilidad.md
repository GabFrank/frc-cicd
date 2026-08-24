# Plan de observabilidad — Franco Systems SaaS

**Fecha:** 2026-08-24
**Complemento de:** [diagnostico-performance-saas.md](diagnostico-performance-saas.md)
**Objetivo:** que el sistema **avise solo** cuando se pone lento o falla, en vez de enterarnos por la queja de un cliente.

---

## 0. La idea en una frase

Hoy el dashboard monitorea **infraestructura** (¿está vivo el proceso? ¿cuánto heap? ¿replica?). Lo que falta es monitorear **la experiencia**: ¿cuánto tardó cobrar? ¿cuánto tardó buscar un producto? ¿cuántas operaciones fallaron en silencio?

La buena noticia es que **casi toda la cañería ya existe**. Hay tres piezas puestas y una faltante:

| Pieza | Estado |
|---|---|
| Almacén de métricas + histórico | ✅ `dashboard/lib/schema.ts` (`healthChecks`, `instanceRuntime`, `pgDatabases`) |
| Motor de alertas con estados y anti-flapping | ✅ `alerts` + `alertRuleConfig` |
| Notificaciones con dedup, severidad y horario de silencio | ✅ `notificationRules` + `notificationState` + WhatsApp |
| **Telemetría a nivel de aplicación** | ❌ **no existe** |

**Este plan es solo la pieza faltante.** No se construye un sistema de alertas nuevo: se le da de comer al que ya está.

---

## 1. Dos costuras que evitan tocar 800 archivos

El instinto sería instrumentar cada operación. No hace falta: el código ya tiene dos puntos por donde pasa **todo**.

### Costura A — `CargandoDialogService` (lo que el usuario *siente*)

`shared/components/cargando-dialog/cargando-dialog.service.ts` ya envuelve **las 804 invocaciones** de `GenericCrudService`, y ya tiene lo necesario:

```ts
openDialog(...): { requestId: number; signal: AbortSignal }   // ya asigna un id
closeDialog(requestId?: number)                               // ya cierra por id
```

Cada par `openDialog`/`closeDialog` **es** una operación cronometrable. Es exactamente el «loading» del ejemplo. Y mide lo que importa: **el tiempo que el cajero mira la pantalla esperando**, incluyendo overhead de cliente, no solo el de red.

Bonus: el `setTimeout(..., 60000)` que ya existe detecta el caso *«el loading nunca cerró»* — hoy solo muestra «Tiempo de espera superado» y no deja rastro. Ese es el síntoma de los **7 Observables que quedan colgados** en la rama de error (§7 del diagnóstico), que hoy producen **cero señal**.

### Costura B — un `ApolloLink` (lo que tarda el servidor)

`shared/services/graphql-connection.service.ts` ya compone links custom (`createAbortableLink`, `createCentralTimeoutLink`, `createEmptyResultGuardLink`). Agregar un `createTelemetryLink()` es un archivo, y da lo que A no puede: **`operationName`, destino (filial o central), tamaño de respuesta y error de red o de GraphQL**.

### Por qué las dos, y no una

Miden cosas distintas, y **la diferencia entre ambas es el diagnóstico**:

```
A (percibido)  ──────────────────────────────────  1.800 ms
B (red+server) ───────────────────                    900 ms
                                  └──────────────┘
                                   900 ms de cliente → es change detection, no la DB
```

Sin las dos, cada vez que alguien diga «está lento» seguimos adivinando de qué lado.

---

## 2. Qué medir (y qué no)

### Nombrar por operación de negocio, no por query

Un panel que dice «latencia GraphQL p95: 800 ms» no sirve para decidir nada. Uno que dice **«cobrar: p95 4,2 s (normal 1,1 s)»** sí.

Se define un catálogo corto y estable de operaciones, con su presupuesto:

| Operación | Costura | Presupuesto p95 | Por qué ese número |
|---|---|---|---|
| `buscar_producto` | A + B | 400 ms | el cajero teclea; arriba de eso se nota |
| `agregar_item` | A | 250 ms | debe sentirse instantáneo |
| `cobrar_venta` | A + B | 2.500 ms | incluye impresión (hoy dentro de la transacción) |
| `abrir_caja` | A + B | 3 s | una vez por turno |
| `cerrar_caja` | A + B | 15 s | el N+1 de `generarBalance` (D5) |
| `listar_productos_admin` | A + B | 3 s | pantalla administrativa |
| `guardar_compra` | A + B | 5 s | |

Los presupuestos arrancan como estimación y **se recalibran con el percentil real de las primeras dos semanas**. Un umbral inventado genera ruido; un umbral derivado del propio baseline genera señal.

### Los cuatro indicadores clásicos, traducidos

Son las *golden signals* de la práctica SRE, mapeadas a este dominio:

| Indicador | Qué es acá | ¿Existe hoy? |
|---|---|---|
| **Latencia** | tiempo por operación de negocio | ❌ — es lo que agrega este plan |
| **Errores** | operaciones fallidas, **incluidas las silenciosas** | ❌ parcial |
| **Tráfico** | ventas/hora por filial | ❌ — da el contexto: una filial lenta con 3× de tráfico no es lo mismo |
| **Saturación** | heap, pool, conexiones PG | ✅ ya está en `instanceRuntime` |

### Percentiles, no promedios

El promedio esconde exactamente lo que duele. Si 95 operaciones tardan 100 ms y 5 tardan 20 s, el promedio da 1 s y parece sano — pero **cinco cajeros esperaron veinte segundos**. Se guardan p50, p95 y p99, y **se alerta por p95**.

### Cardinalidad: el error clásico

No guardar `producto_id` ni texto de búsqueda como dimensión: son millones de valores y revientan cualquier almacén. Las dimensiones son solo: `operacion`, `sucursal`, `version_app`, `usuario` (opcional, para soporte). Nada de campos libres.

---

## 3. Arquitectura

```
Desktop (Electron)                 Filial (Java 8)              Dashboard
┌────────────────────┐            ┌──────────────────┐        ┌─────────────────┐
│ CargandoDialog (A) │            │ POST /telemetria │        │ perf_samples    │
│ ApolloLink     (B) │──batch───▶ │  (REST, no GQL)  │──sync─▶│ perf_rollup     │
│                    │  cada 60s  │        │         │        │       │         │
│ ring buffer        │            │        ▼         │        │       ▼         │
│ IndexedDB (offline)│            │ perf_event       │        │ alerts (existe) │
└────────────────────┘            │ (tabla local)    │        │       │         │
                                  │                  │        │       ▼         │
                                  │ GraphQL          │        │ WhatsApp        │
                                  │ Instrumentation  │        │ (existe)        │
                                  └──────────────────┘        └─────────────────┘
```

### Cinco reglas que no se negocian

1. **La telemetría no puede colgar la app.** Buffer en memoria + `IndexedDB`, envío `fire-and-forget` con timeout corto. Si falla, se descarta. Nunca un `await` en el camino del usuario.
2. **Debe sobrevivir sin WAN.** Las filiales pierden enlace. Ring buffer acotado (p. ej. 5.000 eventos); cuando se llena, **se descarta lo más viejo**. Nunca crece sin límite.
3. **La ingesta NO va por GraphQL.** Iría por el mismo camino que está midiendo, compitiendo por el mismo pool de 10 conexiones. Va por un endpoint REST propio, como el `/config/hora-servidor` que ya existe.
4. **Muestreo desde el día uno.** 100% de las operaciones *lentas* y de las *fallidas*; 10% de las normales. El detalle está en la cola, no en el caso feliz.
5. **Retención corta en la filial.** 7 días de crudo local, agregados por hora hacia el dashboard. La filial no es un almacén de series temporales.

---

## 4. Instrumentación del servidor

### 4.1 · `Instrumentation` de graphql-java — el mayor valor por el menor esfuerzo

`graphql-java` expone una interfaz `Instrumentation` con hooks por operación y **por campo**. Es la pieza que convierte los N+1 de invisibles en obvios:

```
operacion=productoSearch  duracion=1.240ms  campos_resueltos=91
  Producto.codigoPrincipal     ×10   → 30 queries
  Producto.precioPrincipal     ×10   → 20 queries
  Moneda.cambio                ×10   → 10 queries   ⚠ 890ms acumulados
```

Eso no es una hipótesis de auditoría: es el N+1 medido en producción, atribuido al campo exacto. **Un detector de N+1 se vuelve trivial**: si `queries_por_request > 30`, se registra el evento con el desglose.

> **Verificar antes:** el filial usa `graphql-java-servlet 4.0.0` sobre Java 8. Hay que confirmar que esa versión expone `Instrumentation` con la firma esperada. Si no, la alternativa es un contador por request vía `ThreadLocal` incrementado en un aspecto sobre los repositorios — más tosco, pero funciona en cualquier versión.

### 4.2 · Contador de queries por request

Independiente de lo anterior, y el detector más directo del problema que motivó todo este trabajo: un `ThreadLocal<AtomicInteger>` incrementado por un interceptor de Hibernate (`StatementInspector`), leído y reseteado en un filtro de servlet. Si supera el umbral, se registra la operación con su conteo.

### 4.3 · Reutilizar Actuator, que ya está configurado

`management.endpoints.web.exposure.include=health,info` ya está en ambos backends. Exponiendo también `metrics`, se obtiene gratis `hikaricp.connections.pending` — el número que decide si el pool de 10 realmente es el cuello de botella (§10 del diagnóstico).

> **Verificar:** `spring-boot-starter-actuator` **no aparece declarado** en ninguno de los dos `pom.xml`, aunque sus properties sí están configuradas. Puede venir transitivo, o las properties pueden estar inertes. Confirmar antes de asumir que Actuator responde.

### 4.4 · Correlación de punta a punta

El desktop genera un `X-Correlation-Id` por acción del usuario y lo propaga a filial y central. Permite reconstruir una operación completa:

```
corr=a3f9  cobrar_venta  total 4.100ms
  ├─ cliente         310ms
  ├─ red filial       40ms
  ├─ filial          3.650ms
  │   ├─ saveVenta        820ms
  │   └─ printTicket    2.780ms   ⚠ lookup CUPS dentro de la transacción
  └─ render           100ms
```

Sin esto, «la venta tardó 4 segundos» no es accionable. Con esto, señala la línea exacta.

---

## 5. Detectores específicos de este sistema

Genéricos hay muchos. Estos salen de los hallazgos del diagnóstico y **no vienen en ninguna herramienta de estante**:

| Detector | Qué dispara | De dónde sale |
|---|---|---|
| **Loading colgado** | un `openDialog` sin su `closeDialog` a los 60 s | los 7 Observables que quedan colgados y hoy no dejan rastro |
| **N+1** | `queries_por_request > 30` | D1/D4 — la búsqueda hace ~91 |
| **Query lenta** | cualquier sentencia > 1 s | D1, `findbyAll` |
| **Pool saturado** | `hikaricp.connections.pending > 0` sostenido | D3, y **decide si el pool 10 es el problema** |
| **Pausa de GC** | pausa > 1 s, o `heapUsed/heapMax > 90%` | C1 — el candidato más probable, y el dashboard **ya guarda heap** |
| **Lag de replicación** | `pg_stat_subscription` atrasado, o slot inactivo con WAL creciendo | C2/C3 — hoy invisible pese a los 4,8 GB anclados |
| **Filial muda** | una filial que dejó de reportar telemetría | detecta la caída antes que el cliente |
| **Deriva de versión** | filial en versión distinta a su canal | el auto-update de 15 min falla en silencio |
| **Impresión lenta** | lookup CUPS > 2 s | §4.3 — lo que más siente el cajero |
| **Degradación relativa** | p95 de hoy > 2× la mediana de los últimos 7 días | detecta regresiones tras un deploy, sin umbral fijo |

El último es el más valioso a largo plazo: **no requiere elegir un número**. Se compara el sistema contra sí mismo, y aparece solo cuando algo empeoró.

---

## 6. Alertas: reutilizar, no reinventar

El `alertRuleConfig` que ya existe tiene exactamente los campos correctos:

| Campo existente | Para qué sirve acá |
|---|---|
| `pendingCycles` | no alertar por un pico aislado |
| `resolvingCycles` | no cantar victoria antes de tiempo |
| `severityDefault` | `info` / `warn` / `critical` |
| `enabled` | apagar una regla ruidosa sin tocar código |

Y `notificationRules` ya cubre `minSeverity`, horarios de silencio (`quietStart`/`quietEnd`), `quietBypassCritical` y `resendIntervalMin`. `notificationState` ya deduplica por `(fingerprint, destinatario)`.

**Solo hay que agregar `kind` nuevos** (`perf_loading_colgado`, `perf_n_mas_uno`, `perf_gc_pausa`, `perf_replicacion_lag`, …). Cero código de alertas nuevo.

### Contra la fatiga de alertas

Una alerta que nadie mira es peor que ninguna: entrena al equipo a ignorar el canal.

- **Empezar con todo en `info`.** Dos semanas mirando sin notificar. Recién ahí se promueve a `warn` lo que resultó tener señal.
- **Agrupar por causa, no por síntoma.** Si una filial tiene GC saturado, sus veinte operaciones lentas son **una** alerta, no veinte.
- **Presupuesto de ruido:** más de 3 notificaciones por semana en un canal significa que el umbral está mal, no que el sistema esté mal. Revisar el umbral, no agregar destinatarios.
- **Toda alerta lleva enlace** a la operación, la filial y la ventana de tiempo. Una alerta sin contexto accionable es ruido con formato.

---

## 7. Qué NO hacer (todavía)

Honestidad sobre el costo de las opciones «de manual»:

| Opción | Por qué no ahora |
|---|---|
| **OpenTelemetry + Prometheus + Grafana** | Es lo correcto en una empresa con equipo de plataforma. Acá implica operar tres servicios más **en 23 filiales on-prem con enlaces intermitentes**. El costo operativo supera al beneficio hasta que el sistema propio quede corto |
| **Sentry self-hosted** | Excelente para errores de frontend, pero es otro servicio que mantener. Reevaluar cuando el volumen de errores lo justifique |
| **APM comercial** (New Relic, Datadog) | Precio por host × 23 filiales, y requiere salida a internet confiable que justamente no siempre hay |
| **Guardar cada request para siempre** | Crece sin límite y el 99% nunca se mira. Muestreo + agregación por hora desde el día uno |

El diseño de arriba es deliberadamente modesto: **tablas propias + el pipeline de alertas que ya existe**. Si en un año se queda corto, migrar a OpenTelemetry es directo, porque los conceptos (operación, duración, correlación, atributos) son los mismos.

---

## 8. Plan por fases

Se integra al plan del diagnóstico. **La Fase 0 de aquel documento sigue primero** — es medición manual, y sirve además para calibrar los umbrales de acá.

### Fase O1 — Telemetría de cliente (3-5 días)
1. `createTelemetryLink()` en la cadena de Apollo (costura B).
2. Cronometrar `openDialog`/`closeDialog` en `CargandoDialogService` (costura A), incluyendo el caso «nunca cerró».
3. Ring buffer en `IndexedDB` con envío por lotes cada 60 s, `fire-and-forget`, tope de 5.000 eventos.
4. `POST /telemetria/eventos` REST en el filial (**no GraphQL**) + tabla `perf_event` con retención de 7 días.
5. Catálogo de operaciones de negocio (§2) mapeado desde `operationName`.

> Aporta valor solo. Aun sin alertas, responde «¿qué pantalla está lenta, en qué filial?» — la pregunta que el diagnóstico no pudo contestar.

### Fase O2 — Telemetría de servidor (3-5 días)
6. Contador de queries por request (`StatementInspector` + `ThreadLocal`).
7. `Instrumentation` de graphql-java con timing por campo — **verificar compatibilidad con `graphql-java-servlet 4.0.0` primero**.
8. Log de queries > 1 s.
9. `X-Correlation-Id` desktop → filial → central.
10. Confirmar y exponer Actuator `metrics` (`hikaricp.connections.pending`, `jvm.gc.pause`).

### Fase O3 — Ingesta y agregación (2-3 días)
11. Sync filial → dashboard, agregado **por hora** (no crudo).
12. Tablas `perf_samples` y `perf_rollup` en el esquema del dashboard.
13. Pantalla: p50/p95/p99 por operación y por filial, con serie temporal.

### Fase O4 — Detectores y alertas (3-4 días)
14. Los detectores de §5 como `kind` nuevos en `alertRuleConfig`.
15. **Dos semanas en `info`**, sin notificar, para calibrar umbrales con datos reales.
16. Promover a `warn`/`critical` solo lo que demostró señal.
17. Detector de degradación relativa (p95 hoy vs mediana de 7 días).

### Fase O5 — Higiene continua (permanente)
18. Revisión mensual: ¿qué alertas se dispararon? ¿cuáles fueron ruido? Ajustar o apagar.
19. Los presupuestos de §2 se recalibran cada trimestre.
20. Toda pantalla nueva declara su operación de negocio y su presupuesto **antes** de mergear.

---

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| **La telemetría se vuelve el problema de performance** | Muestreo desde el día uno; ingesta por REST y no por GraphQL; `fire-and-forget`; medir el overhead del propio telemetry link antes de desplegarlo |
| **Ring buffer llena el disco de la filial** | Tope duro de eventos y retención de 7 días; descarte del más viejo, nunca crecimiento sin límite |
| **Fatiga de alertas** | Arrancar todo en `info`; presupuesto de 3 notificaciones semanales; agrupar por causa |
| **Cardinalidad explosiva** | Lista blanca de dimensiones; prohibido `producto_id` o texto libre como dimensión |
| **Datos sensibles en la telemetría** | Nunca registrar el texto de búsqueda ni datos de cliente. Solo `operationName`, duración y códigos de error |
| **Se despliega a 23 filiales en 15 min** | Igual que el resto del plan: probar en **una** filial por overlay de `application.properties`, y una sola caja para el desktop |
| **`Instrumentation` no existe en el stack viejo del filial** | Verificar antes de comprometer la Fase O2; el contador por `ThreadLocal` es el plan B y funciona en cualquier versión |

---

## 10. Cómo se ve el resultado

El caso del ejemplo original, de punta a punta:

```
1. El cajero de Filial 3 aprieta «Cobrar». El loading tarda 8,2 s.
2. CargandoDialogService registra: operacion=cobrar_venta, duracion=8200ms,
   presupuesto=2500ms, corr=a3f9, version=3.0.9, sucursal=3
3. Se bufferea y se envía en el lote de los 60 s.
4. El dashboard ve 4 casos en una hora sobre la misma filial
   → supera pendingCycles → promueve la alerta.
5. WhatsApp: «⚠ Filial 3 — cobrar_venta p95 8,1s (presupuesto 2,5s),
   12 casos en 1h. Ver detalle: <enlace>»
6. El enlace muestra el desglose por correlación:
   printTicket = 6,8s de los 8,2s → lookup CUPS contra la impresora en red.
7. Se arregla la causa, no el síntoma.
```

Hoy ese mismo caso llega como **«el sistema está lento»**, tres días después, por teléfono, sin filial, sin hora y sin operación. Que es exactamente el punto de partida de este trabajo.

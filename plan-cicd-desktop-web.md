# Plan — despliegue web de `desktop` (Franco Systems ERP como app de navegador)

> Escrito 2026-08-15. La infraestructura descrita en la sección 0 está **creada y
> verificada ese día por API de Cloudflare**, no proyectada. Lo que queda es
> trabajo dentro del repo `desktop`.

El repo `desktop` (`GabFrank/frc-sistemas-integrados-angular`) es Angular 15 +
Electron 22. Desde 2026-08 la parte Angular **corre como web pura** en un
navegador, sin Electron, y eso es lo que este plan publica: la misma app que hoy
se instala como `FRC-Setup.exe`, servida desde Cloudflare Pages en
`<empresa>.desk.frcsuite.com`.

**No reemplaza al instalador.** El canal Electron sigue siendo el POS. Esto es un
segundo artefacto del mismo código, para el uso administrativo.

---

## 0 · Estado de ejecución

| Fecha | Qué se hizo | Dónde |
|---|---|---|
| 2026-08-15 | 3 proyectos de Pages creados: `frc-desk-alpha`, `frc-desk-beta`, `frc-desk-prod`, con `production_branch=main` | Cloudflare Pages |
| 2026-08-15 | Marcador de posición desplegado en los tres — un `index.html` suelto, **sin compilar el repo** | Cloudflare Pages |
| 2026-08-15 | 4 CNAME proxeados en la zona `frcsuite.com`: `alpha.desk`, `beta.desk`, `farmacia.desk`, `bodega.desk` | Cloudflare DNS |
| 2026-08-15 | Las 4 puertas asociadas a su proyecto; certificados emitidos por Google Trust Services | Cloudflare Pages |
| 2026-08-15 | Verificado que el `environment` `production` del repo `desktop` ya existe con revisor obligatorio (`GabFrank`) | GitHub |
| 2026-08-15 | Verificado que la migración `V192.5` (enum `tipo_dispositivo` con `WEB`) está en `v4.7.0-beta.2`, `v4.8.0` y `v4.7.0-alpha.39` → **los tres centrales productivos ya la tienen** | repo `central` |
| 2026-08-15 | `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` cargados como secrets del repo `desktop` | GitHub |

**La infraestructura está completa.** Todo lo que queda es trabajo dentro del
repo `desktop`.

---

## 1 · Alcance decidido — solo central

**Decisión 2026-08-15: la web es cliente de central, no de filial.** La app
fuerza `isLocal:false` y todo el tráfico GraphQL va a `farmacia-api` /
`bodega-api` / `alpha-api`.

Lo que **queda fuera**, y no por olvido:

| Capacidad | Por qué no |
|---|---|
| Caja / PDV con filial | El filial vive en la LAN de cada sucursal y habla HTTP plano. Servido por HTTPS público, el navegador bloquea la request antes de salir. Exponerlos exigiría un túnel `cloudflared` por filial (~20 hosts) |
| Impresión térmica ESC/POS | Vive en `electron-printer/`, es proceso main de Electron |
| IPC del main process | No existe fuera de Electron; `electron.service.ts` ya devuelve `null` y todo consumidor está detrás de `isElectron` |
| Auto-update | `electron-updater` no aplica. En web, la versión la sirve el deployment de Pages |

Queda dentro: consultas, reportes, administración, RRHH, financiero, productos —
todo lo que hoy funciona apuntando a central.

**El filial no está descartado para siempre**, pero es un proyecto de infra
aparte (un túnel por sucursal) y este plan no lo asume.

---

## 2 · Lo que se hereda gratis de la PWA

La fase A del `plan-cicd-mobile-pwa.md` —la cara— **ya está hecha y sirve tal
cual**:

```
farmacia-api.frcsuite.com   → VM DO :8082   central farmacia (canal beta)
bodega-api.frcsuite.com     → VM DO :8081   central bodega  (canal stable)
alpha-api.frcsuite.com      → mauro :8083   central alpha (túnel frc-alpha-mauro)
```

Las tres con TLS, WebSocket `101` verificado y `proxy_read_timeout 3600s`. **No
hay una sola tarea de backend o de red en este plan.** Es la diferencia grande
con la PWA, que tuvo que montar todo eso desde cero.

También se hereda el esquema de nombres, que ya estaba reservado en §3 de aquel
plan:

| Canal | Proyecto Pages | Puertas | API por defecto |
|---|---|---|---|
| alpha | `frc-desk-alpha` | `alpha.desk.frcsuite.com` | `alpha-api` |
| beta | `frc-desk-beta` | `beta.desk.frcsuite.com` | `farmacia-api` |
| prod | `frc-desk-prod` | `farmacia.desk`, `bodega.desk` | según el hostname |

---

## 3 · Diferencias con la PWA que cambian decisiones

No copiar el plan de la PWA a ciegas. Cuatro cosas son distintas:

1. **No hay service worker.** El desktop no usa `@angular/service-worker`. Eso
   elimina el problema que mató a Access en la PWA (el worker no podía instalar
   el grupo `prefetch` porque Access redirigía los assets a otro origen) — pero
   Access igual no va, por la razón de §6. Lo que sí cambia es la actualización:
   **acá el único mecanismo es el `index.html` sin cachear**, no hay diálogo de
   *Actualizar* ni versión que se quede pegada. Recargar alcanza.
2. **`useHash: true`** (`app-routing.module.ts:16`). Todas las rutas viven después
   del `#`, así que el servidor solo ve `/`. **No hace falta `_redirects`** — el
   404 de deep link, que fue el bug clásico de la PWA, acá no existe.
3. **El repo es público.** Los minutos de Actions no se facturan, a diferencia de
   `mobile-pwa`. El job web puede correr sin tacañería.
4. **El bundle es grande.** El `dist` medido son **73 MB en 1891 archivos**, con
   `main.js` de **14,9 MB** como archivo mayor. Entra cómodo en los límites de
   Pages (25 MB por archivo, 20.000 archivos) pero **la primera carga por
   Internet no se parece a abrir un `.exe` local**. Brotli del CDN lo baja
   bastante, y a partir de la segunda visita el caché inmutable de los chunks lo
   resuelve; aún así, esperar unos segundos la primera vez y no venderlo como
   instantáneo.

---

## 4 · Fase E — cambios que el repo `desktop` necesita

Ninguno es grande. **Ninguno funciona sin los otros**, y hoy el primero solo ya
rompe cualquier intento de build web.

### E1 · `src/environments/environment.web.prod.ts` — no existe

`angular.json` define la configuración `web-production` con un `fileReplacements`
hacia ese archivo, y el archivo **no está en el repo**. O sea: `npm run web:build`
falla hoy, antes de compilar nada. Es el primer paso y es trivial: copiar
`environment.web.ts` con `production: true` y `APP_CONFIG.environment: 'WEB'`.

### E2 · El esquema y el host salen del navegador, no de `conectionConfig.ts`

Es el cambio de fondo. Hoy las URLs se arman a mano con `http://` y `ws://`
fijos, a partir de un par ip/puerto:

| Archivo | Línea | Qué arma |
|---|---|---|
| `shared/services/graphql-connection.service.ts` | 163-164 | `http://…/graphql` central y local |
| `shared/services/graphql-connection.service.ts` | 167-168, 619-622 | `ws://…/subscriptions` |
| `shared/services/notification-http.service.ts` | 36 | `http://…` central |
| `shared/services/hora-servidor.service.ts` | 54 | `http://…/config/hora-servidor` |

Servida por HTTPS, **cada una de esas requests la bloquea el navegador por mixed
content**. La forma que ya funcionó en la PWA es un mapa hostname → API, con el
esquema derivado de `location.protocol`:

```ts
const API_POR_HOST: Record<string, string> = {
  'farmacia.desk.frcsuite.com': 'farmacia-api.frcsuite.com',
  'bodega.desk.frcsuite.com':   'bodega-api.frcsuite.com',
  'beta.desk.frcsuite.com':     'farmacia-api.frcsuite.com',
  'alpha.desk.frcsuite.com':    'alpha-api.frcsuite.com',
};
```

Con el mismo criterio que allá: **un solo build, varias puertas.** Una empresa
nueva es una línea del mapa y una puerta más en el proyecto de Pages, no una
compilación nueva. Un hostname fuera del mapa —una preview de Pages, `localhost`—
cae al fallback de `environment`, y que ese fallback **no sea producción** es
parte del diseño.

Y donde hoy se escribe `http://` / `ws://`, derivar:

```ts
const seguro = location.protocol === 'https:';
const httpBase = `${seguro ? 'https' : 'http'}://${host}`;
const wsBase   = `${seguro ? 'wss'  : 'ws'}://${host}`;
```

Nótese que el host de la API **ya no lleva puerto**: nginx y el túnel terminan en
443. El par ip/puerto de `localStorage` sigue gobernando en Electron sin cambios.

### E3 · Forzar `isLocal:false` en web

`graphql-connection.service.ts:164` deja `url` en `null` cuando `isLocal` es
falso, que es justo lo que se quiere. Falta que la app **no permita** ponerlo en
`true` fuera de Electron: si un usuario lo activa desde la pantalla de servidor,
la web queda intentando `https://<ip-lan>:8082` y falla sin explicación.

### E4 · `public/_headers` — control de caché

```
/index.html
  Cache-Control: no-cache
/*.js
  Cache-Control: public, max-age=31536000, immutable
/*.css
  Cache-Control: public, max-age=31536000, immutable
```

Los chunks llevan hash (`outputHashing: all`), así que `immutable` es correcto y
gratis. `index.html` no lleva hash: si el CDN lo cachea, el usuario sigue viendo
la build anterior aunque el deployment ya cambió. Sin service worker, **el
`index.html` es el único mecanismo de actualización que hay**.

### E5 · Sello de versión visible

En Electron la versión sale de `getAppVersion()` por IPC, y en web ese método
devuelve el literal `'web'` (`electron.service.ts`). Conviene que la web muestre
la versión real: el job de deploy ya parchea `package.json` con la versión del
tag —igual que hace el job de instaladores— así que alcanza con que
`environment.web.prod.ts` la lea, o con un `sello-version.mjs` como el de la PWA.
Sin esto no hay forma de saber qué build está sirviendo `farmacia.desk`.

---

## 5 · Fase D — el job de deploy

Se agrega a `.github/workflows/release.yml` como **tercer job**, hermano de
`build`, con las mismas condiciones (`needs.release.outputs.version != '' &&
skip_build != 'true'`). No toca la matriz Linux/Windows existente.

```yaml
  deploy-web:
    needs: release
    if: needs.release.outputs.version != '' && needs.release.outputs.skip_build != 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { ref: v${{ needs.release.outputs.version }} }
      - uses: actions/setup-node@v5
        with: { node-version: '22', cache: npm }     # wrangler 4 exige Node ≥ 22
      - run: npm ci --legacy-peer-deps
      - name: Parchear versión                        # misma razón que el job build
        run: node -e "..."
      - run: npm run web:build
      - name: Publicar en Pages
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          VERSION="${{ needs.release.outputs.version }}"
          case "$VERSION" in
            *-alpha*) CANAL=alpha ;;
            *-beta*)  CANAL=beta ;;
            *)        CANAL=prod ;;
          esac
          npx wrangler pages deploy dist \
            --project-name="frc-desk-${CANAL}" --branch=main --commit-dirty=true
```

Tres cosas que no se deducen del YAML:

- **El `outputPath` es `dist` a secas.** Angular 15 no genera el subdirectorio
  `browser/` que sí usa la PWA en Angular 21. Copiar la ruta de aquel workflow
  publica un directorio vacío.
- **Node 22 es obligatorio para wrangler 4.** Con el Node 18 que usan los jobs
  actuales, `npx wrangler` aborta con *"requires at least Node.js v22.0.0"*. Para
  correr a mano desde una máquina con Node 20, usar `npx wrangler@3`.
- **`prod` no se publica solo.** El caso `*)` del `case` corresponde a un release
  de `master`. Ese paso va detrás de un `workflow_dispatch` con el environment
  `production` —que ya existe en el repo con revisor obligatorio—, no del push.
  alpha y beta sí publican al generarse el release, como en la PWA.

**Rollback:** Pages guarda cada deployment; volver atrás es un click. Y como no
hay service worker, el rollback llega al usuario con un simple recargar.

---

## 6 · Fase F — protección: la misma en las cuatro puertas

**Decidido 2026-08-15: sin Access en ningún canal.** Técnicamente se podía —a
diferencia de la PWA, el desktop no tiene service worker, así que Access no
rompería nada— y aun así no va.

El razonamiento es que **Access protegería justamente lo que no tiene datos**: lo
que sirve Pages es un shell estático, HTML y JavaScript, idéntico al `.exe` que
cualquiera puede bajar del GitHub Release. Los datos están del otro lado, y ahí
la protección real es el token del ERP: el central rechaza con 401 todo lo que
llegue sin `Authorization: Token`. Poner una segunda puerta delante del shell
suma fricción para el tester sin mover la superficie de ataque.

Así que `alpha.desk`, `beta.desk`, `farmacia.desk` y `bodega.desk` quedan las
cuatro iguales y abiertas, con el login del ERP como única barrera — igual que la
PWA, y por la misma razón.

Si alguna vez hace falta filtrar —restringir alpha a la oficina, por ejemplo— una
regla WAF por IP es más barata que Access y no toca la app.

---

## 7 · Riesgos y gotchas

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | **Cada merge a `develop` publica en `alpha.desk`** | Es el mismo riesgo que ya corre en filial y en la PWA. Tratar `develop` con ese cuidado |
| 2 | Un usuario abre `farmacia.desk` creyendo que es el POS y no puede imprimir ni cobrar | Nombrar el canal en la UI y no publicitar la web como reemplazo del instalador |
| 3 | 73 MB de `dist` en cada release | Pages deduplica archivos idénticos entre deployments; los chunks con hash no se resubén si no cambiaron |
| 4 | Primera carga lenta por Internet (`main.js` 14,9 MB sin comprimir) | Brotli del CDN + `immutable` en los chunks. Esperable, no es un fallo |
| 5 | El desktop Electron **sigue hablando por IP y puerto planos** a 8081/8082 | Cerrar esos puertos sigue fuera de alcance (era la fase A3 del plan PWA, y ahora hay una razón más para no hacerlo) |
| 6 | La web y el instalador comparten versión y tag pero se despliegan distinto | El sello de versión de E5 es lo que evita confundir qué corre dónde |
| 7 | `configuracion-local.json` está versionado en git y puede empujar config de una máquina al canal | Ya documentado en el CLAUDE.md del repo; `git status` antes de commitear |

---

## 8 · Orden de ejecución

```
✅ Proyectos Pages + 4 puertas + certificados            hecho 2026-08-15
✅ Marcador de posición en los tres canales              hecho 2026-08-15
✅ environment production con revisor (ya existía)       verificado 2026-08-15
✅ V192.5 presente en los tres centrales                 verificado 2026-08-15
✅ Secrets de Cloudflare en el repo desktop              hecho 2026-08-15
────────────────────────────────────────────────────────────────────────
1 · Fase E · environment.web.prod.ts, mapa hostname→API,
             esquema derivado, isLocal, _headers, sello        ← una PR a develop
2 · Fase D · job deploy-web en release.yml                     ← misma PR
3 · Primer release alpha → validar login WEB en alpha.desk
4 · Promover a beta → correr el plan de prueba manual
5 · Deploy prod con aprobación
6 · Versión por canal en el dashboard (leer el sello, como los desktop_channel)
```

**La infraestructura no bloquea nada.** Lo que queda es todo trabajo dentro del
repo `desktop`, y cabe en una sola PR.

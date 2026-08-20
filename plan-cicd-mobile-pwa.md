# Plan — CI/CD y despliegue web de `frc-mobile-pwa`

> Escrito 2026-08-14. Todos los datos de infraestructura de este documento están
> **verificados por SSH ese día**, no tomados de la documentación previa — que
> estaba equivocada en el dato más importante (dónde vive alpha).

`frc-mobile-pwa` es el quinto repo del producto y el primero que **no tiene
equivalente de deploy** en los otros cuatro: no hay JAR que copiar, ni instalador
que firmar, ni AAB que subir a una tienda. Es un sitio estático más un service
worker. Lo que sí se hereda sin cambios es el **flujo de ramas y versionado**:
`semantic-release` sobre `develop`/`release/beta`/`master`, tres canales, merge
commit y nunca push directo.

---

## 0 · Estado de ejecución

| Fecha | Qué se hizo | Dónde |
|---|---|---|
| 2026-08-14 | Inventario corregido: alpha vive en mauro, no en la VM DO | `hosts.md`, `gotchas.md`, `CLAUDE.md` raíz |
| 2026-08-14 | `frc-alpha.service` zombi **apagado** en la VM DO; 8083 liberado | `159.203.86.103` |
| 2026-08-14 | Dashboard: `central-alpha` → `100.64.0.2`, `central-beta-piloto` retirada (`active=0`) | `dashboard/lib/config.ts` + `dash.db` |
| 2026-08-14 | **A1 parcial**: `/etc/nginx/conf.d/frc-central-api.conf` con los bloques de `farmacia-api` y `bodega-api`, `nginx -t` ok, reload aplicado, proxy verificado (401 idéntico al backend directo) | VM DO |
| 2026-08-14 | **A1 paso 4**: `SERVER_FORWARD_HEADERS_STRATEGY=NATIVE` en el `.env` de farmacia y bodega, ambas reiniciadas y verificadas. Backups en `.env.bak-20260814` | VM DO |
| 2026-08-14 | Registros A `farmacia-api` y `bodega-api` → `159.203.86.103`, **sin proxear**, TTL 300 | Cloudflare, zona `frcsuite.com` |
| 2026-08-14 | **A1 COMPLETA**: cert `frcsuite-central` emitido (2 SAN, vence 2026-11-12), redirect 80→443, renovación automática programada | VM DO |

| 2026-08-14 | Limpieza: `server` blocks de `bodegafranco.com` fuera de `nginx.conf` y cert vencido borrado. Backup `nginx.conf.bak-20260814` | VM DO |
| 2026-08-14 | **A2 COMPLETA**: `cloudflared 2026.8.2` instalado en mauro, túnel `frc-alpha-mauro`, CNAME `alpha-api` proxeado, 4 conexiones registradas. mauro no abrió ni un puerto | mauro |

| 2026-08-14 | **D parcial**: 3 proyectos de Pages creados con sus 4 puertas, y un marcador de posición desplegado en cada uno para validar la cadena sin tocar el repo | Cloudflare Pages |

| 2026-08-14 | **B + C + E hechas** en la rama `ci/pipeline-y-despliegue`, desde un **worktree aparte** para no chocar con la otra sesión. Build AOT en verde y 433 tests. Sin pushear | worktree del repo PWA |

| 2026-08-14 | PR **#4** abierta contra `develop`; secrets `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` cargados; environment `production` creado con revisor obligatorio y **sin bypass de admin** | GitHub |

| 2026-08-15 | **Access operativo** sobre `alpha.app.frcsuite.com`: aplicación self-hosted, política *allow* por email, sesión de 1 mes, login por PIN de un solo uso | Cloudflare Zero Trust |

> ⚠️ **`develop` todavía no tiene el sello de versión ni el mecanismo de
> actualización.** `scripts/sello-version.mjs`, `core/actualizacion/` y el
> `appData` de `ngsw-config.json` viven en las PR abiertas. Los archivos de CI
> no dependen de eso y compilan igual, pero **hasta que se mergeen las PR un
> release no puede nombrarse a sí mismo en la app**: el `package.json` parcheado
> no llega a ninguna pantalla. Mergear primero.

> ⚠️ **No se agregó `prettier --check` al CI.** Hay **214 archivos** del repo que
> no pasan el formateo; el paso tumbaría toda PR por código ajeno al cambio. El
> orden correcto es un `chore` que corra `prettier --write .` sobre todo el repo
> y recién después sumar el paso.

| 2026-08-15 | **PR #5 y #4 mergeadas.** El pipeline corrió solo y de punta a punta: tag **`v1.0.0-alpha.1`**, GitHub Release, build sobre el tag y publicación en Pages. `deploy-prod` saltado, como corresponde a un prerelease | GitHub + Cloudflare |

**Lo que quedó probado con ese primer release** — los tres archivos que no se
pueden validar en desarrollo:

| Chequeo | Resultado |
|---|---|
| App publicada (ya no el marcador) | `<title>Bodega Franco</title>` |
| Deep link `/inventario/12` | **200** → `_redirects` funciona |
| `Cache-Control` de `ngsw.json` e `index.html` | **`no-cache`** → `_headers` funciona |
| `ngsw.json` servido | 200 |

> ⚠️ **Desde ahora, cada merge a `develop` publica en alpha.** Es el riesgo #5 de
> la sección de riesgos, y ya está vivo.
>
> El primer release **no lleva el sello de versión**, porque `develop` todavía no
> tiene `scripts/sello-version.mjs`: la app muestra la fecha de compilación. Se
> arregla solo cuando entren las PR de código.

| 2026-08-15 | **Cadena de código mergeada** (#1, #2, #3) → `v1.0.0-alpha.2` y `v1.0.0-alpha.3` publicadas solas. El merge de la #3, que era `docs:`, **no generó release** y el deploy ni arrancó | GitHub |
| 2026-08-15 | **Fase F**: `master` y `develop` protegidas igual que central —0 aprobaciones, check `build` obligatorio, `strict`, `enforce_admins`, sin force push— y **squash desactivado a nivel repo** | GitHub |

| 2026-08-15 | PR **#6**: `npm test` también en los jobs de deploy. El merge corrió `release` y **no creó versión** (commits `ci:`), así que nada se republicó | GitHub |

| 2026-08-15 | PR **#7** (`fix:` del meta de app instalable) → **`v1.0.0-alpha.4`** publicada. Primer ciclo completo con el gate nuevo: versión → **tests** → build → publicación | GitHub + Cloudflare |

> **El dominio propio tarda uno o dos minutos más que `*.pages.dev`** en apuntar
> al deployment nuevo. No es caché —`cf-cache-status: DYNAMIC` y `no-cache` bien
> servidos—, es la propagación del routing de Pages. Si justo después de un
> release el dominio sirve la versión anterior, esperar antes de diagnosticar.

> `/index.html` responde **308 hacia `/`**: es la redirección canónica de Pages.
> El service worker la sigue sin problema; no es un fallo aunque un `curl` sin
> `-L` devuelva vacío.

**Las convenciones de commit quedaron verificadas en vivo, no asumidas:** el
merge de la #3 (`docs:`) y el de la #6 (`ci:`) **no generaron release** y sus
deploys ni arrancaron. Solo `feat:` y `fix:` publican.

**El sello ya funciona.** `alpha.app` sirve
`appData: {etiqueta: "v1.0.0-alpha.3", commit: "31c3e55"}`: la PR #2 trajo
`scripts/sello-version.mjs`, así que la app se nombra sola y el diálogo de
actualización dice la versión real, no la fecha.

> **`release/beta` no existe todavía, y es a propósito.** Crear la rama dispara
> un release y publica en `beta.app`. Beta tiene que recibir una build
> **promovida** después de correr el plan de testeo, no la primera que pase.

**Validación A1, desde fuera de la red** (2026-08-14):

| Chequeo | farmacia-api | bodega-api |
|---|---|---|
| `POST /graphql` | 401 (auth requerida) | 401 |
| Redirect 80 → 443 | 301 | 301 |
| Cadena de certificados | válida | válida |
| **Upgrade WebSocket `/subscriptions`** | **101** | **101** |
| `POST /login` | 401 con credenciales falsas | — |

El 101 es el chequeo que más suele fallar y por eso está acá: con la nube gris
no hay proxy de Cloudflare cortando conexiones ociosas a los ~100 s, y nginx
tiene `proxy_read_timeout 3600s`.

**Validación A2** (2026-08-14): `alpha-api.frcsuite.com` responde 401 en
`/graphql` y `/login`, **101 en el upgrade WebSocket**, con certificado Universal
de Cloudflare.

**Mixed content: resuelto en los tres canales.** Los dos bloqueantes de
infraestructura están cerrados; lo que queda es repo y Pages.

Dos cosas aprendidas reiniciando:

- **El central tarda ~2 minutos en levantar.** Farmacia 14:42:45 → 14:44:36.
- Cada reinicio deja un puñado de `ERROR … Broken pipe` en el journal que son
  **del proceso viejo muriendo**, no del nuevo: son los desktops que tenían
  suscripciones GraphQL abiertas. Se distinguen por el PID.

---

## 1 · Punto de partida

### Lo que el repo ya tiene resuelto

- **El mecanismo de actualización está construido y probado en un Android real.**
  `core/actualizacion/` escucha `VERSION_READY`, consulta al arrancar y cada 30
  minutos, ofrece un diálogo *Actualizar / Ahora no*, reoferta a las 2 horas y
  recarga al aplicar. Con `registrationStrategy: 'registerImmediately'`, que fue
  lo que costó encontrar.
- **El versionado ya está cableado a `package.json`.** `scripts/sello-version.mjs`
  escribe `src/app/core/sello-version.ts` antes de compilar y sella
  `appData.etiqueta` en el `ngsw.json` de `dist/` después. Hoy muestra la fecha
  «(sin versionar)» **solo porque `package.json` está en `0.0.0`**. En cuanto
  `semantic-release` ponga un número real, la pantalla lo muestra sin tocar
  código.
- **CORS no es problema.** `FrancoSystemsApplication.java:104-115` del central
  permite `*` en origins, methods y headers. No hay trabajo de backend por acá.

### Lo que falta

> Este era el estado al abrir el plan. **Todo resuelto**, salvo `release/beta`
> que espera al merge de las PR.

| # | Hueco | Impacto | Estado |
|---|---|---|---|
| 1 | Sin `.github/`, sin `.releaserc.json`, sin tags, sin `release/beta` | No hay CI ni versión | ✅ PR #4 · falta crear `release/beta` |
| 2 | `angular.json` sin `fileReplacements` → `environment.prod.ts` código muerto; toda build apuntaba a `http://159.203.86.103:8083` | El canal no cambia de backend | ✅ PR #4 — resuelto con el mapa hostname→API, y `environment.prod.ts` eliminado |
| 3 | Sin fallback SPA ni control de caché HTTP | Deep links 404; updates tarde o inconsistentes | ✅ PR #4 |
| 4 | El central habla **HTTP plano** | **Bloqueante duro**: mixed content | ✅ Fase A1 |
| 5 | Alpha vive en un host **sin IP pública** | La PWA pública no puede alcanzarlo | ✅ Fase A2 |

---

## 2 · La infraestructura real (verificada 2026-08-14)

```
                 ┌─ VM DigitalOcean · frc-servidor · 159.203.86.103 (172.25.1.200)
                 │   nginx + certbot YA instalados y en uso
                 │     · frc-ecommerce.com, *.frc-ecommerce.com, app.frc-ecommerce.com
                 │     · donfrancorestaurante.com
                 │   :8082  central farmacia  4.7.0-beta.2   ← canal beta, productivo
                 │   :8081  central bodega    4.8.0          ← canal stable, productivo
                 │   (nada mas: alpha NO vive aca)
                 │
                 └─ mauro · 172.25.0.172 · tailnet 100.64.0.2 · SIN IP PÚBLICA
                     :8083  central alpha   4.7.0-alpha.39  ← TODO el canal alpha
                     :8080  filial alpha    5.0.0-alpha.7
                     PG 5551 / 5552 / 5553 locales (la DB `alpha` viva es esta)
```

**Dos hallazgos que cambian planes anteriores:**

1. **nginx y certbot ya están en la VM DO.** El `runbook-cloudflare.md` del repo
   de la PWA asume que hay que montar TLS desde cero con Cloudflare Origin CA.
   No hace falta: son dos `server` blocks y un `certbot --nginx`.
2. **El canal alpha entero (central + filial) vive en mauro, que no tiene IP
   pública.** Ningún cliente servido por HTTPS público lo alcanza sin un túnel.
   En la VM de producción había un `frc-alpha.service` congelado desde julio,
   apagado el 2026-08-14, y una instancia «beta piloto» en el 8084 que ya no
   existía. **Alpha no está en el servidor central y no vuelve.**

---

## 3 · Decisiones tomadas

| Decisión | Elección | Por qué |
|---|---|---|
| Hosting del estático | **Cloudflare Pages**, 3 proyectos | $0, cero RAM propia, TLS y CDN incluidos, rollback por deployment. El `dist` son 157 archivos / 14 MB, muy por debajo de los límites (20.000 archivos, 25 MB por archivo) |
| TLS del central | **nginx + Let's Encrypt, DNS sin proxear** | Reusa lo que ya está instalado. Evita el corte de WebSocket ocioso a ~100 s de Cloudflare, que muerde cuando se porte el transporte WS de las suscripciones |
| Versionado | `semantic-release`, idéntico a los otros 4 repos | El sello ya está escrito para esto |
| Deploy alpha/beta | Automático al generarse el release | Es una PWA: el costo de publicar es subir archivos |
| Deploy prod | `workflow_dispatch` con aprobación | Mismo criterio que el deploy del central |

### Dominio: `frcsuite.com`

Zona **registrada el 2026-08-14 en Cloudflare**, con los NS de Cloudflare y sin
un solo registro. Es la mejor situación posible: misma cuenta que Pages y Tunnel,
y nada que romper. Las otras zonas quedan como están —`frc-ecommerce.com` para
el e-commerce y efact, `francoarevalos.com` para infra interna, y
`farmaciafrancopy.com` fuera de juego porque vive en Hostinger y su zona sirve
el control server de la VPN.

**El esquema separa cliente, empresa y canal**, y contempla que el desktop
también se sirve como web:

```
MOBILE (Pages)                     DESKTOP WEB (Pages, más adelante)
  farmacia.app.frcsuite.com   →      farmacia.desk.frcsuite.com
  bodega.app.frcsuite.com     →      bodega.desk.frcsuite.com
  beta.app.frcsuite.com       →      beta.desk.frcsuite.com
  alpha.app.frcsuite.com      →      alpha.desk.frcsuite.com

APIs — planas, dos niveles a propósito
  farmacia-api.frcsuite.com   → DO :8082      ✅ operativa
  bodega-api.frcsuite.com     → DO :8081      ✅ operativa
  alpha-api.frcsuite.com      → mauro :8083   ✅ operativa (túnel)
```

| Canal | Proyecto Pages | Puertas | API por defecto |
|---|---|---|---|
| alpha | `frc-pwa-alpha` | `alpha.app` | `alpha-api` |
| beta | `frc-pwa-beta` | **`farmacia.app`** + `beta.app` (ensayo) | `farmacia-api` |
| prod | `frc-pwa-prod` | `bodega.app` | `bodega-api` |

> ⚠️ **`beta` es la red de farmacia, no un laboratorio.** Corregido el 2026-08-20: `farmacia.app` colgaba del proyecto `prod` y habría servido builds estables a una red cuyo central corre la serie beta — el cliente detrás de su propio backend. Ahora `farmacia.app` sale del proyecto beta y `bodega.app` queda sola en `prod`. La puerta `beta.app` sigue existiendo como ensayo interno.

> ⚠️ **Las APIs van a dos niveles a propósito.** El certificado Universal de
> Cloudflare cubre `frcsuite.com` y `*.frcsuite.com`, **no** un tercer nivel:
> `alpha.api.frcsuite.com` proxeado exigiría Advanced Certificate Manager
> ($10/mes). Los dominios de Pages se salvan porque Cloudflare emite un
> certificado propio por hostname, pero el del túnel **va proxeado sí o sí**.

**Decidido:** el canal prod apunta a **bodega `:8081`** (canal stable del
backend, y la marca de la app es «Bodega Franco»). Farmacia, que hoy corre canal
beta, queda como default del canal beta de la app. Cambiarlo es un string en
`environment.prod.ts`.

### Pendiente (no bloquea empezar)

- Si más adelante conviene mover también el e-commerce o el dashboard a
  `frcsuite.com`, es una migración aparte. Este plan no la asume.

---

## 4 · Fase A — Infraestructura (prerequisito de todo deploy real)

Es lo único que puede bloquear al resto, así que va primero o en paralelo con B y C.

### A1 · TLS para el central productivo (VM DO)

1. En Cloudflare, crear los registros A de `farmacia-api` y `bodega-api` a
   `159.203.86.103` **con la nube gris** (DNS only). En naranja, Cloudflare
   terminaría el TLS y cortaría los WebSocket ociosos a ~100 s.
2. Agregar dos `server` blocks en `/etc/nginx/conf.d/`, uno por instancia:
   ```nginx
   map $http_upgrade $connection_upgrade { default upgrade; '' close; }

   server {
       listen 443 ssl http2;
       server_name farmacia-api.frcsuite.com;
       client_max_body_size 25m;              # fotos de rendición y cupones
       location / {
           proxy_pass http://127.0.0.1:8082;
           proxy_http_version 1.1;
           proxy_set_header Upgrade    $http_upgrade;
           proxy_set_header Connection $connection_upgrade;
           proxy_set_header Host              $host;
           proxy_set_header X-Real-IP         $remote_addr;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto https;
           proxy_read_timeout 3600s;          # suscripciones GraphQL largas
           proxy_send_timeout 3600s;
           proxy_buffering off;
       }
   }
   ```
   El default de nginx (60 s) cortaría las suscripciones cada minuto.
3. `certbot --nginx -d farmacia-api.frcsuite.com -d bodega-api.frcsuite.com`.
4. En cada instancia, `application.properties`: `server.forward-headers-strategy=NATIVE`.
   Sin esto Spring cree que la request llegó por HTTP y puede emitir redirects
   `http://` que el navegador bloquea como mixed content. **Requiere reiniciar
   las dos instancias productivas → fuera de horario comercial.**
5. Validar: `curl -sI https://…/graphql`, un login real, y una conexión WS que
   **sobreviva 3 minutos** sin tráfico.

### A2 · Camino público para alpha

**Hecha el 2026-08-14.** `cloudflared 2026.8.2` instalado desde el repo oficial
en mauro (Fedora 42), túnel **`frc-alpha-mauro`** gestionado desde Cloudflare —
la configuración de ingress vive en la nube, no en un `config.yml` local— y
`alpha-api.frcsuite.com` como CNAME proxeado a `<tunnel-id>.cfargotunnel.com`.

El servicio queda `enabled` con 4 conexiones registradas, y el token en
`/etc/cloudflared/token` con permisos `0600 root`. **mauro no abrió ni un puerto**:
el túnel es una conexión saliente.

**Access va sobre la PWA, no sobre la API.** Poner Access delante de un endpoint
que consume una SPA por XHR es la desconfiguración clásica: Access autentica con
una cookie en el dominio protegido, y la PWA (`alpha.app`) y la API (`alpha-api`)
son orígenes distintos, así que Apollo no la mandaría —salvo configurar
`credentials: 'include'` y el CORS de la aplicación Access— y cada request
rebotaría al login con un error de CORS opaco en vez de un 401 legible.

La aplicación de Access se crea sobre `alpha.app.frcsuite.com` **como parte de la
fase D**, cuando ese hostname exista. Mientras tanto el central rechaza con 401
todo lo que llegue sin `Authorization: Token`.

**Por qué no el tailnet, que parecía la respuesta obvia:** headscale ya llega a
mauro, así que la tentación es no publicar nada. El problema es que **la PWA
exige HTTPS de los dos lados**: servida desde `https://alpha.app.frcsuite.com`,
una request a `http://100.64.0.2:8083` la bloquea el navegador por mixed content
antes de salir. Y **headscale no emite certificados para nodos** — `tailscale
cert` / `tailscale serve` los provee el servidor de coordinación de Tailscale
SaaS; el cert LE que existe hoy es para `hs.farmaciafrancopy.com`, el control
server, no para los nodos.

Se podía resolver igual —A record a `100.64.0.2`, cert LE por desafío DNS-01,
nginx en mauro— y queda como **escape documentado**. Se descartó porque obliga a
cada tester a estar enrolado, y **en iPhone eso es engorroso**, con iOS siendo un
objetivo declarado de este repo. El túnel prueba desde cualquier teléfono.

### A3 · Cerrar los puertos planos — **todavía NO**

El Paso 8 del `runbook-cloudflare.md` sigue pendiente y ahora se sabe que es más
caro de lo que decía: no solo la app Android apunta a `159.203.86.103:8082`,
**el desktop también** habla por IP y puerto. Cerrar 8081/8082 deja fuera a las
dos flotas. Es un proyecto aparte, posterior a que ambas migren a los nombres
HTTPS.

---

## 5 · Fase B — CI (gate de PR)

`.github/workflows/ci.yml`, disparado en PR a `develop`, `release/*`, `master`:

```yaml
- uses: actions/setup-node@v5
  with: { node-version: '20.20', cache: npm }
- run: npm ci
- run: npm run build      # el gate real: AOT typechequea las plantillas
- run: npm test           # 493 tests con vitest
```

Notas que no se deducen del YAML:

- **`tsc --noEmit` no alcanza** y por eso el gate es `npm run build`: un
  `p.ciudad.nombre` inexistente en una plantilla pasa limpio por `tsc` y lo caza
  solo el AOT.
- `prebuild`/`pretest` corren `sello-version.mjs` y `face-models.mjs`. El segundo
  copia ~10 MB desde `node_modules`, así que **`npm ci` es obligatorio antes**.
- **Este repo es privado**: a diferencia de los otros cuatro, los minutos de
  Actions se facturan. Vale la pena el `cache: npm` y no correr matrices de SO —
  con `ubuntu-latest` alcanza, no hay nada nativo.
- El budget de `initial` es 1 MB (error). Si una PR lo supera, falla acá y no en
  el release, que es exactamente donde se quiere que falle.

---

## 6 · Fase C — `semantic-release`

`.releaserc.json`, idéntico a los otros cuatro repos:

```json
{
  "branches": [
    "master",
    { "name": "develop", "prerelease": "alpha" },
    { "name": "release/*", "prerelease": "beta" }
  ],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/github"
  ]
}
```

`.github/workflows/release.yml` se copia del repo `desktop`, que ya resolvió dos
cosas no obvias:

1. **`semantic-release` no commitea el `package.json`.** El job de build hace
   checkout del tag y **parchea `package.json` con la versión** antes de
   compilar. Sin ese paso el sello seguiría diciendo `0.0.0` y la app mostraría
   la fecha para siempre.
2. **Detección de release redundante.** Compara el árbol git del tag nuevo contra
   el último tag del mismo canal; si son idénticos byte a byte —típico de un
   «Update branch» en la PR de promoción— **no publica**. Sin eso, cada
   promoción empujaría una actualización a toda la flota por código idéntico, y
   en una PWA eso es un diálogo *Actualizar* a cada usuario por nada.

---

## 7 · Fase D — Deploy a Cloudflare Pages

Tres proyectos: `frc-pwa-alpha`, `frc-pwa-beta`, `frc-pwa-prod`. El canal sale
del tag, con el mismo `case` que usa `desktop`:

```bash
case "$VERSION" in
  *-alpha*) CANAL=alpha ;;
  *-beta*)  CANAL=beta ;;
  *)        CANAL=prod ;;
esac
npx wrangler pages deploy dist/mobile-pwa/browser \
  --project-name="frc-pwa-${CANAL}" --branch=main --commit-dirty=true
```

Secrets: `CLOUDFLARE_API_TOKEN` (scope *Cloudflare Pages: Edit*) y
`CLOUDFLARE_ACCOUNT_ID`.

- **Dominios personalizados por proyecto** (Pages emite un certificado propio por
hostname, así que el tercer nivel no es problema):

| Proyecto | Puertas |
|---|---|
| `frc-pwa-alpha` | `alpha.app.frcsuite.com` |
| `frc-pwa-beta` | `beta.app.frcsuite.com` |
| `frc-pwa-prod` | `farmacia.app.frcsuite.com`, `bodega.app.frcsuite.com` |

**Estado 2026-08-14:** los tres proyectos existen (`frc-pwa-alpha`,
`frc-pwa-beta`, `frc-pwa-prod`), las cuatro puertas están asociadas y cada
proyecto tiene un marcador de posición desplegado — se subió con `wrangler pages
deploy` desde un directorio con un solo `index.html`, **sin compilar el repo**,
porque `npm run build` mata el `ng serve` que pueda estar corriendo.

Dos cosas que no se deducen del panel:

- **Pages no crea el CNAME solo.** Asociar el dominio personalizado por API lo
  deja en `initializing` hasta que exista el registro; hay que crearlo a mano
  apuntando a `<proyecto>.pages.dev`, proxeado.
- **El certificado de un hostname de tres niveles lo emite Pages**, no el
  Universal de la zona: aparece como `pending` unos minutos y lo firma Google
  Trust Services. Es lo que hace viable el esquema `<empresa>.app.frcsuite.com`
  sin pagar ACM.

**Access: probado y descartado el 2026-08-15.** Rompía el service worker — el
detalle está abajo. Lo que sigue describe cómo se montó, porque el
procedimiento sirve para cualquier app que **no** sea una PWA.

**Access, hecho el 2026-08-15.** Aplicación self-hosted sobre
`alpha.app.frcsuite.com`, política *allow* por email y sesión de 1 mes. La
organización Zero Trust es **`frcsuite`** (plan Free), renombrada el 2026-08-15
desde el `bitter-band-4f79` autogenerado: el nombre aparece en la URL de login
que ve el tester, y cambiarlo **después** de repartir el link rompería las
inscripciones de WARP y dejaría links muertos. Se hizo antes de invitar a nadie,
que es cuando sale gratis.

**Sin proveedor de identidad configurado, el login es PIN de un solo uso por
email**: el tester recibe un código y entra, sin cuenta de Google ni nada que
instalar. Para una lista chica es lo que conviene.

Verificado: `alpha.app` sin sesión devuelve **302** al login de Access; las otras
tres puertas siguen en **200**; y `alpha-api` sigue devolviendo el **401 del
ERP**, no un redirect —que es justamente el fallo que se evitó al no poner
Access sobre la API—.

> ⚠️ El token de Cloudflare **sí puede** crear aplicaciones y políticas de
> Access. Lo que no puede es **leer la organización** (`/access/organizations`
> devuelve *Authentication error*), porque eso necesita el permiso *Access:
> Organizations, Identity Providers, and Groups*. Si un día hace falta crear la
> organización por API, ese permiso hay que agregarlo.

Agregar un tester es una línea en la política, desde el panel o por API.

> ## ⚠️ Se quitó el mismo día: Access es incompatible con el service worker
>
> Probando en un dispositivo real apareció en consola, en cada carga, un CORS
> contra `frcsuite.cloudflareaccess.com` al pedir `manifest.webmanifest`, y un
> `Response not Ok (fetchAndCacheOnce)`.
>
> **Access intercepta todas las rutas del hostname**, y el grupo `app` del
> service worker está en `prefetch` con el shell entero adentro. El worker pide
> esos archivos, Access lo manda al login —otro origen—, el CORS lo bloquea y el
> grupo **nunca termina de instalarse**: la versión nueva no se activa. La
> navegación inicial funciona porque lleva la cookie, así que el fallo se
> disfraza de "errores raros en consola" y no de "la app no se actualiza".
>
> **No hay arreglo limpio:** bypassear los assets obliga a incluir
> `/index.html`, y como el `_redirects` sirve ese archivo para toda ruta, Access
> queda sin nada que proteger.
>
> **Decisión: alpha queda sin Access**, igual que beta y prod. La protección
> real es el login del ERP: el central rechaza con 401 todo lo que llegue sin
> `Authorization: Token`, y el shell estático no tiene datos. Si alguna vez hace
> falta un filtro, una regla WAF no toca al service worker. Es la protección de alpha
que quedó pendiente de A2 — ahí el flujo de login por navegador funciona natural,
sin tocar Apollo.

**alpha y beta**: se disparan solos al crearse el release.
- **prod**: `workflow_dispatch` con GitHub Environment `production` y required
  reviewers, igual que el `Deploy` del central.

**Rollback:** Pages guarda cada deployment; volver atrás es un click o
`wrangler pages deployment`. El service worker adopta cualquier manifiesto
distinto del actual, así que el rollback **sí se propaga** a los clientes. Efecto
cosmético a esperar: el diálogo va a decir *Actualizar a v1.2.0* estando en
v1.2.1. Es raro de leer, no es un fallo.

---

## 8 · Fase E — Cambios que el deploy exige en el repo

Ninguno es grande, y **ninguno funciona sin los otros**.

### E1 · El backend por defecto sale del hostname, no del build

**Decidido: un solo build, varias puertas.** En vez de tres configuraciones de
`angular.json` con `fileReplacements`, un mapa `hostname → API` en el código:

```ts
const API_POR_HOST: Record<string, string> = {
  'farmacia.app.frcsuite.com': 'https://farmacia-api.frcsuite.com',
  'bodega.app.frcsuite.com':   'https://bodega-api.frcsuite.com',
  'beta.app.frcsuite.com':     'https://farmacia-api.frcsuite.com',
  'alpha.app.frcsuite.com':    'https://alpha-api.frcsuite.com',
};
```

Por qué es mejor que `fileReplacements`:

- **Una empresa nueva es una línea**, no una compilación nueva ni un proyecto de
  Pages nuevo. Se agrega la puerta al proyecto y la entrada al mapa.
- **El artefacto que se prueba en beta es byte a byte el que va a prod.** Con
  tres builds, no.
- Es más honesto: una PWA **sí sabe** desde qué host se sirvió. El canal lo
  sigue definiendo qué proyecto de Pages sirvió la página, que es lo que
  gobierna el tren de releases.

`ServerConfigService` ya lee `environment.defaultServerUrl` **solo cuando no hay
nada en `localStorage`**, así que el cambio es acotado: reemplazar esa constante
por una consulta al mapa con `location.hostname`, y dejar el valor de
`environment` como fallback para `localhost` en desarrollo. El usuario sigue
pudiendo cambiar de servidor desde el login o desde Mi cuenta.

> Un hostname que no esté en el mapa —una preview de Pages, por ejemplo— cae al
> fallback. Que ese fallback **no sea producción** es parte del diseño.

### E2 · `public/_redirects` — fallback SPA

```
/*    /index.html   200
```

Sin esto, entrar directo a `/inventario/12` o recargar en cualquier ruta que no
sea `/` devuelve 404. Es el error más fácil de no ver en desarrollo, porque
`ng serve` ya hace el fallback.

### E3 · `public/_headers` — control de caché

```
/index.html
  Cache-Control: no-cache
/ngsw.json
  Cache-Control: no-cache
/ngsw-worker.js
  Cache-Control: no-cache
/*.js
  Cache-Control: public, max-age=31536000, immutable
/*.css
  Cache-Control: public, max-age=31536000, immutable
```

`ngsw.json` y `ngsw-worker.js` **no llevan hash en el nombre**. Si el CDN los
cachea, el service worker sigue viendo el manifiesto viejo y la actualización
llega tarde o —peor— mezclada. Los chunks sí llevan hash (`outputHashing: all`),
así que ahí `immutable` es correcto y gratis.

### E4 · `.nvmrc` con `20.20`

Para que CI, dev y cualquiera que clone usen la misma versión que declara el
`package.json` del repo.

### E5 · Opcional — `jira-receiver.yml`

Los otros cuatro repos lo tienen. Suma este repo al Jira Auto-Agent. No urgente.

---

## 9 · Fase F — Configuración del repositorio

1. **Cerrar las PRs abiertas primero**, en orden: #1 (`feature/solicitud-pago` →
   `develop`), después #2, después #3. La #2 sale de la rama de la #1 a propósito;
   al revés no se puede.
2. Crear `release/beta` desde `develop` **después** de esos merges, para que beta
   no nazca vacío.
3. Proteger `master`, `release/beta` y `develop` con `enforce_admins=true`, PR
   obligatoria y el check de CI como required.
4. Dejar **merge commit** como estrategia por defecto del repo y desactivar
   squash: `release/beta → master` con squash colapsa los `feat:`/`fix:` y
   `semantic-release` calcula mal el bump. Los otros repos confían en la
   disciplina; acá conviene que el botón directamente no exista.

---

## 10 · Fase G — Observabilidad

El dashboard de `frc-cicd` puede saber qué versión corre cada canal **sin agente
ni endpoint nuevo**: `GET https://<canal>/ngsw.json` devuelve
`appData.etiqueta`, que es exactamente la versión sellada en la build.

Agregar tres instancias `kind: "pwa_channel"` en `dashboard/lib/config.ts`, del
mismo modo que ya existen los `desktop_channel`.

---

## 11 · Riesgos y gotchas

| # | Riesgo | Mitigación |
|---|---|---|
| 1 | ~~Mixed content~~ | ✅ Resuelto 2026-08-14 en los tres canales |
| 2 | ~~Alpha inalcanzable desde una PWA pública~~ | ✅ Resuelto 2026-08-14: túnel `frc-alpha-mauro` |
| 3 | **mauro es SPOF y está en retiro** (offline 2026-08-08→11) y hostea el canal alpha completo | Asumido para alpha. No poner nada más ahí |
| 4 | Cerrar 8081/8082 deja fuera a la app Android **y al desktop** | A3 queda explícitamente fuera de alcance |
| 5 | **Un `fix:` mergeado a `develop` llega a los teléfonos alpha en minutos.** Es la primera vez que este cliente se propaga solo — antes había que subir un AAB a mano | Tratar `develop` con el mismo cuidado que en filial, donde el cron de 15 min ya enseñó la lección |
| 6 | La flota **no queda alineada al instante**: el usuario puede postergar 2 horas | No prometer propagación inmediata al describir un release |
| 7 | Repo privado → minutos de Actions facturados | Un solo runner Linux, `cache: npm`, sin matriz |
| 8 | Release publicado sin artefacto si el build falla después del tag | El gate de CI en la PR lo caza antes; el job de build corre sobre el tag ya creado |
| 9 | Los 10 MB de modelos faciales viajan en cada deploy | Pages deduplica archivos idénticos entre deployments |

---

## 12 · Orden de ejecución

```
✅ Fase A1 · TLS de farmacia y bodega                    hecho 2026-08-14
✅ Fase A2 · túnel + DNS de alpha                        hecho 2026-08-14
✅ Fase D  · 3 proyectos Pages + 4 puertas + certs       hecho 2026-08-14
✅ Fase B  · ci.yml                                      PR #4
✅ Fase C  · .releaserc.json + release.yml               PR #4
✅ Fase E  · mapa hostname→API, _redirects, _headers     PR #4
✅          secrets + environment production con revisor hecho 2026-08-14
──────────────────────────────────────────────────────────────────────
✅ Fase D  · PR #5 y #4 mergeadas, v1.0.0-alpha.1 publicada  hecho 2026-08-15
──────────────────────────────────────────────────────────────────────
✅ Fase F  · master y develop protegidas, squash off       hecho 2026-08-15
✅          PR #1, #2 y #3 mergeadas → alpha.2 y alpha.3   hecho 2026-08-15
──────────────────────────────────────────────────────────────────────
1 · Correr el plan de testeo manual contra alpha.app (55 casos pendientes)
2 · Crear release/beta cuando se promueva, y protegerla igual
3 ·           primer release alpha → validar en un Android y en un iPhone
4 ·           Access sobre alpha.app (manual, por el panel)
5 ·           chore: prettier --write . y sumar el paso al CI
6 ·           deploy beta → correr el plan de testeo manual
7 ·           deploy prod con aprobación
8 · Fase G · versión por canal en el dashboard
```

**La infraestructura ya no bloquea nada.** Lo que queda es trabajo de repo, y
puede arrancar apenas se cierren las PR abiertas.

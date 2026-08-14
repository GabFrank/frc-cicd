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

**Lo que falta de A1:** los registros A en `frcsuite.com` y `certbot --nginx`.
Necesita una credencial de Cloudflare — la del `.env` de `frc-cicd` es R2-scoped
y no ve zonas.

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

| # | Hueco | Impacto |
|---|---|---|
| 1 | Sin `.github/`, sin `.releaserc.json`, sin tags, sin `release/beta` | No hay CI ni versión |
| 2 | `angular.json` **no tiene `fileReplacements`** → `environment.prod.ts` es código muerto; toda build apunta a `http://159.203.86.103:8083` | El canal no cambia de backend |
| 3 | Sin fallback SPA ni control de caché HTTP | Deep links 404; updates que llegan tarde o inconsistentes |
| 4 | El central habla **HTTP plano** | **Bloqueante duro**: mixed content |
| 5 | Alpha vive en un host **sin IP pública** | La PWA pública no puede alcanzarlo |

---

## 2 · La infraestructura real (verificada 2026-08-14)

```
                 ┌─ VM DigitalOcean · frc-servidor · 159.203.86.103 (172.25.1.200)
                 │   nginx + certbot YA instalados y en uso
                 │     · frc-ecommerce.com, *.frc-ecommerce.com, app.frc-ecommerce.com
                 │     · donfrancorestaurante.com
                 │   :8082  central farmacia  4.7.0-beta.2   ← canal beta, productivo
                 │   :8081  central bodega    4.8.0          ← canal stable, productivo
                 │   :8083  ⚰️ frc-alpha zombi 4.1.0-alpha.67 — APAGADO 2026-08-14
                 │   :8084  ⚰️ no escucha
                 │
                 └─ mauro · 172.25.0.172 · tailnet 100.64.0.2 · SIN IP PÚBLICA
                     :8083  central alpha   4.7.0-alpha.39  ← el alpha DE VERDAD
                     :8080  filial alpha    5.0.0-alpha.7
                     PG 5551 / 5552 / 5553 locales
```

**Dos hallazgos que cambian planes anteriores:**

1. **nginx y certbot ya están en la VM DO.** El `runbook-cloudflare.md` del repo
   de la PWA asume que hay que montar TLS desde cero con Cloudflare Origin CA.
   No hace falta: son dos `server` blocks y un `certbot --nginx`.
2. **El canal alpha entero (central + filial) vive en mauro, que no tiene IP
   pública.** Ningún cliente servido por HTTPS público lo alcanza sin un túnel.

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

| Canal | PWA | API | Apunta a |
|---|---|---|---|
| alpha | `movil-alpha.frcsuite.com` | `alpha-api.frcsuite.com` | mauro `:8083` **vía Cloudflare Tunnel** |
| beta | `movil-beta.frcsuite.com` | `farmacia-api.frcsuite.com` | DO `:8082` (farmacia, `4.7.0-beta.2`) |
| prod | `movil.frcsuite.com` | `bodega-api.frcsuite.com` | DO `:8081` (bodega, `4.8.0`) |

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

mauro no tiene dónde abrir un puerto. **Decidido: Cloudflare Tunnel + Access.**

`cloudflared` en mauro —hoy no está instalado— publicando
`alpha-api.frcsuite.com` → `http://127.0.0.1:8083`. Sin IP pública, sin puertos
abiertos, con TLS. Encima, **Cloudflare Access** con lista de mails (gratis hasta
50 usuarios) para que alpha no quede abierto a internet: es una instancia de
prueba, pero con datos parecidos a los reales y el mismo login del ERP.

**Por qué no el tailnet, que parecía la respuesta obvia:** headscale ya llega a
mauro, así que la tentación es no publicar nada. El problema es que **la PWA
exige HTTPS de los dos lados**: servida desde `https://movil-alpha.frcsuite.com`,
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

- **alpha y beta**: se disparan solos al crearse el release.
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

### E1 · Tres configuraciones de build

`angular.json` hoy tiene solo `production` y `development`, sin
`fileReplacements` — por eso `environment.prod.ts` nunca se usa. Agregar
`alpha`, `beta` y `production` con las mismas opciones que la actual
`production` (budgets + `outputHashing` + `serviceWorker`) y un
`fileReplacements` a `environment.alpha.ts` / `environment.beta.ts` /
`environment.prod.ts`, cada uno con su `defaultServerUrl`.

> No hace falta tocar `ServerConfigService`: ya lee `environment.defaultServerUrl`
> solo cuando no hay nada en `localStorage`, y el usuario puede cambiar de
> servidor desde el login o desde Mi cuenta.

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
| 1 | **Mixed content**: PWA HTTPS no puede llamar a `http://…:808x` | Fase A es prerequisito, no paralelo |
| 2 | **Alpha inalcanzable** desde una PWA pública | Cloudflare Tunnel en mauro (A2) |
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
0 · Mergear PR #1 → #2 → #3
1 · Fase F  · proteger ramas, crear release/beta
2 · Fase B  · ci.yml                              ─┐ en paralelo con
3 · Fase C  · .releaserc.json + release.yml        │ Fase A (infra)
4 · Fase E  · environments, _redirects, _headers  ─┘
5 · Fase A1 · TLS farmacia + bodega (fuera de horario)
6 · Fase A2 · túnel a alpha en mauro
7 · Fase D  · deploy alpha → validar en un Android y en un iPhone
8 ·           deploy beta → correr el plan de testeo manual
9 ·           deploy prod con aprobación
10 · Fase G · versión por canal en el dashboard
```

**El primer deploy real solo puede ser alpha**, y solo después de A2. Todo lo
anterior se puede preparar y mergear sin infraestructura nueva.

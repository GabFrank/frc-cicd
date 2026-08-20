# Inventario de hosts FRC

Credenciales SSH en el `.env` del repo frc-cicd.

> **La red está migrando: ZeroTier se retira, headscale es la VPN oficial.** Muchos hosts tienen hoy dos direcciones (`172.25.*` por ZeroTier y `100.64.*` por el tailnet) y el identificador canónico pasa a ser el **nombre** (`central.hs.farmacia`), no la IP. Ver **[runbooks/headscale.md](runbooks/headscale.md)**.

## Central

**No es un equipo on-prem** (corregido 2026-08-11): es una **VM cloud** — hostname `frc-servidor`, DigitalOcean, IP pública **`159.203.86.103`**. Está en cuatro redes a la vez:

| Red | Dirección | Uso |
|---|---|---|
| Pública | `159.203.86.103` | lo que usan las filiales para la **app** (`ipServidorCentral=159.203.86.103:8082`) |
| ZeroTier `ztyxataffb` | **`172.25.1.200`** y `172.25.0.200` (dos IPs en la misma interfaz) | replicación PG histórica |
| ZeroTier `zteb4nkfeh` | `192.168.100.209` | **segunda red ZT** — scope a relevar antes de apagar ZeroTier |
| Tailnet | `100.64.0.3` = `central.hs.farmacia` | destino de la migración |

**Acá corren dos instancias, las dos productivas** (verificado 2026-08-14):

| Puerto | Instancia | Canal pipeline | Cluster PG | DB | Versión 2026-08-14 |
|---|---|---|---|---|---|
| 8081 | bodega | stable | **5552** | bodega | `4.8.0` |
| 8082 | farmacia | beta | 5551 | farmacia | `4.7.0-beta.2` |

> ⚠️ **Alpha ya no está en el servidor central: está en `mauro` (`172.25.0.172`).**
> Ver la sección de mauro. Tampoco existe la instancia «beta piloto» del 8084.
>
> **Limpiado el 2026-08-15**, así que el servidor ya no miente:
> - La DB `alpha` huérfana del cluster 5553 (563 MB) se borró. **El cluster 5553
>   de este host quedó vacío** — se puede apagar si nadie lo reclama.
> - Se borró también su suscripción `alpha_filial2_sub`, que seguía replicando
>   desde mauro hacia una base que nadie leía **y competía por el slot con la
>   suscripción viva del alpha**. Ver el gotcha de suscripciones duplicadas.
> - El unit `frc-alpha.service` se eliminó (`daemon-reload` corrido) y
>   `/opt/frc-backend-central/alpha/` pasó a `alpha.retirado-20260814`, con una
>   copia del unit adentro.
>
> Queda `/opt/frc-backend-central/beta/`, del piloto que tampoco existe: sin unit
> asociado, sin tocar.

> En 5551 también quedó una DB `bodega` huérfana con 0 conexiones (verificado 2026-07-07): la viva es la del 5552.

**Users SSH:**
- `deploy` → user oficial para workflows CI (sudoers NOPASSWD para `systemctl restart frc-*.service`). El workflow `Deploy` del repo central hace `ssh deploy@` vía SSH key.
- `franco` → user humano para comandos manuales. También tiene sudoers pero puede variar entre hosts.

**Servicios systemd** en central: `frc-bodega.service`, `frc-farmacia.service`, `frc-ecommerce.service` (Next.js del e-commerce).

**nginx + certbot ya están instalados y en uso** (verificado 2026-08-14) — dato que faltaba en este inventario y que abarata cualquier plan de TLS:

| Config | `server_name` | Cert |
|---|---|---|
| `/etc/nginx/conf.d/frc-ecommerce.conf` | `frc-ecommerce.com`, `*.frc-ecommerce.com`, `app.frc-ecommerce.com` | Let's Encrypt (`/etc/letsencrypt/live/…`) |
| `/etc/nginx/conf.d/donfranco.conf` | `donfrancorestaurante.com`, `www.` | Let's Encrypt |
| `/etc/nginx/conf.d/frc-central-api.conf` | `farmacia-api.frcsuite.com` → `:8082`, `bodega-api.frcsuite.com` → `:8081` | LE `frcsuite-central` (2 SAN, 2026-11-12). **Creado 2026-08-14** para que la PWA hable HTTPS con el central |

> ⚠️ **Cert `bodegafranco.com` VENCIDO desde 2026-06-27** (visto 2026-08-14 en `certbot certificates`). Si el dominio sigue en uso hay que renovarlo o borrarlo de certbot; si no, cada corrida de renovación va a seguir fallando y ensuciando el log.

Poner HTTPS delante de farmacia/bodega es **agregar `server` blocks y correr `certbot --nginx`**, no montar infraestructura nueva.

**Zonas DNS del ecosistema** (verificado 2026-08-14 por `dig NS`):

| Zona | DNS | Uso |
|---|---|---|
| `frcsuite.com` | Cloudflare | **zona nueva del SaaS** (registrada 2026-08-14). Destino de los subdominios de la PWA y de las APIs HTTPS del central |
| `frc-ecommerce.com` | Cloudflare | e-commerce + `efact.frc-ecommerce.com` |
| `francoarevalos.com` | Cloudflare | infra interna (`frc-cicd-dash`, `wa`) |
| `farmaciafrancopy.com` | **Hostinger** (`dns-parking.com`) | marca farmacia + `hs.farmaciafrancopy.com` (control server headscale). **No está en Cloudflare** — no sirve para Pages ni Tunnel sin migrar los NS, y migrarlos toca la VPN |

## Cloudflare — lo que vive ahí (desde 2026-08)

Credenciales: `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` en el `.env` de
`frc-cicd`. El token cubre DNS de `frcsuite.com`, Pages, Tunnel y aplicaciones
de Access. **No cubre leer/crear la organización Zero Trust** (`Access:
Organizations, Identity Providers and Groups`): eso se hace por panel.

| Recurso | Detalle |
|---|---|
| Zona `frcsuite.com` | Registrada 2026-08-14. APIs del central en **nube gris** (LE en el origen); puertas de la PWA y el túnel en **naranja** |
| Pages | `frc-pwa-alpha`, `frc-pwa-beta`, `frc-pwa-prod`. Deploy por `wrangler pages deploy` desde Actions |
| Puertas | `alpha.app` · `beta.app` · `farmacia.app` · `bodega.app` — las dos últimas al mismo proyecto `prod` |
| Túnel | `frc-alpha-mauro` → mauro `:8083`. Ingress gestionado **en la nube**, no en un `config.yml` |
| Zero Trust | Organización **`frcsuite`** (plan Free). **Sin aplicaciones**: Access se probó sobre `alpha.app` y se quitó — rompe el service worker (ver gotcha) |

Tres cosas que cuestan tiempo si no se saben:

- **Pages no crea el CNAME del dominio personalizado.** Queda en
  `initializing` hasta que exista un registro apuntando a `<proyecto>.pages.dev`,
  proxeado.
- **El certificado de un hostname de tres niveles lo emite Pages**, no el
  Universal de la zona. Por eso `farmacia.app.frcsuite.com` funciona sin pagar
  Advanced Certificate Manager — pero **un hostname proxeado de tres niveles que
  no sea de Pages sí lo necesitaría**. Por eso las APIs son planas.
- **El nombre de la organización Zero Trust se cambia una sola vez barato.**
  Aparece en la URL de login y, una vez que hay dispositivos con WARP o links
  repartidos, cambiarlo rompe cosas. El viejo se libera de inmediato.

**Flyway:** cada instancia usa su propia DB del cluster correspondiente. Migraciones son aditivas — nunca `DROP`/`RENAME` sin estrategia de 2 versiones. Ver [CLAUDE.md de central](/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/central/CLAUDE.md).

## Filiales farmacia

**6 filiales**, no 5 (verificado 2026-08-11 contra `pg_subscription` de la DB `farmacia`, cluster **5551** en central). Migrando de ZeroTier a headscale — ver [runbooks/headscale.md](runbooks/headscale.md).

| Filial | Sucursal | IP / nodo tailnet | OS | Puerto app | Servicio | Notas |
|---|---|---|---|---|---|---|
| 1 | SUC. CENTRAL | `192.168.0.146` · `farmacia-filial-1` **100.64.0.5** | Linux (**Fedora 44**) | 8082 | `frc.service` | ⚠️ **Servidor migrado el 2026-08-20** — ver nota abajo. PostgreSQL **16 nativo** (`postgresql-16.service`, puerto 5551), **no Docker**. Java **Temurin 17** (`/usr/lib/jvm/temurin-17-jdk`). Es a la vez puesto de trabajo (KDE) |
| ~~2~~ | ~~SUC. CALLE 10~~ | ~~`172.25.3.2`~~ | ~~Windows (10 Pro, SUC-GASUR)~~ | — | — | ⚰️ **SUCURSAL CERRADA — dada de baja 2026-08-11.** Sub, slots, publicación borrados; `activo=false`. Última venta `2026-06-11 22:02`. Las credenciales `FILIAL_2_*` del `.env` ya no apuntan a nada vivo |
| 3 | SUC. ITAIPU | `172.25.3.3` · `farmacia-filial-3` **100.64.0.12** | Linux (Fedora 38) | 8082 | `frc.service` | Enrolada 2026-08-11 |
| 4 | SUC. III | `172.25.3.4` · `farmacia-filial-4` **100.64.0.7** | Linux (Fedora 43) | 8082 | `frc.service` | hostname `fedora-server`. **Ya estaba enrolada como `centro2`**; renombrada + taggeada 2026-08-11. **Su replicación ya usa la IP tailnet** |
| 5 | SUC. SAN MIGUEL | `172.25.3.5` | Linux (Fedora) | 8082 | `frc.service` | 🔴 **APAGADA, sucursal abierta.** No responde ni desde central; no replica desde `2026-05-31`. **Sus 2 slots anclan ~3,8 GB de WAL en central** (`4108667872 bytes`, medido 2026-08-13) — al encenderla se libera solo. Requiere ir al local. Sin enrolar. ⚠️ Al encenderla va a aplicar de una vez todas las migraciones acumuladas del canal, sin nadie mirando |
| 6 | **SUC. II** (`sucursal_id = 7`) | `farmacia-nueva` **100.64.0.4** | Linux | 8082 | | **Solo existe en el tailnet** — no tiene IP `172.25.3.*`. Por eso faltaba en este inventario. Enrolada pero **sin tag**. Única filial con replicación 100% por tailnet en ambos sentidos. ⚠️ **Tampoco está en `monitored_servers` del dashboard** (verificado 2026-08-13) → no genera alertas y no se la alcanza por SSH desde fuera del tailnet. Para saber su estado: los *deployments* de GitHub, que ella misma reporta |

> ### Filial 1 migró de máquina el 2026-08-20
>
> El servidor viejo (`172.25.3.1` / `100.64.0.11`, Fedora 38, PG 16 **en Docker**) **sigue vivo en `192.168.0.145` pero como CAJA**, no como servidor: `frc.service` disabled, contenedor `postgres` con `restart=no` y detenido, sin cron. Se lo conserva como rollback y **tiene enchufada la impresora de `ticket5`**, que el servidor nuevo alcanza por `ipp://192.168.0.145:631/printers/ticket5` — por eso su CUPS debe quedar encendido y habilitado.
>
> Nodos headscale: **`farmacia-filial-1` = `100.64.0.5`** (el nuevo) y `farmacia-filial-1-viejo` = `100.64.0.11`. El nuevo **no tiene ZeroTier**: sus suscripciones salen por tailnet contra `central.hs.farmacia`.
>
> Plan, runbook y lecciones: `frc-cicd/plan-migracion-filial1-farmacia.md` y `frc-cicd/runbook-cutover-filial1.md`. Los gotchas nuevos (locale, timezone, `origin = none`, ruta real de las imágenes, backends de CUPS) están en [gotchas.md](gotchas.md).

> ⚠️ **Trampa de numeración: el número de filial NO es el `sucursal_id`.** `filial_farmacia_6_*` significa "la sexta filial", y atiende a **`SUC. II` (`sucursal_id = 7`)** — verificado por sus ventas (861 en 60 días, `sucursal_id = 7`). La sucursal `6 = DEPOSITO` **no tiene filial server** (`ip`/`puerto` en NULL). Antes de tocar cualquier cosa por número, confirmar contra `empresarial.sucursal` y contra las ventas de la filial.

`empresarial.sucursal` tiene 9 filas: `0 = SERVIDOR`, `1-7` sucursales, `999 = COMPRAS`. De las 7 sucursales, **6 tienen filial server** (todas menos DEPOSITO).

**Las subs de farmacia viven en el cluster `5551`** (no 5552 — ese tiene `bodega`).

**La tabla `empresarial.sucursal` guarda `ip` / `puerto` (PG) / `puerto_servidor` (app) de cada filial** — y es una fuente de verdad separada de la conninfo de las suscripciones, así que pueden desincronizarse (ya pasó con SUC. III). Al migrar una filial a headscale hay que actualizar **las tres**: la sub en central, las subs en la filial, y esta tabla.

**Layout en disco (linux):**
```
/opt/frc-filial/
├── current → releases/<VERSION>/      (symlink, el JAR vigente)
├── releases/
│   └── 4.1.0-beta.N/frc-filial-server.jar
├── .current-version                    (string plano, e.g. "4.1.0-beta.3")
├── .channel                            (alpha|beta|stable)
├── .filial-id                          (farmacia-filial-1-linux)
├── .github-token                       (PAT para notificar deployments)
├── application.properties              (overlay con sucursalId + ipServidorCentral)
├── check-update.sh
└── logs/
    ├── check-update.log
    └── update.log
```

**Layout en disco (windows):** mismo modelo pero con paths `C:\frc-filial\...`. `spring.log` en `C:\frc-filial\logs\spring.log`.

**Auto-update:**
- Linux: cron `franco` con `*/15 * * * * /usr/bin/flock -n /tmp/frc-filial-update.lock /opt/frc-filial/check-update.sh >> /var/log/frc-filial/check-update.log 2>&1`. Si el log-dir es `/var/log/frc-filial/` requiere sudo para crearlo — alternativa segura: `/opt/frc-filial/logs/check-update.log` (franco writable).
- Windows: Scheduled Task `FRC-Filial-Update` que corre `check-update.ps1` cada 15 min.

**Cluster PG por filial:** por default `5551`, DB `general`. Hay un ejecutable legacy en algunas filiales (ver filial 2) con PG 16 en Docker.

## mauro — **el entorno alpha completo** + dashboard/Evolution/n8n (on-prem)

**`172.25.0.172`** (hostname `mauro`, tailnet `100.64.0.2` = `frc-mauro-subnet`).

### El canal alpha entero vive acá (verificado 2026-08-14)

**No en la VM DigitalOcean.** Ese es el error más caro de este inventario: los planes que asumen «alpha = `159.203.86.103:8083`» apuntan a un zombi.

| Servicio systemd | Rol | Puerto | Path | Versión 2026-08-14 |
|---|---|---|---|---|
| `frc-alpha.service` | **central alpha** | 8083 | `/opt/frc-backend-central/alpha/current/frc-central-server.jar` | `4.7.0-alpha.39` (13-ago) |
| `frc-filial.service` | **filial alpha** | 8080 | `/opt/frc-filial/current/frc-filial-server.jar` | `5.0.0-alpha.7`, `.channel=alpha` |
| `cloudflared.service` | **túnel a Cloudflare** | — | token en `/etc/cloudflared/token` (`0600 root`) | `2026.8.2`, instalado 2026-08-14 |

**El túnel es cómo se llega a alpha desde fuera.** Túnel `frc-alpha-mauro`,
gestionado desde Cloudflare (el ingress vive en la nube, no en un `config.yml`
local), publicando `alpha-api.frcsuite.com` → `http://127.0.0.1:8083`. Es una
conexión **saliente**: mauro no tiene ningún puerto abierto hacia internet.
Para cambiar el ingress se edita en el panel o por API, no en el host.

Ambos corren como user `deploy`, con el mismo layout `releases/` + symlink `current` + `.current-version` que las filiales. El central alpha lee `/opt/frc-backend-central/alpha/.env` y su unit declara `After=postgresql-beta.service`.

**Tres clusters PostgreSQL locales:** `5551`, `5552`, `5553` (escuchan en `0.0.0.0`). **La DB del central alpha es `alpha` en el `5553` de acá** (`SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:5553/alpha`), no la del mismo nombre que quedó huérfana en la VM de producción.

> ⚠️ **mauro no tiene IP pública.** Su único acceso desde fuera de la LAN/ZeroTier es el tailnet (`100.64.0.2`). Cualquier cliente **público** que necesite hablarle a alpha —una PWA servida por HTTPS, por ejemplo— necesita un túnel (Cloudflare Tunnel) o que el dispositivo esté enrolado en headscale. No alcanza con abrir un puerto: no hay dónde abrirlo.

> ⚠️ **mauro es SPOF y está en retiro como bridge** (estuvo offline 2026-08-08→11). Que además hostee el canal alpha completo significa que se cae con él.

### Dashboard + Evolution + n8n

Fedora con Docker CE. Stack completo en `/opt/frc-cicd/docker-compose.yml`, project name `frc-cicd`, network `frc-net`. **8 servicios** (verificado 2026-07-09):

| Servicio | Container | Puerto host | Imagen | Volumen |
|---|---|---|---|---|
| dashboard | `frc-dashboard` | `0.0.0.0:3000->3000` | `ghcr.io/gabfrank/frc-dashboard:latest` | `frc-cicd_dash-data` → `/data/dash.db` (SQLite WAL, ~229M) |
| jobs | `frc-dashboard-jobs` | — | misma imagen (`jobs/runner.ts`) | comparte dash-data. **Es el que notifica WhatsApp** |
| migrate | `frc-dashboard-migrate` | one-shot | misma imagen (`lib/migrate.ts`) | corre Drizzle al boot |
| evolution-api | `frc-evolution-api` | `127.0.0.1:8090->8080` | `evoapicloud/evolution-api:v2.3.7` | sesión WhatsApp en su **postgres** (`DATABASE_SAVE_DATA_INSTANCE=true`), no en `evolution-instances` (vacío) |
| evolution-postgres | `frc-evolution-postgres` | interno | `postgres:16-alpine` | `evolution-pg-data` (~65M) |
| evolution-redis | `frc-evolution-redis` | interno | `redis:7-alpine` | `evolution-redis-data` |
| n8n | `frc-n8n` | `127.0.0.1:5678->5678` | `n8nio/n8n:1.75.2` | `n8n-data` (enc key, 4K) |
| n8n-postgres | `frc-n8n-postgres` | interno | `postgres:16-alpine` | `n8n-pg-data` (~48M) |

Puertos host publicados: **3000** (dashboard, 0.0.0.0 en ZeroTier), **8090** (evolution, loopback), **5678** (n8n, loopback). Acceso web: http://172.25.0.172:3000 (auth `AUTH_USER=admin`/`AUTH_PASS` del `.env`).

ZeroTier: red `b6079f73c6af6767` (nombre **"bodega"**, PRIVATE), IP `172.25.0.172/16`.

**Este mismo host** también actúa como **filial piloto Linux** (`FILIAL_TEST_LINUX_HOST`) **y como central alpha** (ver arriba). Roles múltiples conviven.

**User:** `franco` en grupos `wheel` y `docker`. Gotcha: `docker` sin `DOCKER_HOST` override falla — ver [dashboard-ops.md](dashboard-ops.md).

> **Migración en curso (2026-07-09):** este stack se está migrando a la VM Hetzner (ver abajo). Inventario + plan: `frc-cicd/scans/hetzner-migracion-2026-07-09/REPORTE.md` y `frc-cicd/plan-migracion-dashboard-hetzner.md`. Ojo: el usuario a veces refiere este host como `172.25.1.172` — es un lapsus, **no existe**; el correcto es `172.25.0.172`.

## VM Hetzner (cloud público) — efact + farmacia + (destino del dashboard)

**`178.105.107.171`** (hostname `FRC`) — Fedora 42, 4 vCPU, 7.6 GiB RAM (**sin swap**), 151 GB disco. IP **pública**. SSH: `deploy@178.105.107.171` (key-based). `deploy` en grupo docker.

Servicios ya corriendo (verificado 2026-07-09):

| Puerto host | Servicio | Dominio nginx |
|---|---|---|
| 80/443 | nginx (certbot) | reverse proxy TLS de todo lo de abajo |
| `127.0.0.1:3000` | **Farmacia Franco Next.js** (`farmacia.service`, tsx `server.ts`) | `farmaciafrancopy.com`, `www.`, `vm.` |
| `127.0.0.1:8081/8082` | docker `frc-efact` backend/frontend (compose en `~/frc-efact`) | `efact.frc-ecommerce.com` |
| `127.0.0.1:3001` | docker `frc-cicd` dashboard (compose en `~/frc-cicd`) | `frc-cicd-dash.francoarevalos.com` |
| `127.0.0.1:8090` | docker `evolution` (compose standalone en `~/evolution`) — Evolution API multi-proyecto | `wa.francoarevalos.com` |
| `127.0.0.1:5678` | docker `frc-cicd` n8n | (interno) |
| `127.0.0.1:5432` | postgres nativo (host) | — |
| `127.0.0.1:8080/9090` | headscale (control server Tailscale) | `hs.farmaciafrancopy.com` |
| 8554/8889/9997/9998/8000/8001/8189 | mediamtx (RTSP/WebRTC) | `vm.farmaciafrancopy.com` |

**Esta VM es el control server de la VPN (headscale, nativo por systemd).** `hs.farmaciafrancopy.com`. **ZeroTier se está retirando del ecosistema; headscale es la forma de conectarnos de acá en adelante**, y cada PC filial se enrola nativa (se deja de usar el bridge por mauro).

→ **Todo el detalle en [runbooks/headscale.md](runbooks/headscale.md)**: acceso, users, cómo agregar/remover nodos, ACL, rollout por filial, deploy por CI y gotchas.

Resumen mínimo:
- La VM es nodo tailscale `100.64.0.1` (`frc-cicd-vm`, user `admin`) contra su propio headscale.
- **Bridge transitorio:** mauro (`172.25.0.172`) = nodo `100.64.0.2` (`frc-mauro-subnet`), anuncia `172.25.0.0/16`. **SPOF probado** — estuvo offline 2026-08-08→11 y dejó al dashboard ciego. En retiro.
- ACL `group:admin → *:*` = **malla completa**. Enrolar con `--user 4` da acceso a toda la flota. Leer la sección de seguridad del runbook antes de crear keys.

**Conflicto de puerto clave:** el dashboard usa `3000`, ya ocupado por farmacia Next.js → en la VM va a `127.0.0.1:3001` detrás de nginx (subdominio + TLS + auth). Evolution (8090) y n8n (5678) no chocan.

## PCs de trabajo / administración

Nodos del tailnet que no son servidores: PCs desde donde se opera la flota. Todos van con `-u 4` **sin tag** (malla completa) — ver la tabla de categorías en [runbooks/headscale.md](runbooks/headscale.md).

| Nodo | Tailnet | Máquina | Notas |
|---|---|---|---|
| `pc-gabriel` | `100.64.0.26` | iMac de Gabriel, macOS 13.7.1 (x86) | Enrolado 2026-08-19. `tailscale` instalado por **Homebrew formula** (no cask): sin bottle para macOS 13 x86 → **compila desde fuente, ~10 min**. `tailscaled` corre por LaunchDaemon propio (`/Library/LaunchDaemons/com.tailscale.tailscaled.plist`, state en `/Library/Tailscale/`), **no** por `brew services` — `sudo brew` no ve el prefix de Homebrew del user y falla con "Formula not installed". Sigue en ZeroTier (`172.25.0.36`) en paralelo: la ruta `172.25/16` la gana ZT y las dos conviven |
| `pc-central`, `pc-casa`, `central-caja3` | `100.64.0.5` · `.6` · `.8` | — | Ya estaban enrolados. Sin relevar en detalle |

> **Desde una PC enrolada, las filiales farmacia se alcanzan directo por su IP tailnet** — `ssh franco@100.64.0.11` para filial 1, sin jump por la VM. El jump `deploy@178.105.107.171 → filial` sigue siendo el camino desde una máquina **fuera** del tailnet.

## Filial piloto Windows

**`172.25.0.3`** — DESKTOP-MNBIF0R, Windows 11, Java 17 Temurin, PG 16 como servicio `postgresql-alpha` puerto 5552. User: `franco`. Usado para testear el runbook Windows antes de tocar filial 2 productiva.

## Filiales bodega

17 sucursales de Bodega en red `172.25.1.*` (misma subred que el central). Canal objetivo: **stable**. Central bodega productiva corre en `172.25.1.200:8081` (instancia stable, DB `bodega`, servicio `frc-bodega.service`, path legacy `/home/franco/bodega/FRC/frc-server/`, shared host con farmacia).

| sucursal_id | Filial | IP | OS | Puerto app | Notas |
|---|---|---|---|---|---|
| 1 | Suc. Central | 172.25.1.1 | Linux | 8082 | |
| 3 | Suc. Rotonda | 172.25.1.3 | Linux | 8082 | |
| 4 | Suc. Industrial | 172.25.1.4 | **Windows** | 8082 | único Windows del grupo bodega |
| 5 | Suc. Km5 | 172.25.1.5 | Linux | 8082 | |
| 6 | Suc. Calle 10 | 172.25.1.6 | Linux | 8082 | |
| 7 | Suc. Katuete 1 | 172.25.1.7 | Linux | 8082 | |
| 8 | Suc. Paloma 1 | 172.25.1.8 | Linux | 8082 | |
| 9 | Suc. San Antonio | 172.25.1.9 | Linux | 8082 | |
| 10 | Suc. Katuete 2 | 172.25.1.10 | Linux | 8082 | |
| 11 | Suc. Puente Kyjha | 172.25.1.11 | Linux | 8082 | |
| 12 | Suc. Plaza | 172.25.1.12 | Linux | 8082 | |
| 14 | Suc. Canindeyu 1 | 172.25.1.14 | Linux | 8082 | logs central farmacia post-cutover (2026-04-22) muestran "No route to host" contra `.14:5551` — verificar alcance ZeroTier antes de usarla |
| 18 | Suc. Curuguaty 1 | 172.25.1.18 | Linux | 8082 | |
| 20 | Suc. Paloma 2 | 172.25.1.20 | Linux | 8082 | |
| 21 | Suc. Renacer | 172.25.1.21 | Linux | 8082 | |
| 22 | Suc. Canindeyu 2 | 172.25.1.22 | Linux | 8082 | |
| 23 | Suc. Ruta 7 | 172.25.1.23 | Linux | 8082 | |
| 24 | Suc. Km2 | 172.25.1.24 | Linux | 8082 | sucursal_id=24 coincide con el hardcoded del JAR legacy (`application.properties` embebido dice `sucursalId=24`) — para esta filial el overlay "no cambia nada" por casualidad, pero igual aplicarlo por consistencia |

User SSH: `franco`, password default `franco` (credenciales en `.env`). Layout y servicios idénticos al modelo farmacia — se reutilizan los runbooks `runbook-migracion-filial-{linux,windows}-beta.md` sustituyendo `beta` → `stable`.

Fuente autoritativa del registry: dashboard `monitored_servers` WHERE `empresa='bodega'` (ver [dashboard-ops.md](dashboard-ops.md)).

## Acceso SSH — receta estándar

```bash
# Linux filial
ssh franco@<IP>
# password en .env (FILIAL_N_PASS)

# Windows filial (via OpenSSH server)
ssh franco@<IP>
# luego powershell -Command "..."

# Múltiples comandos read-only sin sudo
ssh franco@<IP> "hostname; cat /opt/frc-filial/.current-version; systemctl is-active frc.service"
```

Para comandos que requieren sudo: ver [runbooks/sudoers-patterns.md](runbooks/sudoers-patterns.md).

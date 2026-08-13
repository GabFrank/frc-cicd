# Escaneo pre-migración — Dashboard frc-cicd → VM Hetzner

**Fecha:** 2026-07-09
**Objetivo:** migrar el stack `frc-cicd` (dashboard + jobs + Evolution API + n8n) del host on-prem **172.25.0.172** (hostname `mauro`) a la VM Hetzner **178.105.107.171** (hostname `FRC`), que ya hostea otros servicios.
**Método:** escaneo solo-lectura vía SSH a ambos hosts. Sin cambios aplicados.

> **Corrección de IP:** el usuario refirió el origen como `172.25.1.172`. Ese host **no existe** (ping/SSH timeout). El origen real del dashboard es **`172.25.0.172`** (confirmado: hostname `mauro`, corre el stack). Ver `hosts.md` de la skill.

---

## 1. Destino — VM Hetzner `178.105.107.171`

| Atributo | Valor |
|---|---|
| Hostname | `FRC` |
| OS | Fedora release 42 (Adams) |
| SSH | `deploy@178.105.107.171` (key-based, funciona) |
| CPU | 4 vCPU |
| RAM | 7.6 GiB total — 2.4 GiB usados, **5.2 GiB disponibles**. ⚠️ **Swap = 0 B** |
| Disco | `/dev/sda1` 151 GB, 18 GB usados (13%), **127 GB libres** |
| Uptime | 40 días |
| IP pública | `178.105.107.171` (eth0, gw `172.31.1.1`) |
| Firewalld | zona `public`: ssh, http, https, mdns, dhcpv6-client + `8554/tcp`, `8189/udp` (mediamtx). Reject SSH desde `45.148.10.240` y `34.97.123.115`. |

### Puertos en escucha (VM, estado actual)

| Puerto (host) | Bind | Proceso | Uso |
|---|---|---|---|
| 22 | 0.0.0.0 | sshd | SSH |
| 80 / 443 | 0.0.0.0 | nginx (5 workers, certbot) | reverse proxy TLS |
| **3000** | 127.0.0.1 | **node `farmacia-franco/server.ts` (tsx)** — `farmacia.service` | **Farmacia Franco Next.js** |
| 5432 | 127.0.0.1 / ::1 | postgres nativo (host) | `postgresql.service` |
| 8080 | 127.0.0.1 | headscale | control server VPN (`hs.farmaciafrancopy.com`) |
| 9090 | 127.0.0.1 | headscale | métricas headscale |
| 8081 | 127.0.0.1 | docker-proxy → `frc-efact-backend` | efact backend |
| 8082 | 127.0.0.1 | docker-proxy → `frc-efact-frontend` | efact frontend |
| 8554, 8889, 9997, 9998, 8000, 8001, 8189 | mixto | mediamtx | RTSP/WebRTC (`vm.farmaciafrancopy.com`) |
| 53, 5353, 5355, 323 | loopback/link | systemd-resolve, avahi, chrony | infra base |

### Docker (VM)

- **Único proyecto compose:** `frc-efact` en `/home/deploy/frc-efact`.
- Containers: `frc-efact-backend` (`127.0.0.1:8081->8080`, healthy), `frc-efact-frontend` (`127.0.0.1:8082->80`), `frc-efact-db` (`postgres:16-alpine`, interno, healthy).
- Redes: `bridge`, `frc-efact_default`, `host`, `none`.
- Volúmenes: `frc-efact_backend_logs`, `frc-efact_certificates`, `frc-efact_pgdata`.

### systemd (VM, running)

`docker`, `farmacia` (Next.js :3000), `headscale`, `mediamtx`, `nginx`, `postgresql`.

### nginx — vhosts (VM)

| server_name | proxy_pass |
|---|---|
| `efact.frc-ecommerce.com` | 127.0.0.1:8081 / :8082 |
| `hs.farmaciafrancopy.com` | 127.0.0.1:8080 (headscale) |
| `farmaciafrancopy.com` `www.` `vm.` `_` (default) | 127.0.0.1:3000 (farmacia) + :8889 (mediamtx whep) |

### 🚨 Bloqueante de red — VM sin ruta a `172.25.*`

- **No hay interfaz ZeroTier / Tailscale / WireGuard** en la VM.
- `ip route get 172.25.1.200` → sale por `eth0` al gw público. `ping 172.25.1.200` = **100% loss**.
- La VM corre **headscale** (server de control Tailscale) pero **no es nodo** de la malla, y la red on-prem usa **ZeroTier**, no Tailscale.
- **Impacto:** el dashboard vive de health-checks HTTP a `172.25.1.200:808x/actuator` y de checks PG a los clusters `172.25.*:555x`. Sin ruta a esa red, el dashboard reportaría todo DOWN. **La migración NO puede completarse hasta resolver esto** (ver plan, Fase 1).

---

## 2. Origen — Host on-prem `172.25.0.172` (`mauro`)

| Atributo | Valor |
|---|---|
| SSH | `franco@172.25.0.172` |
| ZeroTier | red `b6079f73c6af6767` (nombre **"bodega"**, PRIVATE), IP asignada `172.25.0.172/16`, node id `b41961f950`, ZT 1.14.0 ONLINE |
| Stack | `/opt/frc-cicd/docker-compose.yml`, project `frc-cicd`, network `frc-net` |

### Servicios del compose (8 definidos, 7 corriendo + `migrate` one-shot)

> ⚠️ La descripción vieja en la skill (`dashboard-ops.md`/`hosts.md`) estaba **desactualizada** (decía 5 servicios, evolution en 8080, un solo postgres). Estado real:

| Servicio | Container | Puerto host | Imagen |
|---|---|---|---|
| dashboard | `frc-dashboard` | **`0.0.0.0:3000->3000`** | `ghcr.io/gabfrank/frc-dashboard:latest` |
| jobs | `frc-dashboard-jobs` | (sin publicar) | misma imagen, `jobs/runner.ts` |
| migrate | `frc-dashboard-migrate` | one-shot | misma imagen, `lib/migrate.ts` |
| evolution-api | `frc-evolution-api` | `127.0.0.1:8090->8080` | `evoapicloud/evolution-api:v2.3.7` |
| evolution-postgres | `frc-evolution-postgres` | interno | `postgres:16-alpine` |
| evolution-redis | `frc-evolution-redis` | interno | `redis:7-alpine` |
| n8n | `frc-n8n` | `127.0.0.1:5678->5678` | `n8nio/n8n:1.75.2` |
| n8n-postgres | `frc-n8n-postgres` | interno | `postgres:16-alpine` |

**Puertos host publicados:** `3000` (dashboard, 0.0.0.0), `8090` (evolution, loopback), `5678` (n8n, loopback).

### Volúmenes y tamaños (dato a transferir)

| Volumen | Tamaño | Contenido crítico |
|---|---|---|
| `frc-cicd_dash-data` | **228.9 M** | **SQLite `dash.db`** (WAL) — servers, alerts, rules, deployments, releases. Joya de la corona. |
| `frc-cicd_evolution-pg-data` | 64.8 M | Postgres Evolution — **sesión/pairing WhatsApp** (`DATABASE_SAVE_DATA_INSTANCE=true`) |
| `frc-cicd_n8n-pg-data` | 47.5 M | Postgres n8n (workflows, ejecuciones) |
| `frc-cicd_evolution-redis-data` | 10.7 M | cache Evolution |
| `frc-cicd_n8n-data` | 4.0 K | **`.n8n` — encryption key** (necesaria para desencriptar credenciales n8n) |
| `frc-cicd_evolution-instances` | 0 | (vacío — la sesión vive en pg, no acá) |

**Total ≈ 360 MB.** Transferencia trivial.

### Secretos del stack (`.env` origen — guardados en `.env` del repo/skill)

`GITHUB_PAT`, `SESSION_SECRET`, `AUTH_USER=admin`/`AUTH_PASS`, `CENTRAL_BASE_URL=http://172.25.1.200`, `EVOLUTION_API_KEY`, `EVOLUTION_PG_PASSWORD`, `EVOLUTION_INSTANCE_NAME=frc-alertas`, `DASHBOARD_PUBLIC_URL=http://172.25.0.172:3000`, `N8N_PG_PASSWORD`, `N8N_AUTH_USER`/`N8N_AUTH_PASS`. Todos preservados para la migración.

---

## 3. Análisis de conflictos de puerto (stack → VM)

| Servicio | Puerto en origen | ¿Conflicto en VM? | Resolución |
|---|---|---|---|
| **dashboard** | `0.0.0.0:3000` | 🔴 **SÍ** — farmacia Next.js ya ocupa `:3000` | remap a `127.0.0.1:3001->3000`; exponer vía nginx con subdominio + TLS + basic auth (no publicar 3000 en la IP pública) |
| evolution-api | `127.0.0.1:8090` | 🟢 no | mantener 8090 |
| n8n | `127.0.0.1:5678` | 🟢 no | mantener 5678 |
| evolution/n8n postgres, redis | internos | 🟢 no | red compose aislada |
| jobs / migrate | sin puerto | 🟢 no | — |

**Único conflicto: puerto 3000.** (Ojo: headscale usa 8080 pero evolution mapea a 8090 en host, sin choque; postgres nativo usa 5432 pero los postgres del stack son internos.)

---

## 4. Riesgos identificados

1. **Red ZeroTier (bloqueante):** VM debe unirse a la red `b6079f73c6af6767` y ser autorizada (red PRIVATE → acción de admin ZeroTier). Sin esto el dashboard es inútil.
2. **Doble notificación WhatsApp:** si ambos `jobs` corren en paralelo, se duplican alertas al grupo. En el cutover hay que **detener `jobs` en el origen** (o `NOTIFY_ALERTS_ENABLED=false`).
3. **Re-pairing WhatsApp:** la sesión Evolution está atada al entorno; el cambio de host/IP puede invalidarla y requerir re-escanear QR. Verificar tras el arranque.
4. **RAM sin swap:** VM en 5.2 GiB libres; el stack añade ~1.5–2 GiB (2× node dashboard + 3 postgres + redis + evolution + n8n). Considerar **agregar swapfile** antes del cutover.
5. **Exposición pública:** el dashboard en on-prem escuchaba en `0.0.0.0:3000` (aceptable en ZeroTier privado). En la VM pública **no debe** publicarse en la IP pública sin TLS+auth → siempre detrás de nginx.

---

## 5. Snapshot de comandos (reproducible)

```bash
# VM destino
ssh deploy@178.105.107.171 'sudo ss -tulpnH; docker ps -a; systemctl list-units --type=service --state=running; sudo nginx -T | grep -E "server_name|proxy_pass"; nproc; free -h; df -h /'

# Origen
ssh franco@172.25.0.172 'sudo zerotier-cli listnetworks'   # -t para sudo
ssh franco@172.25.0.172 'DOCKER_HOST=unix:///var/run/docker.sock docker ps; cat /opt/frc-cicd/docker-compose.yml'
```

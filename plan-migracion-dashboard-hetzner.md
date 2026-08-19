# Plan de migración — Dashboard frc-cicd: on-prem `172.25.0.172` → VM Hetzner `178.105.107.171`

**Fecha plan:** 2026-07-09 (rev. headscale)
**Inventario base:** [scans/hetzner-migracion-2026-07-09/REPORTE.md](scans/hetzner-migracion-2026-07-09/REPORTE.md)
**Dominio del dashboard:** `frc-cicd-dash.francoarevalos.com`
**Estrategia:** despliegue escalonado. El dashboard se prepara **ya** en la VM (accesible por el dominio), y alcanza plena funcionalidad **cuando headscale esté configurada en todas las filiales + central**. El dashboard on-prem sigue corriendo sobre ZeroTier hasta el cutover final → sin ventana ciega.

## Contexto estratégico

- La red on-prem hoy usa **ZeroTier** (`172.25.*`). El objetivo mayor es **migrar todo frc-comercial a headscale** (la VM ya es el control server: `hs.farmaciafrancopy.com`).
- Por eso la VM **no** se une a ZeroTier. En su lugar se suma al **tailnet headscale** y la reachability a central/filiales llega a medida que cada host se enrola.
- **Consecuencia:** el dashboard puede desplegarse hoy y quedar "ciego" (hosts DOWN) sin romper nada; el on-prem sigue monitoreando en paralelo. A medida que headscale llega a cada host, el dashboard nuevo los va viendo.

## Resumen

- Mover el stack `frc-cicd` (8 servicios: dashboard, jobs, migrate, evolution-api+pg+redis, n8n+pg) a la VM que ya corre efact + farmacia Next.js + headscale + mediamtx + nginx + postgres nativo.
- **Datos ≈ 360 MB** (6 volúmenes). SQLite `dash-data` (229M) + sesión WhatsApp en `evolution-pg-data` (65M) + n8n (48M+4K enc key) son lo crítico.
- **Único conflicto de puerto:** `3000` (farmacia Next.js) → dashboard va a `127.0.0.1:3001` detrás de nginx.
- **Evolution API:** la VM **no** tiene ninguno hoy (verificado); el stack trae el suyo, autocontenido, sin choque.
- **Reachability:** vía headscale (no ZeroTier). Se resuelve por fases a medida que se enrolan hosts.

---

## Fase 0 — Pre-requisitos / GO–NO-GO

- [ ] **DNS:** crear registro A `frc-cicd-dash.francoarevalos.com` → `178.105.107.171`. *(Hoy no resuelve — verificado 2026-07-09.)*
- [x] Dominio decidido: `frc-cicd-dash.francoarevalos.com`.
- [x] Ubicación del stack en la VM: `/home/deploy/frc-cicd` (consistente con `~/frc-efact`; `deploy` está en grupo docker).
- [ ] **Swapfile** en la VM (no tiene swap). 2–4 GB antes de arrancar el stack.
- [ ] Confirmar que el certbot/nginx del host puede emitir cert para `*.francoarevalos.com` (DNS apuntando + puerto 80 accesible).

**Criterio GO para preparar (Fases 1-2):** DNS creado + swapfile. *No requiere headscale todavía.*
**Criterio GO para cutover final (Fase 3+):** headscale enrolado en central + filiales objetivo, reachability verificada.

---

## Fase 1 — Red: sumar la VM al tailnet headscale

La VM ya corre el **control server** headscale, pero **no es nodo** del tailnet. Instalar el cliente tailscale y enrolarla:

```bash
# En la VM (deploy@178.105.107.171)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --login-server https://hs.farmaciafrancopy.com --accept-routes
# Autorizar el nodo en headscale (headscale nodes register / preauthkey)
sudo tailscale status
```

- [ ] Enrolar la VM como nodo y **aceptar rutas** (`--accept-routes`) para recibir la subred on-prem.
- [ ] **Anunciar `172.25.0.0/16` como subnet-route** desde un nodo headscale que tenga pata en la red física on-prem (típicamente el gateway/una filial linux), y aprobar la ruta en headscale:
  ```bash
  # en el nodo con acceso físico a 172.25.*
  sudo tailscale up --login-server https://hs.farmaciafrancopy.com --advertise-routes=172.25.0.0/16
  # en el control server
  sudo headscale routes enable -r <route-id>
  ```
  → **Con esto el dashboard sigue usando las IPs `172.25.*` del registro sin cambios** (opción (a), transparente). Alternativa: reescribir `monitored_servers` a IPs `100.64.*`/MagicDNS de headscale.
- [ ] **Verificar reachability** desde la VM (crítico, gatea el cutover):
  ```bash
  ping -c2 172.25.1.200
  curl -fsS http://172.25.1.200:8081/actuator/info      # bodega
  curl -fsS http://172.25.1.200:8082/actuator/info      # farmacia
  nc -zv 172.25.1.200 5551 5552 5553                     # clusters PG central
  ping -c2 172.25.3.4 ; ping -c2 172.25.1.5              # filiales
  ```
- [ ] Firewalld: agregar la interfaz `tailscale0` a zona `trusted` si hace falta:
  ```bash
  sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 && sudo firewall-cmd --reload
  ```

> **Este es el trabajo grande y gradual:** enrolar central + las 5 filiales farmacia + 17 bodega a headscale. El dashboard nuevo va reflejando el avance host por host.

---

## Fase 2 — Preparar el stack en la VM (sin datos, se puede hacer ya)

```bash
# En la VM
mkdir -p /home/deploy/frc-cicd && cd /home/deploy/frc-cicd
```

- [ ] Copiar `docker-compose.yml` y `.env` (scp desde el repo local o desde el origen).
- [ ] **Editar `docker-compose.yml`** — servicio `dashboard`, remapear puerto:
  ```yaml
  # ANTES:  - "0.0.0.0:3000:3000"
  # DESPUÉS:
      - "127.0.0.1:3001:3000"
  ```
- [ ] **Editar `.env`:**
  ```env
  CENTRAL_BASE_URL=http://172.25.1.200                        # se mantiene (vía headscale subnet-route)
  DASHBOARD_PUBLIC_URL=https://frc-cicd-dash.francoarevalos.com
  EVOLUTION_PUBLIC_URL=http://127.0.0.1:8090
  N8N_PUBLIC_URL=http://127.0.0.1:5678/
  SESSION_COOKIE_SECURE=true                                   # hay TLS
  # secretos (GITHUB_PAT, SESSION_SECRET, AUTH_*, EVOLUTION_*, N8N_*) se copian tal cual del origen
  ```
- [ ] **nginx vhost** (`/etc/nginx/conf.d/frc-cicd-dash.conf` o el include del host):
  ```nginx
  server {
      server_name frc-cicd-dash.francoarevalos.com;
      location / {
          proxy_pass http://127.0.0.1:3001;
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
      }
  }
  ```
  ```bash
  sudo certbot --nginx -d frc-cicd-dash.francoarevalos.com
  ```

Se puede levantar el stack **vacío** ya para validar UI + nginx + TLS (mostrará hosts DOWN hasta que headscale enrute). O esperar a la Fase 3 y arrancar directo con los datos.

---

## Fase 3 — Cutover: migrar datos y arrancar

**Congelar el origen (quiesce de escrituras + corta notificaciones duplicadas):**
```bash
# ORIGEN (franco@172.25.0.172)
cd /opt/frc-cicd
DOCKER_HOST=unix:///var/run/docker.sock docker compose stop jobs dashboard
```

> **⚠️ Evolution API NO se migra.** La instancia `frc-alertas` del origen quedó `close` con `disconnectionReasonCode: 401 / device_removed` (dispositivo WhatsApp desvinculado) — la sesión está muerta. Además la Evolution de la VM ya es **canónica** y usada por otros proyectos (expuesta en `wa.francoarevalos.com`). Restaurar `evolution-pg-data`/`evolution-redis-data` del origen **clobbearía** esos datos y traería una sesión inútil. → migrar **solo** `dash-data` + n8n; re-emparejar `frc-alertas` en la VM (Fase 4).

**Exportar volúmenes (tar; imágenes pg16-alpine idénticas origen/destino):**
```bash
# ORIGEN — a /tmp/frc-migra. SOLO dash-data + n8n (NO evolution).
mkdir -p /tmp/frc-migra
for v in dash-data n8n-pg-data n8n-data; do
  DOCKER_HOST=unix:///var/run/docker.sock docker run --rm \
    -v frc-cicd_$v:/vol -v /tmp/frc-migra:/backup postgres:16-alpine \
    sh -c "cd /vol && tar czf /backup/$v.tar.gz ."
done
```

**Transferir (laptop como relay mientras la VM no tenga ruta directa al origen):**
```bash
mkdir -p /tmp/frc-migra
scp franco@172.25.0.172:/tmp/frc-migra/*.tar.gz /tmp/frc-migra/
scp /tmp/frc-migra/*.tar.gz deploy@178.105.107.171:/tmp/frc-migra/
```

**Restaurar en la VM (SOLO dash-data + n8n; parar dashboard/jobs/n8n antes para no corromper):**
```bash
# VM — project name = frc-cicd → volúmenes frc-cicd_*
cd /home/deploy/frc-cicd
docker compose stop dashboard jobs n8n
for v in dash-data n8n-pg-data n8n-data; do
  docker run --rm -v frc-cicd_$v:/vol -v /tmp/frc-migra:/backup postgres:16-alpine \
    sh -c "cd /vol && rm -rf ./* ./.[!.]* 2>/dev/null; tar xzf /backup/$v.tar.gz"
done
docker compose up -d
```
> La Evolution de la VM (`frc-evolution-*`) NO se toca — sigue con sus instancias propias.

**Arrancar:**
```bash
cd /home/deploy/frc-cicd
docker compose up -d          # migrate corre (idempotente), luego dashboard+jobs+evolution+n8n
docker compose ps
curl -fsS http://127.0.0.1:3001/api/data/overview
```

---

## Fase 4 — WhatsApp (Evolution) — re-pair en la VM

La Evolution de la VM es canónica y fresca. La instancia `frc-alertas` hay que **crearla + emparejarla de cero** (la del origen murió: `device_removed 401`).

- [ ] Crear instancia (si no existe) + obtener QR:
  ```bash
  KEY=$(grep '^EVOLUTION_API_KEY=' /home/deploy/frc-cicd/.env | cut -d= -f2)
  curl -s -H "apikey: $KEY" -H 'Content-Type: application/json' \
    -d '{"instanceName":"frc-alertas","integration":"WHATSAPP-BAILEYS","qrcode":true}' \
    http://127.0.0.1:8090/instance/create
  # o el manager web: https://wa.francoarevalos.com/manager
  ```
- [ ] Escanear QR desde el teléfono emisor. Confirmar `connectionState` = `open`.
- [ ] En el dashboard (cutover): `EVOLUTION_INSTANCE_NAME=frc-alertas` ya apunta a esa instancia; reactivar `NOTIFY_ALERTS_ENABLED=true`.
- [ ] Alerta de prueba: confirmar que llega **una sola vez** (origen ya no notifica).

---

## Fase 5 — Verificación y decomiso

- [ ] Dashboard en `https://frc-cicd-dash.francoarevalos.com` (auth admin), UI OK.
- [ ] Hosts enrolados en headscale se ven UP; los no-enrolados aún DOWN (esperado durante la transición).
- [ ] `sync-github`, alertas WhatsApp sin duplicados.
- [ ] Actualizar `.env`/skill: `DASHBOARD_HOST`, `DASHBOARD_URL` → nuevos valores.
- [ ] Origen **detenido pero intacto** 1–2 semanas (rollback = re-`up` en `mauro`).
- [ ] Tras la ventana + backups off-site confirmados: `docker compose down` en origen, opcional `docker volume rm`.

---

## Rollback

```bash
# ORIGEN: re-levantar
cd /opt/frc-cicd && DOCKER_HOST=unix:///var/run/docker.sock docker compose up -d
# VM: detener para evitar doble notificación
cd /home/deploy/frc-cicd && docker compose stop jobs dashboard
```
El origen conserva toda su data (nunca se toca). Único colateral: la sesión WhatsApp quedó en la VM → posible re-pair al volver.

---

## Matriz de riesgos

| Riesgo | Severidad | Mitigación |
|---|---|---|
| headscale aún no enruta `172.25.*` | 🔴 gatea cutover | despliegue escalonado; on-prem sigue monitoreando en paralelo |
| Cambio de IPs (ZeroTier `172.25.*` → tailscale `100.64.*`) | 🟠 alto | subnet-route `172.25.0.0/16` en headscale → registro sin cambios (opción a) |
| Doble notificación WhatsApp | 🟠 alto | detener `jobs` en origen al inicio de Fase 3 |
| Re-pairing WhatsApp | 🟡 medio | Fase 4; teléfono del grupo a mano |
| RAM sin swap | 🟡 medio | swapfile en Fase 0 |
| Exposición pública del dashboard | 🟠 alto | nunca publicar `:3001` en la IP pública; solo nginx+TLS+auth |
| Conflicto puerto 3000 | 🟢 resuelto | remap a 3001 en Fase 2 |
| DNS no resuelve aún | 🟡 medio | crear registro A en Fase 0 antes del cert |

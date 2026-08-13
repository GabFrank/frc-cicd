# Deploy del Dashboard

Pipeline simple: la imagen se buildea sola, el host pullea cuando querés.

```
push a master ──▶ GH Actions build ──▶ ghcr.io/gabfrank/frc-dashboard:latest
                                              │
                                              ▼
                                 host: docker compose pull && up -d
```

No hay SSH deploy automático. El host pullea a demanda.

> **Migración en curso (2026-07-09):** el dashboard se está moviendo del host **on-prem `172.25.0.172`** (ZeroTier, deploy original) a la **VM Hetzner `178.105.107.171`**, accesible por `https://frc-cicd-dash.francoarevalos.com` detrás de nginx+TLS. La VM se conecta a la red on-prem vía **headscale** (no ZeroTier), en el marco de migrar todo frc-comercial a headscale. Plan por fases: [`plan-migracion-dashboard-hetzner.md`](plan-migracion-dashboard-hetzner.md). Las dos secciones de deploy conviven abajo.

---

## Deploy en VM Hetzner (headscale + nginx público) — destino

Diferencias clave contra el on-prem:
- **Ubicación:** `/home/deploy/frc-cicd` (user `deploy`, en grupo docker — no requiere `sudo` para docker).
- **Puerto dashboard:** `127.0.0.1:3001:3000` (el `3000` lo ocupa farmacia Next.js). Nunca publicar en la IP pública.
- **Exposición:** nginx del host (`/etc/nginx/conf.d/frc-cicd-dash.conf`) → `proxy_pass http://127.0.0.1:3001`, cert por `certbot --nginx -d frc-cicd-dash.francoarevalos.com`.
- **Reachability a `172.25.*`:** vía tailscale/headscale (`tailscale up --login-server https://hs.farmaciafrancopy.com --accept-routes`) + subnet-route `172.25.0.0/16` aprobada en headscale. Con eso `CENTRAL_BASE_URL=http://172.25.1.200` sigue funcionando sin cambios en el registro.
- **`.env`:** `DASHBOARD_PUBLIC_URL=https://frc-cicd-dash.francoarevalos.com`, `SESSION_COOKIE_SECURE=true`.
- **Swap:** la VM no tiene; agregar swapfile 2–4 GB antes de arrancar el stack.

Arranque (una vez copiados compose + `.env` + datos — ver plan Fase 3):
```bash
cd /home/deploy/frc-cicd
docker compose up -d          # sin sudo (deploy ∈ docker)
docker compose ps
curl -fsS http://127.0.0.1:3001/api/data/overview | jq '.summary'
```

Actualizar:
```bash
cd /home/deploy/frc-cicd && docker compose pull dashboard jobs migrate && docker compose up -d
```

---

## Deploy on-prem `172.25.0.172` (ZeroTier) — origen (legacy, sigue vivo hasta el cutover)

## Primera vez (host on-prem)

Requisitos: Docker + Docker Compose v2.20+, ZeroTier con visibilidad a `172.25.*`, acceso al central por `host.docker.internal` o IP directa.

```bash
# 1. Clonar solo lo necesario (no hace falta el source completo — la imagen viene de GHCR)
sudo mkdir -p /opt/frc-cicd && cd /opt/frc-cicd
sudo git clone --depth 1 --filter=blob:none --sparse https://github.com/GabFrank/frc-cicd.git .
sudo git sparse-checkout set docker-compose.yml .env.example dashboard/deploy

# 2. Configurar env
sudo cp .env.example .env
sudo vim .env        # llenar todos los secrets (ver comentarios)

# 3. Publicar la imagen una vez desde GH (si todavía no hay en GHCR)
# — push a master cualquier archivo bajo dashboard/** lo dispara, o manual:
#   gh workflow run build-dashboard.yml
# Luego verificar: https://github.com/users/gabfrank/packages/container/frc-dashboard
# Primera vez hay que marcar el package como PUBLIC en la UI de GitHub.

# 4. Arrancar
sudo docker compose pull
sudo docker compose up -d

# 5. Evolution + n8n: emparejar WhatsApp (ver notifications/README.md)
#    - http://IP:8090/manager → api key → create instance "frc-alertas"
#    - Escanear QR con el celular emisor
#    - http://IP:5678 → login n8n (opcional)
```

## Actualizar (cada push de GH Actions)

En el host:

```bash
cd /opt/frc-cicd && sudo docker compose pull dashboard jobs migrate && sudo docker compose up -d
```

Para automatizar con cron cada 10 min:

```bash
echo "*/10 * * * * root cd /opt/frc-cicd && docker compose pull -q dashboard jobs migrate && docker compose up -d >/dev/null 2>&1" | sudo tee /etc/cron.d/frc-dash-auto-update
```

El `service migrate` corre automáticamente antes de que `jobs` y `dashboard` arranquen, así los ALTER TABLE se aplican on-demand.

## Verificar

```bash
docker compose ps                      # todos up
docker compose logs -f jobs            # confirma sync-github ok, sync-health ok, etc.
curl -s http://localhost:3000/api/data/overview | jq '.summary'
```

## Backup SQLite

```bash
sudo cp dashboard/deploy/backup.sh /usr/local/bin/frc-dash-backup.sh
sudo chmod +x /usr/local/bin/frc-dash-backup.sh
echo "15 3 * * * root /usr/local/bin/frc-dash-backup.sh" | sudo tee /etc/cron.d/frc-dash-backup
```

Guarda copia diaria en `/var/backups/frc-dashboard/dash-YYYYMMDD-HHMMSS.db`, retiene 7 días.

## Dev local (build desde source, sin pull)

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

`docker-compose.dev.yml` re-inyecta `build: ./dashboard` sobre los 3 servicios que consumen la imagen. Útil cuando estás tocando código y no querés esperar el pipeline.

## Pipeline GitHub Actions

- Archivo: `.github/workflows/build-dashboard.yml`
- Trigger: push a `master` modificando `dashboard/**` o `docker-compose.yml`, o manual (`workflow_dispatch`)
- Output: `ghcr.io/gabfrank/frc-dashboard:latest` + `:sha-<short>` + `:master`
- Build cache: habilitado via `type=gha` — builds posteriores ~1-2 min

Nada de SSH, nada de secrets extra en GH Actions (solo el `GITHUB_TOKEN` interno que publica a GHCR del mismo repo).

## Troubleshooting

| Síntoma | Diagnóstico |
|---|---|
| `pull access denied` en el host | Package todavía privado. Ir a `github.com/users/gabfrank/packages/container/frc-dashboard/settings` → Change visibility → Public |
| `SASL: client password must be a string` | `PG_PASSWORD` vacío o no seteado per-server. Revisar `/dashboard/admin/servers/<id>` |
| Notificaciones no llegan | `docker compose logs jobs | grep notify-alerts`; `EVOLUTION_API_KEY` y estado `open` de la instancia |
| `host_unreachable` spam | Revisar `/dashboard/admin/alertas`: host_unreachable debe estar en severity `info`. Si no, `sqlite3 /data/dash.db` y correr la query del README de refine |

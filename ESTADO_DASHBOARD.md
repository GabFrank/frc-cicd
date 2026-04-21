# Estado del Dashboard FRC — observación por equipo dev

**Deploy:** `172.25.0.172` (Fedora 41 + Docker CE + ZeroTier) — 2026-04-21
**Fuente:** `ghcr.io/gabfrank/frc-dashboard:latest` (build + push automático por GH Actions en cada push a `master`)
**Ciclo de actualización:** manual hoy (`docker compose pull && up -d` en el host). Cron `*/10` recomendado post-observación.

## Acceso

| Servicio | URL interna (ZeroTier) | Login |
|---|---|---|
| Dashboard (overview, alertas, admin) | `http://172.25.0.172:3000` | `admin` / _password guardado en 1Password_ |
| TV fullscreen | `http://172.25.0.172:3000/tv` | mismo login |
| Manager Evolution API (WhatsApp) | `http://172.25.0.172:8090/manager` | API key en `.env` del host |
| n8n (workflows opcionales) | `http://172.25.0.172:5678` | `admin` / _password en .env_ |

**Requisito**: ZeroTier con la red FRC activa en tu máquina.

## Qué monitorea hoy

- **30 servidores** registrados (central + filiales + hosts dev). Ver en `/dashboard/admin`.
- **Jobs** corriendo 24/7:
  - `sync-github` — tomas novedades de los 4 repos cada 5 min.
  - `sync-health` — actuator/health de cada instancia central + TCP reachability por IP.
  - `sync-replication` — pubs/subs/slots/sucursal para central + filiales monitoreadas.
  - `evaluate-alerts` + `notify-alerts` — pipeline completo con state machine y anti-ruido.
- **Alertas** enviadas a grupo WhatsApp **FRC DEVELOPERS** (JID `120363399770851319@g.us`).

## Qué buscar durante la observación

El dashboard es nuevo y en producción por primera vez. **No asumimos** que está 100% pulido. Pedimos al equipo:

### Bugs de producto (prioridad alta)
- Alertas WhatsApp que llegan mal (formato raro, duplicadas, no deberían haber llegado).
- UI rota (404s, errores JS, datos que no cargan).
- Páginas que no se actualizan (polling cada 30s debe refrescar).
- Sidebar de alertas con datos stale.

### Falsos positivos / falsos negativos
- Alerta que llegó pero no era un problema real.
- Problema real que **no** generó alerta (el más grave — reportar con captura de pantalla o SSH output).

### UX
- Cosas que no se entienden en los nombres, iconos, pills.
- Información que está pero cuesta encontrarla.
- Información faltante.

### Performance
- Tiempos de carga >2s en páginas.
- Tabs/views que se traban con muchos datos.

## Cómo reportar

Crear issue en el repo de infra (`GabFrank/frc-cicd`) con label `dashboard-obs` y la siguiente plantilla:

```
### Qué pasó
(qué viste, cuándo)

### Qué esperabas
(qué debería haber pasado)

### Reproducción
(pasos para que otro lo vea, o captura de la WhatsApp/UI)

### Severidad sugerida
[ ] bug que bloquea a otro  (fix inmediato)
[ ] falso positivo / ruido   (ajustar umbral)
[ ] UX                       (backlog)
[ ] feature request          (backlog largo)
```

**Triage:** lunes a la mañana, Dev Lead revisa lo acumulado, decide qué se arregla en la semana y qué queda en backlog.

## Telemetría útil (para debugging propio)

Dentro del host (vía SSH a `franco@172.25.0.172`):

```bash
sudo -i
cd /opt/frc-cicd

# Ver alertas actuales en DB
docker exec frc-dashboard sqlite3 /data/dash.db \
  "SELECT kind, state, severity, title FROM alerts WHERE resolved_at IS NULL"

# Ver últimos mensajes enviados
docker exec frc-dashboard sqlite3 /data/dash.db \
  "SELECT sent_at, event_kind, status, substr(error_message,1,80)
   FROM notification_log ORDER BY id DESC LIMIT 20"

# Logs del runner
docker compose logs --tail=50 jobs

# Logs del dashboard Next
docker compose logs --tail=50 dashboard

# Estado de containers
docker compose ps
```

## Qué se arregla ya / qué no

Durante la observación, **solo se aceptan cambios** si:
- Corrigen un bug de comportamiento (no de estética).
- El riesgo de regresión es bajo (refactors grandes se posponen).
- Hay una ruta clara de rollback (deploy anterior sigue en `:sha-<anterior>` en GHCR).

Cambios mayores (nuevas features, redesign de páginas, cambiar estructura del DB) esperan al fin de la observación para ser planificados en una ventana nueva.

## Referencias

- [`dashboard/DEPLOY.md`](dashboard/DEPLOY.md) — cómo se deployó, cómo actualizar el host on-prem.
- [`dashboard/STATUS.md`](dashboard/STATUS.md) — progreso de features y refinamientos, commits relevantes.
- [`plan-ejecucion-maestro.md`](plan-ejecucion-maestro.md) — Fase 11 (dashboard) y Fase 12 (observación + Farmacia).
- Dashboard code: `dashboard/` en este repo. Commits recientes bajo `feat(dashboard):` / `fix(dashboard):` en `master`.

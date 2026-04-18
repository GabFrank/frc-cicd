# Notificaciones — Evolution API + n8n

Stack auxiliar para **WhatsApp** (Evolution API) y workflows opcionales (**n8n**). No comparte código con el dashboard; solo convive en el mismo `docker compose` de la raíz del repo.

## Requisitos

- Docker Compose v2.20+ (soporte `include:` en el compose raíz).
- Variables en `notifications/.env` (partir de `.env.example`).

## Arranque

Desde la raíz del repo (`frc-cicd/`):

```bash
cp dashboard/.env.example dashboard/.env
cp notifications/.env.example notifications/.env
# editar ambos archivos

docker compose --env-file dashboard/.env --env-file notifications/.env up -d --build
```

Servicios:

| Servicio           | Puerto host      | Uso                                      |
|--------------------|------------------|------------------------------------------|
| `evolution-api`    | `127.0.0.1:8090` | REST + Manager UI (`/manager`)           |
| `n8n`              | `127.0.0.1:5678` | Editor workflows (basic auth)          |
| Postgres / Redis | internos         | Persistencia Evolution                   |

## Primera vez — instancia WhatsApp

1. Abrir `http://127.0.0.1:8090/manager` (o el dominio público si nginx ya apunta aquí).
2. Crear instancia con el mismo nombre que `EVOLUTION_INSTANCE_NAME` del dashboard (por defecto `frc-alertas`), motor **WHATSAPP-BAILEYS**.
3. Escanear QR con el celular del número emisor.
4. En el dashboard: **Notificaciones** → alta de destinatario (JID o número) + regla.
5. Probar: `POST /api/admin/notifications/test` con sesión admin.

## n8n (opcional)

1. Login en `http://127.0.0.1:5678` con `N8N_AUTH_USER` / `N8N_AUTH_PASS`.
2. Crear workflow con **Webhook** (POST) y nodo HTTP Request a Evolution (`POST /message/sendText/{instance}` con header `apikey`).
3. Copiar URL del webhook y pegarla en el dashboard como `N8N_ALERT_WEBHOOK_URL`.

El runner del dashboard **siempre** intenta envío directo a Evolution si está configurado; el webhook es adicional (híbrido).

## Troubleshooting

- **503 / sin QR**: revisar `EVOLUTION_PUBLIC_URL` accesible desde el navegador donde abrís el Manager.
- **No llega mensaje**: `GET /instance/connectionState/{instance}` debe devolver `state: open`. Re-emparejar con `/instance/connect/{instance}`.
- **n8n no arranca**: logs `docker compose logs n8n`; verificar password Postgres.

## nginx

Ver `dashboard/deploy/nginx.conf.example` para subdominios TLS + `auth_basic` en n8n y restricción por IP en Evolution Manager.

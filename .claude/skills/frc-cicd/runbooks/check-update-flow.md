# check-update.sh / check-update.ps1 — cómo funciona

Script que corre en cada filial cada 15 min (cron linux / Task Scheduler windows). Es el mecanismo de self-service update de filiales. Fuente: `frc-cicd/scripts/`.

## Variables de entorno / archivos de config

Cada filial lee:
- `/opt/frc-filial/.channel` → `alpha` / `beta` / `stable` (qué canal seguir).
- `/opt/frc-filial/.filial-id` → identificador único (e.g. `farmacia-filial-1-linux`).
- `/opt/frc-filial/.github-token` → PAT con scope `repo` + `read:packages` para leer releases y crear deployments.
- `/opt/frc-filial/.current-version` → versión actualmente instalada (string plano, e.g. `4.1.0-beta.3`).

Variables internas críticas del script:
- **`SERVICE_NAME` debe ser `frc.service`** (Linux) — el unit real en toda la flota; el NOPASSWD sudoers es para ese nombre. Con `frc-filial.service` el restart pide password y falla bajo cron. En Windows el proceso lo maneja el Scheduled Task `FRC-Filial-Server`.
- `SERVER_PORT` se lee del `.env` (default 8080; las filiales usan 8082).

Si una filial no actualiza, ver [stuck-filial-diagnosis.md](stuck-filial-diagnosis.md) (4 modos de falla).

## Flujo del script (linux)

1. **Get latest version** del canal via GitHub API:
   ```
   GET /repos/GabFrank/franco-system-backend-filial/releases
   ```
   Filter: `prerelease=true and contains("beta")` para canal beta. Idem alpha. Para stable: no-prerelease.

2. **Compare con `.current-version`**. Si igual → `Already up to date` y exit 0.

3. **Download AAB del GitHub Release** al path `/opt/frc-filial/releases/<VERSION>/frc-filial-server.jar`.

4. **Update symlink** `/opt/frc-filial/current` → `/opt/frc-filial/releases/<VERSION>`.

5. **Restart service:** `sudo systemctl restart frc.service`.
   - Requiere NOPASSWD sudoers (ver [sudoers-patterns.md](sudoers-patterns.md)).

6. **Health check** polling contra `http://localhost:8082/actuator/health` hasta 120s.

7. **Si health pasa** → `notify_github` con `state=success`.
   **Si falla** → rollback symlink a versión anterior + `notify_github` con `state=failure`.

8. Update `/opt/frc-filial/.current-version` a la nueva versión si pasó.

## GitHub deployment notification

Función `notify_github` en el script. Hace 2 POSTs:

```bash
# 1. Create deployment
curl -H "Authorization: token $TOKEN" \
     -H "Accept: application/vnd.github+json" \
     -X POST "https://api.github.com/repos/$REPO/deployments" \
     -d '{
           "ref": "v<VERSION>",
           "environment": "<FILIAL_ID>",
           "description": "Auto-update from check-update.sh",
           "required_contexts": [],
           "auto_merge": false
         }'
# response: { "id": <DEPLOY_ID>, ... }

# 2. Set deployment status
curl -H "Authorization: token $TOKEN" \
     -H "Accept: application/vnd.github+json" \
     -X POST "https://api.github.com/repos/$REPO/deployments/$DEPLOY_ID/statuses" \
     -d '{"state":"success","environment":"<FILIAL_ID>","description":"Health check passed (HTTP 200)"}'
```

El dashboard lo levanta en el próximo `sync-github` job (cada 5 min) y actualiza el registro de la filial.

## Gotcha — notificación salteada si bypasseás el script

**Si reiniciás el service a mano** (`sudo systemctl restart frc.service`) **salteás la llamada a `notify_github`.** El jar nuevo queda corriendo pero GitHub sigue creyendo que la filial corre la versión anterior. El dashboard mostrará desalineación.

**Fix:** volver a correr el script (`/opt/frc-filial/check-update.sh`) para que haga el notify. Pero si el current-version ya coincide con la latest, el script corta antes de llegar al notify. En ese caso, o:
1. Esperar al próximo release natural (el próximo check-update sí va a notificar).
2. Hacer el `POST /repos/.../deployments` manualmente con `curl` (requiere token + OK del operador porque altera estado compartido en GitHub).

## Comando manual para forzar un check ya (sin esperar cron)

Linux:
```bash
ssh franco@<IP> "/usr/bin/flock -n /tmp/frc-filial-update.lock /opt/frc-filial/check-update.sh"
```

Windows:
```powershell
ssh franco@<IP> "powershell -File C:\frc-filial\check-update.ps1"
```

El `flock -n` evita concurrencia con el cron que tal vez esté corriendo simultáneo. Si hay otro ejecución en curso, sale inmediato (no bloquea).

## Logs

- Linux: `/opt/frc-filial/logs/update.log` (stdout del script) + `/opt/frc-filial/logs/check-update.log` o `/var/log/frc-filial/check-update.log` (cron output).
- Windows: `C:\frc-filial\logs\update.log` + `C:\frc-filial\logs\check-update.log`.

Cada ejecución agrega un header tipo:
```
========== 2026-04-23 10:07:40 ==========
Filial: farmacia-filial-1-linux
Channel: beta
Current version: 4.1.0-beta.2
Latest version for beta: 4.1.0-beta.3
New version available: 4.1.0-beta.3 (current: 4.1.0-beta.2)
```

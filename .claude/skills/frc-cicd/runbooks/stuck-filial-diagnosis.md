# Filial pegada en versión vieja — diagnóstico y rescate

Cuando una filial no actualiza (su `/api/version` se queda atrás mientras las demás avanzan), hay **4 modos de falla distintos**. Este runbook los distingue y da el fix de cada uno. Descubiertos/validados en la promoción `filial v4.2.0 → bodega` (2026-06-11).

## Paso 0 — cuál es el estado real

Nunca confíes en el marker solo. Comparar **versión corriendo** vs **marker** vs **logs**:

```bash
# versión REALMENTE corriendo (endpoint del backend, read-only)
curl -s http://<IP>:8082/api/version          # filial: devuelve versión real
# nota: CENTRAL devuelve "@project.version@" (placeholder Maven sin filtrar) — inútil para central

# marker en disco
ssh franco@<IP> 'cat /opt/frc-filial/.current-version'        # linux
ssh franco@<IP> 'powershell "Get-Content C:\frc-filial\.current-version"'  # windows

# log del último check
ssh franco@<IP> 'tail -20 /opt/frc-filial/logs/update.log'    # linux
```

Dos patrones clave:
- **marker == running, ambos viejos** → el check-update nunca avanzó: falla **antes** de instalar (modo A o B).
- **marker NUEVO, running viejo (drift)** → descargó e instaló el marker pero **el restart falló** (modo C o D).

## Modo A — Token GitHub expirado (401)

**Síntoma:** log repite `ERROR: Failed to query GitHub API: (401) No autorizado`. marker==running, viejos. El task/cron corre pero corta en la query.

**Causa:** `.github-token` expirado/revocado. Cada 15 min pega a GitHub, recibe 401, sale antes de descargar.

**Fix:** reemplazar el token con uno válido (`GITHUB_PAT` del `.env` del repo frc-cicd). Validar primero sin imprimirlo:
```bash
curl -s -o /dev/null -w "%{http_code}" -H "Authorization: token $GITHUB_PAT" \
  https://api.github.com/repos/GabFrank/franco-system-backend-filial/releases/latest   # espera 200
```
Escribir vía archivo temp + scp (el valor nunca toca el transcript). Backup el viejo primero. Visto en bodega-4 (Windows) 2026-06-11.

## Modo B — `check-update` no corre

**Síntoma:** marker==running viejos, log sin entradas recientes (cron/task no dispara).

**Causa:** cron faltante (linux) o Scheduled Task `FRC-Filial-Update` deshabilitado (windows). Ver gotcha "Cron de check-update puede faltar".

**Fix:** recrear el cron / habilitar el task. Forzar un check manual: `/opt/frc-filial/check-update.sh` (linux) o `powershell -File C:\frc-filial\check-update.ps1` (windows).

## Modo C (Windows) — restart no reemplaza el proceso → drift

**Síntoma:** marker NUEVO, running viejo. Task `FRC-Filial-Server` con `LastRunTime` viejo (no reinició). Proceso java de hace días.

**Causa raíz (script viejo, pre-PR#2):**
1. El matcher de kill usaba `Get-Process.CommandLine`, que es **null en Windows** sin elevación → nunca mataba el proceso viejo → retenía el puerto 8082.
2. El proceso nuevo moría al bindear (puerto ocupado).
3. El health check pegaba solo a `/actuator/health` → el proceso **viejo** respondía 200 → **falso éxito** → escribía marker nuevo → drift permanente.

**Fix (en `check-update.ps1`, frc-cicd PR #2):** matar por **dueño del puerto** (`Get-NetTCPConnection -LocalPort … OwningProcess`), esperar puerto libre, relanzar vía **`Start-ScheduledTask FRC-Filial-Server`** (no `Start-Process`, que muere al cerrar la sesión), y **verificar `/api/version` == versión objetivo** antes de declarar éxito y escribir el marker.

**Rescate inmediato (sin esperar el script nuevo):** Windows → `Stop-ScheduledTask`+kill PID del puerto+`Start-ScheduledTask FRC-Filial-Server`. El junction `current` ya apunta al jar nuevo. Visto en farmacia filial 2 (2026-06-11).

## Modo D (Linux) — `sudo systemctl restart` falla → drift

**Síntoma:** marker NUEVO, running viejo. Log muestra:
```
Restarting frc.service...
sudo: a terminal is required to read the password ... a password is required
```

**Dos causas combinadas:**
1. **`SERVICE_NAME` errado en el script.** El unit real es **`frc.service`** en toda la flota (farmacia + bodega) y el NOPASSWD sudoers es para `frc.service`. El script viejo tenía `SERVICE_NAME="frc-filial.service"` → no matchea ningún NOPASSWD → pide password → falla bajo cron. **`apply-script-update.sh` sobreescribió la customización local `frc.service` de bodega con el default roto del repo.** Corregido en frc-cicd PR #2 (`SERVICE_NAME="frc.service"`).
2. **Sudoers gotcha #1** (ver [sudoers-patterns.md](sudoers-patterns.md)): `franco ALL=(ALL) ALL` duplicado **después** del `#includedir` en `/etc/sudoers` invalida el NOPASSWD. Afectó ~7 de 17 bodega.

**Fix completo:**
```bash
# 1. corregir el script on-disk (SERVICE_NAME=frc.service)
scp scripts/check-update.sh franco@<IP>:/opt/frc-filial/check-update.sh

# 2. arreglar sudoers (si tiene gotcha #1): comentar la línea 'franco ALL=(ALL) ALL'
#    que está DESPUÉS del #includedir. franco mantiene sudo via %wheel. Con backup + visudo -c:
sudo cp /etc/sudoers /etc/sudoers.frcbak
sudo sed -i -E 's/^(franco[[:space:]]+ALL=\(ALL\)[[:space:]]+ALL)[[:space:]]*$/# \1/' /etc/sudoers
sudo visudo -c || sudo cp /etc/sudoers.frcbak /etc/sudoers    # restore si inválido
# validar (read-only): sudo -k; sudo -n /usr/bin/systemctl status frc.service  → debe dar 0 sin password

# 3. cargar la versión staged
sudo systemctl restart frc.service        # nopasswd ya funciona; o por password si aún no se arregló sudoers
```

**Rescate masivo:** los hosts ya tienen el jar nuevo staged (junction `current` → versión nueva). Basta `sudo systemctl restart frc.service`. Los que aún tienen gotcha #1 sin arreglar: `echo "$PW" | sudo -S /usr/bin/systemctl restart frc.service` (one-shot por password) — pero **arreglá el sudoers** o vuelve a fallar en el próximo release.

## Tabla resumen

| Modo | marker vs running | señal | fix |
|---|---|---|---|
| A token 401 | ==, viejos | `401 No autorizado` en log | reemplazar `.github-token` |
| B no corre | ==, viejos | log sin entradas recientes | recrear cron / habilitar task |
| C Windows drift | marker nuevo, running viejo | `LastRunTime` task viejo | PR#2 script; rescate: Stop/Start task |
| D Linux drift | marker nuevo, running viejo | `sudo: a password is required` | SERVICE_NAME=frc.service + sudoers + restart |

## Verificación post-rescate

```bash
curl -s http://<IP>:8082/api/version    # == versión objetivo
curl -s http://<IP>:8082/actuator/health # {"status":"UP"} (implica Flyway OK)
```
Health UP tras restart con jar nuevo ⇒ Flyway aplicó las migraciones (Spring no llega a UP si fallan).

# Gotchas — lecciones que tomaron tiempo entender

Orden: infra → repos → mobile → dashboard → replicación. Mantené este archivo cuando aparezca un gotcha nuevo.

## Infra / SSH / Linux

### `configuraciones.notificacion_envio_log` crece sin límite — truncada a mano + cron temporal (2026-08-11)
**Qué pasa:** en central bodega (`172.25.1.200`, PG 5552, DB `bodega`) la tabla `configuraciones.notificacion_envio_log` (log de envíos FCM del servicio de notificaciones, aún en prueba / peso muerto) creció a **43 GB / ~51,5 M filas** — el 67% de una DB de 64 GB. Farmacia no la sufre (1.2 GB) porque no tiene ese volumen de notificaciones. El servicio no tiene política de retención.

**Por qué es seguro limpiarla:** la tabla **no tiene dependientes FK, no tiene triggers/reglas, no está particionada, y NO está en `replication_table` / ninguna publicación** → truncarla/borrarla no afecta ninguna otra tabla ni a las filiales. La app sí la LEE (dedupe `existsByNotificacionIdAndEstadoEnvioIn` + cola de reintento `findBatchByEstado`), así que un TRUNCATE total pierde la ventana reciente de dedupe/retry (riesgo de push duplicados/pendientes perdidos) — aceptable mientras el servicio sea peso muerto.

**Qué se hizo (2026-08-11):**
1. `TRUNCATE TABLE configuraciones.notificacion_envio_log;` → liberó 43 GB al OS (bodega **64 GB → 21 GB**). Gotcha: la tabla es tan grande que 3 SELECT de Hibernate la mantienen con `ACCESS SHARE` ~7s cada uno y el TRUNCATE no consigue `ACCESS EXCLUSIVE` — con `lock_timeout` corto cancela. Fix: `SET lock_timeout='60s'; TRUNCATE ...` para que **se encole** detrás de los lectores (los nuevos esperan unos segundos; solo afecta al servicio dead-weight, no al POS).
2. **Cron temporal** (crontab de `franco` en central) que purga lo de > 1 h cada 10 min con un DELETE (no TRUNCATE → no toma `ACCESS EXCLUSIVE`, no choca con lecturas):
   - `*/10 * * * * /home/franco/notif-log-purge.sh >> /home/franco/notif-log-purge.log 2>&1  # TEMP-notif-purge`
   - `notif-log-purge.sh`: `psql ... -c "SET lock_timeout='30s'; DELETE FROM configuraciones.notificacion_envio_log WHERE fecha_envio < now() - interval '1 hour';"`

**⚠️ RETIRAR cuando se arregle/reescriba el servicio de notificaciones:**
```bash
ssh franco@172.25.1.200
crontab -l | grep -v 'TEMP-notif-purge' | crontab -   # saca la línea del cron
rm /home/franco/notif-log-purge.sh                    # borra el script
```
Fix de raíz pendiente: el servicio debe tener retención propia (o dejar de loguear cada envío). No hay índice en `fecha_envio`; mientras el cron la mantenga chica el seq-scan del DELETE es barato, pero si se re-habilita el crecimiento conviene un índice.

### Sudoers NOPASSWD puede quedar oculto por regla genérica anterior
**Qué pasa:** `/etc/sudoers.d/franco-frc` tiene `NOPASSWD: /usr/bin/systemctl restart frc.service`, pero `sudo -n` sigue pidiendo password. `sudo -n -ll` muestra que franco también tiene `ALL=(ALL) ALL` desde `/etc/sudoers`.

**Por qué:** sudo aplica la regla del **último match**. Si la línea genérica `franco ALL=(ALL) ALL` (o `%wheel ALL=(ALL) ALL` con franco en wheel) en `/etc/sudoers` viene después del `#includedir`, gana y pide password.

**Fix durable:** `sudo visudo` → comentar la línea genérica de franco/wheel. Un drop-in en `/etc/sudoers.d/zz-franco-frc-nopasswd` NO alcanza por el mismo problema de orden (el `/etc/sudoers` post-include sigue ganando).

Ver [runbooks/sudoers-patterns.md](runbooks/sudoers-patterns.md) para procedimiento completo.

### Timezone Paraguay: hora mostrada 1h atrás aunque el instante en DB esté bien
**Qué pasa:** DB muestra una venta a las 15:11 pero desktop muestra 14:11. Paraguay abolió el cambio de hora (UTC-3 permanente, decreto oct-2024, tzdata **2025a**), pero componentes con tzdata embebida vieja siguen aplicando -04 en invierno.

**Por qué (cadena, verificada 2026-07 en central 172.25.1.200):**
- El instante en DB (`timestamptz`) es **correcto** — el error es solo de conversión al mostrar.
- **JVM**: OpenJDK usa su propio `tzdb.dat`, no la zoneinfo del OS. java-17-openjdk 17.0.13 (fc39) trae tzdb 2024a → Asunción invierno = -04. Las entidades usan `LocalDateTime` + JDBC convierte con la tz default de la JVM → el GraphQL scalar `Date` serializa string sin offset → desktop muestra tal cual. **La JVM es el culpable del display en desktop.**
- **PostgreSQL**: usa system tzdata (build Fedora), pero **cachea zonas cargadas en el postmaster** — si el tzdata del OS se actualizó después del start del cluster, `AT TIME ZONE 'America/Asuncion'` sigue devolviendo -04 hasta reiniciar el cluster. Ojo: `pg_timezone_names` lee los archivos frescos y muestra -03, contradiciendo a `AT TIME ZONE` — no confiar en esa vista para diagnosticar.
- **OS**: verificar con `zdump -v America/Asuncion | grep 202` — si no hay transiciones después de oct-2024, el archivo está bien.
- Sesiones psql manuales muestran "bien" la hora solo porque `TimeZone=America/Argentina/Buenos_Aires` (-03 fijo) en la config del cluster.

**Fix:** actualizar tzdb de la JVM (JDK ≥ 17.0.14 trae 2025a; fc39 está EOL → instalar Temurin tarball o reemplazar `$JAVA_HOME/lib/tzdb.dat`) + reiniciar clusters PG para vaciar el cache. Aplica a central Y a todas las filiales (misma cadena JVM). Evitar `-Duser.timezone=America/Argentina/Buenos_Aires` como workaround: corrige el futuro pero corre +1h la visualización de fechas históricas de invierno pre-2024.

**Diagnóstico rápido JVM:** `java` del servicio + one-liner `ZoneRulesProvider.getVersions("America/Asuncion").lastKey()` → si < 2025a, está viejo.

### Subnet-router tailscale/headscale no forwardea: falta `tailscale0` en zona firewalld
**Qué pasa (2026-07-09, montando el bridge headscale VM Hetzner → flota `172.25.*`):** subnet-router mauro anuncia `172.25.0.0/16`, ruta aprobada en headscale, `ip_forward=1`, la VM tiene la ruta en kernel (`ip route get 172.25.1.200 → dev tailscale0`), y aun así **100% packet loss**. mauro alcanza `172.25.1.200:8082` perfecto por sí mismo, pero no reenvía el tráfico de la VM.

**Por qué:** en Fedora con firewalld, el reenvío entre interfaces se gobierna por zonas. `tailscale0` **no estaba asignada a ninguna zona** → cae en la default (`FedoraServer`), que dropea el forward hacia la interfaz ZeroTier (`ztyxataffb`, que sí estaba en `trusted`). El paquete entra por tailscale0 y firewalld lo mata antes de rutearlo al zt.

**Fix durable (en el subnet-router):**
```bash
sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0
sudo firewall-cmd --reload
```
Con ambas interfaces (`tailscale0` + la de la red destino) en `trusted`, el forward pasa. No hace falta `--add-masquerade`: tailscale ya hace SNAT de subnet-routes por default (`NoSNAT:false`), así el retorno vuelve a la IP del router (`172.25.0.172`). Verificar desde la VM: `curl` al actuator del central y `/dev/tcp` a los puertos PG.

> Resto de gotchas de VPN (runner cloud no alcanza `100.64.x.x`, `--ephemeral` en servidores, nodo offline confundido con VPN rota, bridge SPOF, doble dirección durante el rollout): **[runbooks/headscale.md](runbooks/headscale.md)**.

### DOCKER_HOST override obligatorio en 172.25.0.172
**Qué pasa:** `docker ps` falla con `Cannot connect to the Docker daemon at unix:///home/franco/.docker/desktop/docker.sock`.

**Por qué:** Docker Desktop dejó residuos en config de franco. El socket real es `/var/run/docker.sock`.

**Fix:** prefijar con `DOCKER_HOST=unix:///var/run/docker.sock` cualquier invocación de `docker` o `docker compose`.

### Imagen `alpine` no pullable en 172.25.0.172
**Qué pasa:** `docker pull alpine` → `error getting credentials - err: exec: "docker-credential-desktop": executable file not found`.

**Por qué:** mismo residual de Docker Desktop afecta el credential store.

**Fix:** usar imágenes ya cacheadas. `postgres:16-alpine` y `redis:7-alpine` están presentes — apk-install sqlite / curl / lo-que-haga-falta **dentro** del contenedor.

### Cron de check-update puede faltar
**Qué pasa:** una filial instalada manualmente sin seguir todo el runbook queda con `check-update.sh` presente pero **sin cron**. Nunca vuelve a chequear updates. Se detecta porque la versión queda estancada mientras las otras filiales avanzan.

**Fix:** instalar línea de cron en el crontab de `franco`:
```
*/15 * * * * /usr/bin/flock -n /tmp/frc-filial-update.lock /opt/frc-filial/check-update.sh >> /opt/frc-filial/logs/check-update.log 2>&1
```
Path de log `/opt/frc-filial/logs/` evita necesitar sudo para crear `/var/log/frc-filial/`. Si tenés sudo, usar `/var/log/frc-filial/` por consistencia con filiales más nuevas.

### Hostname no confiable como identificador
**Qué pasa:** múltiples filiales Linux dicen `localhost.localdomain` o `fedora` como hostname.

**Fix:** usar el archivo `/opt/frc-filial/.filial-id` (e.g. `farmacia-filial-1-linux`) o la IP para identificar univocamente.

### Hay (había) dos `frc-alpha.service` y el inventario apuntaba al equivocado (2026-08-14)
**Qué pasa:** todo lo que asumía «central alpha = `159.203.86.103:8083`» apuntaba a una instancia sin usuarios, congelada en `4.1.0-alpha.67` desde el 23-jul-2026. El alpha real —el que recibe los deploys y corría `4.7.0-alpha.39`— vive en **mauro (`172.25.0.172:8083`)**, junto con la filial alpha.

**Por qué:** el central alpha se movió a mauro y nadie apagó el servicio viejo en la VM DigitalOcean. Los dos units se llaman igual, escuchan el mismo puerto y responden; solo se distinguen por `.current-version`.

**Cómo se detecta:**
```bash
cat /opt/frc-backend-central/alpha/.current-version   # en cada host
systemctl show frc-alpha.service -p ActiveEnterTimestamp
```
Si la fecha es de semanas atrás y el journal solo tiene ruido de escaneo de internet (`Invalid character found in method name [0x16 0x03 0x01…]` = ClientHello TLS contra puerto HTTP plano), es el zombi.

**Y hay dos bases `alpha`.** La instancia viva en mauro usa
`jdbc:postgresql://localhost:5553/alpha` — el cluster **de mauro**. En la VM de
producción quedó una DB `alpha` huérfana en su propio 5553. Un fix SQL corrido
contra la huérfana no cambia nada de lo que se ve en la app, y parece que sí
funcionó. **Antes de tocar la DB de alpha, confirmar el host.**

**Fix:** el zombi de la VM DO se apagó el 2026-08-14 (`systemctl stop`; ya estaba `disabled`, o sea llevaba 3 semanas vivo solo porque nadie reinició la VM). El 8083 de `159.203.86.103` quedó libre. **Antes de creerle a cualquier doc sobre alpha, verificar contra `.current-version` del host.** Ojo también con `frc-cicd/dashboard/lib/config.ts`: tenía `central-alpha` apuntando al zombi, o sea el dashboard vigilaba el host equivocado.

### `DROP SUBSCRIPTION` se cuelga si el publisher no contesta — y el fallback puede romper a otro (2026-08-15)
**Qué pasa:** `DROP SUBSCRIPTION x` queda colgado indefinidamente (>4 min, sin timeout). El `ALTER SUBSCRIPTION x DISABLE` previo sí funciona.

**Por qué:** aunque esté deshabilitada, el `DROP` abre una **conexión nueva** al publisher para borrarle el slot. Si esa conexión no prospera, espera para siempre y **bloquea a cualquier otra consulta sobre `pg_subscription`** en esa base — el síntoma secundario es que "psql se cuelga" en cosas que no tienen nada que ver.

**Fix:**
```sql
ALTER SUBSCRIPTION x DISABLE;
ALTER SUBSCRIPTION x SET (slot_name = NONE);   -- desliga el slot remoto
DROP SUBSCRIPTION x;                            -- ya no intenta conectarse
```
Limpiar los backends que quedaron: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='<db>' AND pid<>pg_backend_pid();`

> ⚠️ **`slot_name = NONE` deja el slot vivo en el publisher, y ese slot puede NO ser huérfano.**
> Antes de borrarlo con `pg_drop_replication_slot`, **verificar quién lo está usando**:
> ```sql
> SELECT pid, client_addr, application_name, state FROM pg_stat_replication;
> ```
> Pasó el 2026-08-15: el slot `alpha_filial2_sub` en mauro parecía huérfano tras
> limpiar una suscripción duplicada en central, y en realidad lo consumía la
> suscripción **viva** del propio alpha de mauro. Borrarlo habría cortado la
> replicación del canal alpha. Un `active=true` con `client_addr` = la IP del
> **mismo host** significa que el consumidor es local, no el que acabás de tocar.

### Dos suscripciones con el mismo nombre peleando por un slot (2026-08-15)
**Qué pasa:** una suscripción queda en `state=startup` para siempre y la replicación del otro consumidor se ve intermitente.

**Por qué:** un slot lo puede tomar **un solo** consumidor. Si una instancia se muda de host y la suscripción se recrea con el mismo `slot_name` sin borrar la vieja, las dos compiten: una streamea y la otra reintenta en `startup`.

**Cómo se ve:** `SELECT pid, client_addr, application_name, state FROM pg_stat_replication;` devuelve **dos filas con el mismo `application_name`** y distinta `client_addr`.

**Fix:** borrar la suscripción del host que ya no corresponde, con el procedimiento de arriba (`slot_name = NONE`), y dejar intacto el slot que usa la viva.

### Slot inactivo anclando WAL en bodega — `bodega_filial25_central_sub` (visto 2026-08-15)
**Qué pasa:** en el cluster **5552** de central (DB `bodega`, productiva) hay **38 slots y 1 inactivo**, `bodega_filial25_central_sub`, reteniendo **991 MB de WAL**. Crece mientras la filial 25 no vuelva.

**Es el mismo modo de falla que la filial 5 de farmacia** (~3,8 GB), pero este no estaba documentado. Disco al 41% (62 G de 159 G) — no urgente, sí acumulativo.

**Qué NO hacer:** borrar el slot a la ligera. Al volver la filial, sin slot necesita resync completo. Primero averiguar si la sucursal sigue operando.

## Repos / CI/CD

### Deploy workflow resuelve versión incorrecta (alpha/beta)
**Qué pasa:** `gh workflow run Deploy` con instance=alpha resuelve una versión vieja (ej: `alpha.9` en vez de `alpha.11`) aunque la release más nueva exista y tenga el JAR.

**Por qué:** el jq en "Resolve version" usa `[0]` sobre el array filtrado de `/releases`. La API de GitHub NO garantiza orden por fecha — el orden es por release ID interno, que puede diferir si se recrearon releases. Así `alpha.9` puede aparecer antes que `alpha.11`.

**Afecta:** `central` (deploy.yml) y `mobile` (deploy-playstore.yml). Desktop y filial no tienen deploy workflow. Canal `bodega`/`production` NO afectado (usa `/releases/latest` de GitHub).

**Fix (aplicado 2026-05-04):** agregar `| sort_by(.published_at) | reverse |` antes del `.[0]` en los filtros alpha y beta:
```bash
# Antes (buggy):
jq -r '[.[] | select(...)][0].tag_name'
# Después (correcto):
jq -r '[.[] | select(...)] | sort_by(.published_at) | reverse | .[0].tag_name'
```
Aplicado en `develop` de central y mobile. Propagado a `master` y `release/beta` vía promoción 2026-05-05.

### Health check timeout insuficiente cuando Flyway crea indexes en tablas grandes
**Qué pasa:** deploy workflow falla por timeout del health check aunque el servidor esté arrancando correctamente.

**Por qué:** `HEALTH_TIMEOUT=120` en `deploy.sh` no alcanza cuando Flyway necesita crear indexes en tablas grandes (ej: V98.3 tardó 1:35 en bodega). Startup total puede superar 2 minutos fácilmente.

**Fix:** aumentar `HEALTH_TIMEOUT` en `.github/scripts/deploy.sh`. 300 segundos (5 min) da margen suficiente para migraciones pesadas. Considerar que el health check de central reporta `DOWN` por el indicator AMQP legacy (ver gotcha separado) — el script debe validar que el endpoint responda, no que reporte `UP`.

### Cloudflare Access delante de una PWA rompe el service worker (2026-08-15)
**Qué pasa:** la app carga y se usa con normalidad, pero la consola tira en cada arranque:
```
Access to fetch at 'https://<equipo>.cloudflareaccess.com/…' (redirected from
'https://<app>/manifest.webmanifest') has been blocked by CORS policy
Error: Response not Ok (fetchAndCacheOnce): … returned response 504
```
**Y lo que se rompe no es visible: la app deja de poder actualizarse.**

**Por qué:** Access intercepta **todas** las rutas del hostname. El grupo `app` de `ngsw-config.json` está en modo `prefetch` y contiene el shell entero —`/index.html`, `/manifest.webmanifest`, `/*.css`, `/*.js`—. Cuando el worker los pide, Access responde 302 hacia el dominio de login, que es **otro origen**: el CORS lo bloquea, `fetchAndCacheOnce` tira, el grupo nunca termina de instalarse y **la versión nueva no se activa jamás**. La navegación inicial sí funciona porque lleva la cookie, así que el fallo se ve como "errores raros en consola" y no como "la app no se actualiza".

**No tiene arreglo limpio.** Una política de *bypass* para los assets tiene que incluir `/index.html`, y como el `_redirects` de la SPA sirve ese archivo para toda ruta, bypassearlo deja a Access sin nada que proteger.

**Fix:** no poner Access delante de una PWA. En este ecosistema la protección real es el login del ERP — el central rechaza con 401 todo lo que llegue sin `Authorization: Token`, así que el shell estático no expone datos. Si hace falta un filtro, una regla WAF (país, rate limit) no toca al service worker.

> ⚠️ **Después de sacar Access, el navegador queda con un service worker en estado fallido.** No se arregla solo: DevTools → Application → Service Workers → *Unregister* y recargar.

### GitHub no reapunta las PR encadenadas si no borrás la rama del head (2026-08-15)
**Qué pasa:** con una cadena `#1 → #2 → #3` donde cada PR sale de la rama de la anterior, al mergear la #1 se espera que la #2 pase a apuntar a `develop` sola. **No pasa** si al mergear se conserva la rama del head.

**Por qué:** el reapuntado automático lo dispara el **borrado** de la rama base, no el merge.

**Fix:** borrar la rama al mergear (o activar *Automatically delete head branches* en el repo), o reapuntar a mano.

> ⚠️ **`gh pr edit --base` falla contra `frc-mobile-pwa`** con un error de Projects classic. Hay que hacerlo por API:
> ```bash
> gh api -X PATCH repos/GabFrank/frc-mobile-pwa/pulls/<N> -f base=develop
> ```

### Una PR abierta antes de que existiera el workflow no tiene checks (2026-08-15)
**Qué pasa:** se agrega `ci.yml` al repo, y las PR ya abiertas siguen sin ningún check. Con la protección de rama exigiendo ese check, quedan **imposibles de mergear**.

**Por qué:** los workflows de `pull_request` se evalúan ante un **evento nuevo** (push, reopened, synchronize). Una PR que no se movió desde antes del workflow nunca lo dispara.

**Fix:** cualquier push a la rama, o cerrar y reabrir la PR. **Ojo con el orden al montar CI/CD en un repo con PR en vuelo:** conviene mergearlas —o forzarles una corrida— *antes* de exigir el check en la protección, o se traban todas.

**Cuando no se puede esperar:** simular el merge en un worktree aparte y correr ahí el build y los tests antes de aplicarlo. Es lo que se hizo con las PR #1 a #3 de la PWA: sin eso, un merge roto habría publicado igual, porque `release.yml` publica con que haya versión nueva, sin depender de `ci.yml`.

### `release/beta → master` nunca con squash
**Qué pasa:** si se hace squash merge, semantic-release colapsa los `feat:`/`fix:` y calcula mal el bump (a veces no genera tag, a veces genera patch cuando debería ser minor).

**Fix:** estrategia **merge commit** explícita. En `gh pr merge <N> --merge` siempre.

### `hotfix/*` sale de `master`, NO de `develop`
**Qué pasa:** si se ramifica de develop, el hotfix incluye código no-liberado de develop y rompe producción al mergear.

**Fix:** `git checkout master && git pull && git checkout -b hotfix/...`. Después del merge a master, **PR obligatorio `master → develop`** para que develop tenga el fix.

### Jira Automation `description` rompe JSON del dispatch
**Qué pasa:** ticket con description (texto libre con comillas, saltos de línea) genera error 400 "Problems parsing JSON" al hacer `repository_dispatch`.

**Por qué:** el customBody de la regla Jira usaba `{{issue.description}}` sin escapar. Comillas y newlines en el texto rompen el JSON literal.

**Fix:** aplicar `.jsonEncode` a los smart values de texto libre: `{{issue.summary.jsonEncode}}`, `{{issue.description.jsonEncode}}`, `{{issue.Acceptance Criteria.jsonEncode}}`. Aplicado 2026-04-30.

### Auto-agent PR sin identificación de IA
**Qué pasa:** primer run real (FD-146) generó PR que parecía trabajo humano: no era draft, sin label `auto-agent`, usó `fix:` en vez de `feat:`, sin `Co-Authored-By`.

**Por qué:** instrucciones en el issue body (generado por `jira-receiver.yml`) no eran suficientemente explícitas sobre trazabilidad.

**Fix:** actualizado `jira-receiver.yml` en los 4 repos (reglas 5, 7, 8): prefijo correcto según tipo, label `auto-agent`, `Co-Authored-By` trailer, footer `Generated by Claude Code (auto-agent)`. Aplicado 2026-04-30.

### `workflow_dispatch` input `track` deprecado
**Qué pasa:** el workflow `Deploy to Play Store` usa `r0adkll/upload-google-play@v1` con input `track`. Cada corrida muestra `WARNING!! 'track' is deprecated and will be removed in a future release. Please migrate to 'tracks'`.

**Fix pendiente:** cuando una versión mayor de la action lo imponga, migrar a array `tracks: [beta]`. No urgente.

### `npx wrangler` aborta con Node 20 — usar `wrangler@3` a mano
**Qué pasa:** publicar a Cloudflare Pages desde la máquina local falla con `Wrangler requires at least Node.js v22.0.0. You are using v20.20.2`. No es un warning: no sube nada.

**Por qué:** wrangler 4 subió el piso de Node a 22, y `npx wrangler` resuelve siempre a la última.

**Fix:** `npx wrangler@3 pages deploy ...` para corridas manuales, y `node-version: '22'` en el job de Actions que publique. Los jobs viejos del repo `desktop` usan Node 18, así que el job web no puede compartir esa configuración.

### Un dominio de Pages queda `initializing` si el CNAME no existe todavía
**Qué pasa:** asociar el dominio personalizado por API lo deja en `initializing` para siempre.

**Fix:** crear primero el CNAME `<sub> → <proyecto>.pages.dev` **proxeado** en la zona, y recién después asociar el dominio al proyecto. Pasa a `pending` y en unos minutos a `active`, con certificado emitido por **Google Trust Services** (no el Universal de la zona) — que es lo que hace viable un hostname de tres niveles tipo `alpha.desk.frcsuite.com` sin pagar Advanced Certificate Manager. Los cuatro dominios no se activan a la vez: verificado 2026-08-15, tres tardaron ~3 min y el cuarto ~8.

### Un workflow `workflow_dispatch` solo aparece si vive en la rama por defecto — y eso obliga al back-merge (2026-08-19)
**Qué pasa:** el workflow **Deploy Web** del repo `desktop` falla con `ref=develop` —que es su valor **por defecto**— en el paso "Sellar version en el build":

```bash
sed -i "s/version: '0.0.0'/version: '${SELLO}'/" src/environments/environment.web.prod.ts
```

`sed` sale con **exit 2**: no puede leer el archivo. Falla **antes** de tocar Cloudflare, así que no es problema de secrets — buscarlo ahí es perder la tarde.

**Por qué:** GitHub solo muestra el botón "Run workflow" si el archivo del workflow existe en la **rama por defecto** (`master`). Por eso la infra de deploy web se mergeó directo a master (PR #229, `ci/deploy-web → master`), y eso está bien: era necesario para poder dispararlo. Lo que se omitió fue el **back-merge obligatorio `master → develop`**. Junto con el workflow viajaron los **insumos de build** (`environment.web.prod.ts`, `webEndpoints.ts`), que quedaron solo en master; compilar `develop` sin ellos revienta.

**Regla:** si un workflow tiene que vivir en `master` para ser disparable, sus insumos de build tienen que existir en **todas** las ramas que ese workflow vaya a compilar. Después de cualquier merge a `master`, el PR `master → develop` no es opcional.

**Trampa asociada — una config puede apuntar a un archivo inexistente durante meses.** El `angular.json` de `desktop` referencia `environment.web.prod.ts` en la configuración `web-production` **desde la migración a Angular 15** (`52656f49`), pero el archivo recién se creó el 2026-08-18. O sea que `npm run web:build` estuvo roto en `develop` todo ese tiempo sin que nadie lo notara, simplemente porque nadie corría ese target. Un `fileReplacements` roto no falla hasta que alguien lo usa.

**Cómo verificarlo antes de mergear un back-merge así:** medir la divergencia (`git rev-list --count A..B` en los dos sentidos), listar los archivos tocados por ambos lados (`comm -12` de los dos `git diff --name-only` contra la base común) y hacer el merge de prueba en una rama descartable corriendo el build real. Si no hay solapamiento de archivos, el riesgo es semántico, no textual — y el build es lo único que lo descarta.

### Un back-merge por PR deja `master` como head, y "Update branch" publica a producción (2026-08-19)
**Qué pasa:** se abrió un PR de back-merge `master → develop` (head=`master`, base=`develop`), que es la forma natural de traer master hacia develop. Alguien usó el botón **"Update branch"** del PR y eso publicó un **release estable** que nunca pasó por `release/beta`.

**Por qué:** "Update branch" mergea la **base dentro del head**. En un PR normal (`feature → develop`) eso es rutina inofensiva. En un back-merge el head **es `master`**, así que la operación mergea `develop` dentro de `master` y **escribe directo en master** — sin PR, sin review, sin pasar por beta. El `Release` de master se dispara con el push y publica el canal estable.

**Cómo se reconoce en la historia:**
- commit con `committer: GitHub` (se generó del lado del servidor, no por un push local),
- mensaje `Merge branch 'develop' into master` (el merge de un PR diría `Merge pull request #N from ...`),
- un `CI (pull_request)` con `headBranch=master` segundos después: el PR se resincronizó porque su head recibió un commit,
- y el commit aparece asociado al PR de back-merge (`/commits/<sha>/pulls`).

**Cómo evitarlo:** no hacer el back-merge con `master` como head. Crear una rama intermedia desde master y abrir el PR desde ahí:

```bash
git checkout -b chore/backmerge-master-develop origin/master
gh pr create --base develop --head chore/backmerge-master-develop
```

El head es una rama descartable, y "Update branch" no puede tocar `master`.

**Lo que dejó al descubierto — la protección real no es la documentada.** Verificado el 2026-08-19 en `desktop`: `enforce_admins=false`, `required_approving_review_count=0`, sin restricción de push directo. La guía afirma `enforce_admins=true` en las tres ramas long-lived de los cuatro repos. Con `enforce_admins=true` esa escritura habría sido rechazada. **Pendiente de corregir y de verificar repo por repo en vez de confiar en la doc.**

**Daño colateral del episodio:** el estable quedó con un desktop que le pide al central operaciones que producción no tenía (`valesPendientes`, `pagarValesMixto`, `crearValeParaPago`, `desconfirmarTransferenciaItem`). Cliente y backend se promueven juntos o el cliente rompe funciones en producción.

## Mobile

### CapacitorUpdater line en `capacitor.config.ts` es código muerto
**Qué pasa:** hay `CapacitorUpdater: { autoUpdate: true }` en `capacitor.config.ts` y un bloque comentado en `main.ts`. Al leer, uno asume que hay OTA implementado.

**Realidad:** `@capgo/capacitor-updater` NO está en `package.json`. Play Store es el único canal. Ese config no hace nada.

**Acción:** ignorar. O borrar (PR chico) si molesta. CLAUDE.md del mobile ya dice esto explícito.

### Play Console solo permite UN track de Open testing por app
**Qué pasa:** al querer tener alpha y beta como "open" simultáneos (sin email list), Play Console solo deja uno.

**Fix:** alpha → Internal testing (email list de 100 max), beta → Open testing (público).

### `ng test` y `ng lint` rotos pre-existentes
**Qué pasa:** ambos comandos fallan aunque el PR sea correcto.
- `ng test`: `edit-transferenci-producto.component.spec.ts` tiene typo en el import.
- `ng lint`: `@angular-eslint/builder:lint not found`.

**Fix:** validar PRs mobile con `npm run build` y `npx cap sync android`. NO depender de `ng test` / `ng lint` como gate. Arreglarlos en un PR dedicado.

### Deploy a Play Store falla con `changesNotSentForReview` tras cambiar permisos
**Qué pasa:** el step *Upload to Play Store* (`r0adkll/upload-google-play@v1`) falla con `Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.` Empezó tras un release que tocó declaraciones (ej: remoción de `READ_MEDIA_IMAGES/AUDIO` en PR #52).

**Por qué:** cuando el edit de Play tiene declaraciones pendientes de revisión (permisos, data-safety), Google rechaza el auto-send-for-review de la action. No es bug del CI; es estado server-side disparado por el cambio de permisos. Antes funcionaba porque no había declaraciones pendientes.

**Fix (frc-mobile PR #57, 2026-06-17):** agregar `changesNotSentForReview: true` al step. La subida queda como **draft** en el edit; mandar a revisión desde Play Console UI **una sola vez** (en internal/beta ni siquiera lo pide — solo production tiene el gate de revisión). Subidas posteriores instantáneas.

### Compatibilidad 16KB: `useLegacyPackaging=false` NO alcanza, hay que bumpear deps
**Qué pasa:** Google Play exige compat 16KB page-size (Android 15 / API 35+, desde 31/10/2025). Se agrega `packagingOptions { jniLibs { useLegacyPackaging = false } }` y AGP 8.7+ asumiendo que alcanza. No alcanza.

**Por qué:** `useLegacyPackaging=false` solo alinea las `.so` **dentro del ZIP** del AAB. La alineación del **segmento ELF** (`p_align`) de cada `.so` prebuilt la traen las **versiones de las deps de Google**. Las que pinea capacitor-mlkit por default (camera 1.1.0, mlkit barcode 17.1.0) vienen con LOAD `align 2**12` (4KB) ❌.

**Verificación empírica** (sin readelf en macOS, usar objdump):
```bash
gh release download vX.Y.Z --repo GabFrank/frc-mobile --pattern "*.aab" --dir /tmp/x
unzip -o /tmp/x/*.aab 'base/lib/arm64-v8a/*.so' -d /tmp/x/ex
for so in /tmp/x/ex/base/lib/arm64-v8a/*.so; do
  objdump -p "$so" | grep LOAD | grep -oE '2\*\*[0-9]+' | sort -u
done   # OK = 2**14 (16384), MAL = 2**12 (4096). arm64-v8a es el ABI que importa.
```

**Fix (frc-mobile PR #58, 2026-06-17):** `configurations.all { resolutionStrategy { force ... } }` con camera **1.4.0** + mlkit barcode-scanning **17.3.0** + face-detection **16.1.7** (drop-in, mismo API). Sus `.so` vienen 16KB-aligned. Verificado `2**14` en el AAB resultante.

### Windows: `start /b` no sobrevive cierre de SSH
**Qué pasa:** se lanza un JAR con `start /b java -jar ...` via SSH remoto. Al cerrar la sesión SSH, el proceso Java muere.

**Por qué:** `start /b` crea un proceso hijo del shell SSH. Cuando SSH termina, el shell se cierra y mata al hijo.

**Fix:** usar PowerShell `Start-Process` con `-WindowStyle Hidden` que crea un proceso desacoplado. O usar Scheduled Task de Windows (como hace el CI/CD en producción).

### Filial 2 Windows — puerto 8082 queda ocupado al reboot
**Qué pasa:** el Scheduled Task `FRC-Filial-Server` intenta relanzar el jar al boot, pero el PID anterior (si Windows no lo mató limpio) sigue usando 8082 → nuevo PID falla con "Protocol handler start failed" → APPLICATION FAILED TO START en spring.log.

**Por qué:** el task no hace `kill` del PID viejo antes de lanzar. El servicio productivo sigue funcionando con el PID viejo — es cosmético.

**Fix opcional:** agregar `Stop-Process -Name java -Force` al inicio del script que lanza el jar. No hay urgencia.

## Dashboard / alertas

### API admin requiere auth de sesión
**Qué pasa:** `curl .../api/admin/...` devuelve `unauthorized`.

**Fix:** o pasar por UI con cookie (browser), o ir por SQL directo al `dash.db` con el hack de `postgres:16-alpine`.

### Editor de rules en UI no existe
**Qué pasa:** la UI de `/dashboard/notificaciones/rules` solo permite toggle + delete, no edit. Para cambiar el `alert_kinds_csv` hay que ir por SQL.

**Fix:** ver [dashboard-ops.md](dashboard-ops.md) para la receta sqlite.

## Replicación PostgreSQL

### El stream de replicación se corta pero ping y `select` pasan (camino ZeroTier)
**Qué pasa:** una sub de subida (filial→central) entra en un ciclo eterno: el apply worker arranca, vive 60s sin recibir **ni un keepalive**, muere con `ERROR: terminating logical replication worker due to timeout`, y reintenta a los 5 min. Visto 2026-08-15 en `filial_farmacia_1_sub`; la sucursal quedó ~1h sin replicar.

**Por qué engaña:** todo lo barato da OK y manda a buscar el problema donde no está.
- `ping` 0% loss, MTU 2800 OK.
- `psql` normal contra la filial responde, y un `select` que devuelve 20 MB viaja filial→central en 3,7s.
- `IDENTIFY_SYSTEM` con `replication=database` responde.
- `pg_recvlogical` con un **slot temporal nuevo** streamea perfecto.
- En la filial, `pg_stat_replication` muestra el walsender en `streaming` / `WalSenderWaitForWAL` con `sent_lsn` **adelante** de lo que central dice haber recibido.
- En central, el apply worker está `active`, sin `pg_blocking_pids`, esperando en `LogicalApplyMain`.

O sea: el publisher jura que manda, el subscriber no recibe nada, y ninguna prueba puntual reproduce el corte. Solo se ve mirando `received_lsn`/`last_msg_receipt_time` **congelados durante la ventana de 60s en que el worker vive**.

**Causa:** el camino ZeroTier de esa filial. La conninfo apunta a `172.25.3.X`, pero central **sale con IP origen `172.25.0.200`** (su segunda IP ZT en la misma interfaz, ver hosts.md) — verificable con `select client_addr from pg_stat_activity where backend_type='walsender'` **en la filial**. Ese camino de vuelta se corta para el stream sostenido, no para tráfico puntual.

**Fix (30 segundos, sin cortar nada):** mover la conninfo de la sub a la IP del tailnet. Sin reiniciar PG, sin tocar el slot, sin perder datos, reversible:
```sql
-- en central; \gexec evita imprimir el password en pantalla
select format('ALTER SUBSCRIPTION %I CONNECTION %L', subname,
              replace(subconninfo,'172.25.3.1','100.64.0.11'))
from pg_subscription where subname='filial_farmacia_1_sub' \gexec
```
Confirmado: worker estable >10 min con keepalives cada ~30s, contra 60-130s de vida antes.

**Antes de escalar a reiniciar bases:** el restart de la sub (`DISABLE`+`ENABLE`) **drena el backlog pero no cura** — vuelve a morir en 1-2 min. Sirve como paliativo, no como fix. Reiniciar PG de la filial es innecesario y corta el POS de la sucursal.

**Regla que deja:** ante `terminating logical replication worker due to timeout` con la filial viva y pingueable, sospechar del camino de red antes que de PG, y probar el tailnet primero. Las filiales sanas del mismo momento (4 y 6) ya replicaban por `100.64.*`.

### DROP DATABASE falla con replication slots activos
**Qué pasa:** `DROP DATABASE beta WITH (FORCE);` devuelve `ERROR: database "beta" is used by an active logical replication slot`. Ni siquiera `WITH (FORCE)` (PG 13+) puede contra slots activos.

**Por qué:** los walsenders de filiales remotas reconectan instantáneamente (~200ms). Si hacés `pg_terminate_backend` + `pg_drop_replication_slot` por separado, el slot se reactiva antes de poder dropearlo.

**Fix:** secuencia completa:
1. Parar servicios de las filiales que conectan a esa DB (verificar IPs con `SELECT client_addr FROM pg_stat_replication`).
2. En una sola sesión psql: `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE database = '<db>'; SELECT pg_sleep(1); SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE database = '<db>';`
3. Recién ahí `DROP DATABASE`.

Si las subs son locales (de la misma DB), primero: `ALTER SUBSCRIPTION <name> DISABLE; ALTER SUBSCRIPTION <name> SET (slot_name = NONE); DROP SUBSCRIPTION <name>;`.

### Schedulers de replicación OFF en todos los hosts farmacia
**Qué pasa:** `REPLICATION_SYNC_ENABLED=false` y `REPLICATION_REFRESH_ENABLED=false` en `.env` de central + 5 filiales. Decisión tomada por alto ruido de error logs.

**Por qué:** mismatch de naming `filial5_pub` (legacy) vs `farmacia_filial5_pub` (esperado por el código). El scheduler busca el pub con el nombre esperado, no lo encuentra, genera logs de error cada 5s.

**Fix durable pendiente:** ejecutar `setupFullReplication(sucursalId=N)` vía GraphQL por filial — normaliza el naming. Hasta entonces, schedulers siguen OFF.

### `evento_inutilizacion_de` es tabla central-only
**Qué pasa:** filiales (especialmente filial 5 que es la única con IP configurada en `empresarial.sucursal`) intentaban replicar esta tabla y fallaban.

**Fix:** migración `V118__remove_inutilizacion_from_central_pub.sql` en central saca esa tabla del publication `central_pub`. Ya mergeada en master + liberada en v4.1.0-beta.3.

### Migración V111.2 (central) requiere que `central_pub` exista
**Qué pasa:** Flyway falla con `ERROR: publication "central_pub" does not exist` al aplicar `V111.2__disable_truncate_replication.sql`.

**Por qué:** la migración hace `ALTER PUBLICATION central_pub SET (publish = 'insert, update, delete')`. Si la DB fue restaurada con `--no-publications` (e.g. para dry-run o staging), la publicación no existe.

**Impacto en producción:** NINGUNO — en DBs productivas `central_pub` siempre existe. Solo afecta clones sin publicaciones.

**Fix para staging/dry-run:** `CREATE PUBLICATION central_pub;` antes de arrancar el JAR. Flyway repair limpia el registro fallido automáticamente.

### SIFEN no se puede desactivar vía env var
**Qué pasa:** poner `SIFEN_ENABLED=false` rompe el arranque con `NoSuchBeanDefinitionException: No qualifying bean of type 'SifenService'`.

**Por qué:** `ClienteService` tiene dependencia hard (`@Autowired`) a `SifenService`. Si el bean no se crea, toda la cadena GraphQL falla.

**Fix:** mantener `SIFEN_ENABLED=true` siempre. Para desactivar la actividad SIFEN, usar `SIFEN_SCHEDULER_ENABLED=false` (el bean se crea pero no ejecuta jobs). Los paths de certificado deben ser válidos o al menos no causar error en startup — validar caso por caso.

### Health DOWN en central = AMQP legacy
**Qué pasa:** `curl localhost:808x/actuator/health` devuelve `{"status":"DOWN"}` aunque el servidor funciona bien.

**Por qué:** Spring Boot health indicator de RabbitMQ/AMQP marca DOWN porque no hay broker conectado. Es código legacy que será removido.

**Fix:** ignorar. No bloquea operación. Tener en cuenta en scripts de healthcheck que `DOWN ≠ server caído` en central.

### Sucursal_id=24 hardcoded en application.properties del JAR
**Qué pasa:** el JAR filial legacy tiene `sucursalId=24` hardcoded en su application.properties embebido. Si el `.env` externo no override con case exacto, el server usa 24 → FK violations masivas.

**Fix:** overlay `application.properties` en el working directory del service (precedencia mayor que el classpath del JAR). Ver [runbooks/application-properties-overlay.md](runbooks/application-properties-overlay.md).

### `SPRING_FLYWAY_MIXED=true` necesario en JARs 4.x en DBs sin V0
**Qué pasa:** central con JAR 4.x arrancando contra una DB con flyway baseline en V1 falla con `FlywayException: Detected both transactional and non-transactional statements within the same migration` parseando `V0__initial_schema.sql`.

**Por qué:** V0 del JAR 4.x mezcla DDL transaccional con `CREATE SUBSCRIPTION` (non-txn). Flyway parsea todos los archivos aunque no los aplique; la validación de "mixed" falla antes de decidir skip por baseline.

**Fix:** agregar `SPRING_FLYWAY_MIXED=true` al `.env` del pool. Mapea a `spring.flyway.mixed=true` por binding relajado de Spring Boot.

### `max_wal_senders` / `max_logical_replication_workers` defaults chicos
**Qué pasa:** crear 18 bridge subscriptions en un cluster PG vanilla → logs muestran `out of logical replication worker slots` y `number of requested standby connections exceeds max_wal_senders (currently 10)`.

**Por qué:** defaults PG 16 son `max_wal_senders=10`, `max_logical_replication_workers=4`, `max_worker_processes=8`, `max_replication_slots=10`. Insuficiente cuando hay 17+ filiales cada una con 2 subs (hacia/desde central).

**Fix:** `ALTER SYSTEM SET max_wal_senders=50; max_logical_replication_workers=25; max_worker_processes=30; max_replication_slots=50;` + restart del cluster PG (son params que requieren restart, no reload).

### Unit `frc.service` en filiales bodega con contenido corrupto ("franco")
**Qué pasa:** `systemctl status frc.service` reporta `Loaded: bad-setting`. `systemctl cat` muestra solo la palabra `franco`.

**Por qué:** en algún momento alguien ejecutó `echo 'franco' | sudo -S <cmd> > /etc/systemd/system/frc.service` y la redirección escribió el password al file en vez del output esperado. Afecta a varias filiales bodega (detectado en .24, .23, .22 y más). El service seguía corriendo desde unit cargada en memoria pre-corrupción, pero restart falla.

**Fix:** reemplazar con unit correcto (ver `/tmp/frc-filial.service` usado en migración bodega). `daemon-reload` + `systemctl restart frc.service`.

### check-update.sh cron vs ownership root
**Qué pasa:** cron del user `franco` (cada 15 min) falla con `Permiso denegado` al crear `/opt/frc-filial/releases/X.Y.Z/` porque el directorio `releases/` quedó owned `root`.

**Por qué:** primera ejecución manual vía `sudo /opt/frc-filial/check-update.sh` creó subdirs como root. Luego cron corre como franco y no puede escribir.

**Fix:** `sudo chown -R franco:franco /opt/frc-filial/releases/` post-primera ejecución manual, o ejecutar check-update.sh siempre como franco.

### check-update `SERVICE_NAME` debe ser `frc.service` (no `frc-filial.service`)
**Qué pasa:** filial Linux descarga el jar nuevo y avanza el marker, pero queda corriendo la versión vieja. Log: `Restarting frc.service... sudo: a password is required`.

**Por qué:** el unit systemd se llama `frc.service` en TODA la flota (farmacia + bodega) y el NOPASSWD sudoers es para `frc.service`. El script con `SERVICE_NAME="frc-filial.service"` no matchea ningún NOPASSWD → pide password → falla bajo cron. **`apply-script-update.sh` sobreescribió la customización local `frc.service` de bodega con el default roto del repo** (la "trampa" documentada del scp del archivo entero).

**Fix:** `SERVICE_NAME="frc.service"` en `scripts/check-update.sh` (frc-cicd PR #2, 2026-06-11). Verificar siempre que el on-disk de cada filial coincida con el unit real (`systemctl list-units | grep frc`).

### check-update Windows: drift por kill que no mata + health falso positivo
**Qué pasa:** filial Windows con marker nuevo pero proceso viejo corriendo por días. Task `FRC-Filial-Server` con `LastRunTime` viejo.

**Por qué:** el script viejo mataba por `Get-Process.CommandLine` (null en Windows) → no mataba nada → puerto 8082 ocupado → el jar nuevo moría al bindear → el viejo respondía el health check 200 (falso éxito) → marker avanzaba igual.

**Fix (frc-cicd PR #2):** matar por dueño del puerto, relanzar vía `Start-ScheduledTask` (no `Start-Process`), y verificar `/api/version` == objetivo antes de declarar éxito. Detalle y los 4 modos de falla: [runbooks/stuck-filial-diagnosis.md](runbooks/stuck-filial-diagnosis.md).

### `.github-token` de filial puede expirar → 401 → pegada sin avanzar
**Qué pasa:** filial no actualiza, log repite `Failed to query GitHub API: (401) No autorizado`. marker==running, viejos.

**Por qué:** token expirado/revocado. check-update corre pero corta en la query a GitHub. Distinto del drift (acá el marker NO avanza). Visto en bodega-4 (2026-06-11).

**Fix:** reemplazar `.github-token` con `GITHUB_PAT` válido del `.env` (validar con `curl -w %{http_code}` → 200 antes de escribir; escribir vía temp+scp sin imprimir el valor).

### Central `/api/version` devuelve `@project.version@` (placeholder sin filtrar)
**Qué pasa:** `curl http://172.25.1.200:808X/api/version` en central devuelve `{"version":"@project.version@"}` en vez de la versión real. El de **filial sí funciona**.

**Por qué:** el resource filtering de Maven no sustituye `@project.version@` en `application.properties` de central. Para confirmar versión de central usar el log del workflow Deploy (`VERSION:` / `INSTANCE:`) o el tag de master, no el endpoint. **El dashboard que se nutre de ese endpoint muestra versión basura para central.** Pendiente arreglar filtering. Detectado 2026-06-11.

### electron-updater `quitAndInstall` falla si el AppImage fue borrado del disco
**Qué pasa:** el usuario acepta "Cerrar y actualizar" pero la app muestra error `ENOENT: no such file or directory, unlink '/home/franco/FRC/FRC.AppImage'` y no actualiza. La app sigue corriendo desde el mount temporal en `/tmp/.mount_FRC.Ap...`.

**Por qué:** alguien (o un update fallido previo) borró/renombró el archivo `FRC.AppImage` del disco. El proceso Electron se ejecuta desde una copia montada en `/tmp` así que no nota la ausencia hasta intentar el swap.

**Agravante:** si la app se abre múltiples veces sin cerrar la anterior, quedan N procesos en paralelo, cada uno descargando el update. Esto causa race conditions (`ENOENT: chmod temp-FRC.AppImage`) y acumulación de procesos zombie.

**Fix (procedimiento refinado 2026-06-11, validado en bodega-1 y bodega-5):**

⚠️ **Orden importa** y hay 3 trampas que cuestan tiempo:

1. **Matar con `pkill -x`, NO `-f`.** `pkill -9 -f "FRC.AppImage"` **se mata a sí mismo** (el string está en el cmdline del propio script SSH) → el comando muere a la mitad sin matar la app. Usar nombre exacto:
   ```bash
   pkill -9 -x FRC.AppImage    # el launcher (comm = "FRC.AppImage")
   pkill -9 -x frc             # los procesos hijo electron (comm = "frc")
   sleep 3; pgrep -xc frc      # confirmar 0
   ```
2. **Una instancia zombie BORRA `~/FRC/FRC.AppImage` al morir** (intento de swap fallido). Por eso: **matar TODO primero, DESPUÉS restaurar el AppImage, recién relanzar.** Si restaurás antes de matar, el zombie lo borra de nuevo.
3. **Restaurar el AppImage 3.5.x** — el pending cache suele estar vacío. Fuente confiable: `~/FRC/FRC.AppImage` de una filial sana (≈158MB, `scp` host→local→host), o el asset del GitHub Release. Luego `chmod +x ~/FRC/FRC.AppImage`.
4. **Relanzar UNA instancia — necesita `XAUTHORITY`** (no alcanza `DISPLAY`). Sesión es X11/Plasma, `DISPLAY=:0`:
   ```bash
   export DISPLAY=:0 XAUTHORITY=/home/franco/.Xauthority XDG_RUNTIME_DIR=/run/user/$(id -u)
   setsid nohup ~/FRC/FRC.AppImage --no-sandbox >/tmp/frc-relaunch.log 2>&1 </dev/null &
   ```
5. **Verificar:** `main.log` (`~/.config/FRC/logs/main.log`) debe mostrar `=== FRC vX.Y.Z started ===` + `Update for version X.Y.Z is not available` (= corriendo la última). Una sola instancia: `pgrep -xc FRC.AppImage` = 1, un solo mount `/tmp/.mount_FRC.*`.

**Cómo saber la versión desktop corriendo** (no hay endpoint como el backend):
- Linux: `main.log` → `Update for version X is not available` (= está en X) vs `Found version X ... downloaded` (= bajando, aún no en X). El asar tiene versiones de deps (ruido), no sirve.
- Windows: `Get-Process FRC | %{$_.MainModule.FileVersionInfo.ProductVersion}`. **Ojo bodega-4:** el app real corre bajo la cuenta `User` en `C:\Users\User\AppData\Local\Programs\FRC\FRC.exe`; la install `C:\Program Files\FRC` es **legacy muerta** (su `main.log` tira errores de updater que NO reflejan el app real). Leer el log correcto.

Si tras restaurar el AppImage el log dice `auto-update disabled` → ver gotcha `updateChannel faltante` abajo (le faltaba `updateChannel` en `config-backup.json`; pasó en bodega-5).

Detectado en bodega filiales 5 y 6 (2026-05-05); rescate masivo refinado en bodega-1/5 al promover desktop v3.5.0 (2026-06-11).

### `updateChannel` faltante o incorrecto desactiva el auto-updater
**Qué pasa:** la app arranca con `Update channel not configured or set to dev, auto-update disabled` y nunca chequea actualizaciones.

**Por qué:** `config-backup.json` no tiene `updateChannel`, o tiene un valor incorrecto (`latest`, `dev`). Los valores válidos son `stable` (bodega), `beta` (farmacia), `alpha` (test).

**Fix:** editar `/home/franco/.config/FRC/config/config-backup.json` y agregar `"updateChannel": "stable"` (o `"beta"` según red). Reiniciar la app.

Detectado en bodega filial 5 (2026-05-05): config migrado sin campo `updateChannel`.

### DEBUG logging dejado en `.env` de producción
**Qué pasa:** el servidor central genera miles de líneas DEBUG por segundo (Spring Security filter chain, GraphQL, etc.), llenando journald y ralentizando diagnóstico.

**Por qué:** alguien agregó `LOGGING_LEVEL_*=DEBUG` en el `.env` del pool (probablemente durante troubleshooting) y no lo removió.

**Fix:** revisar el `.env` de cada instancia (`/opt/frc-backend-central/<pool>/.env`) y eliminar líneas `LOGGING_LEVEL_*=DEBUG`. Reiniciar servicio. Detectado en bodega (2026-05-05): 4 líneas DEBUG para graphql, kickstart, web, security.

**Prevención:** al agregar DEBUG temporalmente, dejar un comentario con fecha y motivo. Mejor aún: usar `-Dlogging.level.X=DEBUG` en un override temporal en vez de tocar el `.env`.

### Desktop Windows puede tener múltiples instalaciones bajo distintos users
**Qué pasa:** al buscar logs del desktop en una filial Windows, se encuentran logs viejos con errores graves (ej: `No published versions on GitHub`, versión `3.0.7-1`) que no reflejan el estado real.

**Por qué:** hay una instalación legacy en `C:\Program Files\FRC\` (user `franco`) y la actual en `C:\Users\<User>\AppData\Local\Programs\FRC\` (otro user). Los logs de cada user están en `C:\Users\<user>\AppData\Roaming\FRC\logs\main.log`. Si se lee el log del user equivocado, se diagnostica mal.

**Fix:** siempre verificar primero bajo qué user corre el proceso con `Get-Process FRC | Select-Object -First 1 Path`, y leer los logs de ese user. Detectado en bodega filial 4 (172.25.1.4): app real bajo `User`, log engañoso bajo `franco`.

### Windows CI/CD usa `C:\frc-filial\` (NO `C:\opt\frc-filial\`)
**Qué pasa:** scan de filial Windows reporta `C:\opt\frc-filial vacío` aunque el pool esté instalado.

**Por qué:** en Windows no hay convención `/opt/`. El runbook Windows y los scripts (`prepare-filial4-bodega.ps1`) usan `C:\frc-filial\`. El scan script tenía hardcoded la ruta de Linux.

**Fix:** aplicado en commit `3b5dd7e` a `scan-filial-windows.ps1`. Verificar que cualquier script nuevo use `C:\frc-filial\`.

### `check-update.ps1` Windows no filtra comentarios de `.env`
**Qué pasa:** Windows filial arranca con error `no se ha encontrado la clase principal FRC` o similar, Java no encuentra main class.

**Por qué:** `check-update.ps1` parsea `.env` con regex `^([^=]+)=(.*)$`. Una línea como `# === FRC Filial Bodega ===` matchea: `key = "# "`, `value = "== FRC Filial Bodega ==="`. Se convierte en `-D# =value con espacios` y rompe el arg parsing de Java.

**Fix:** nunca usar comentarios con `=` en el `.env` de Windows. Patchear el script para saltear líneas que empiezan con `#` (pendiente). Mismo riesgo con trailing backslash en values (ej `BACKUP_LOCAL_PATH=C:\frc-filial\backup\postgres\`) → escapa la comilla del -jar. Usar forward slash `C:/frc-filial/...`.

### `setupReplication` destruye el bridge en Paso 0
**Qué pasa:** ejecutar `setupReplication(sucursalId=N)` durante una ventana con bridge sub activa → Paso 0 dropea sub/pub/slot de esa filial. Si Paso 7 falla, el rollback deja la filial SIN replicación; data acumulada en el slot viejo se pierde.

**Por qué:** la mutation está diseñada para "setup desde cero o recrear", no para "migrar suavemente". La limpieza es agresiva.

**Fix:** antes de llamar, stopear `frc.service` en la filial para bloquear writes durante la ventana (~30s). Si falla, recrear bridge manualmente con `pg_create_logical_replication_slot` + `CREATE SUBSCRIPTION ... create_slot=false, slot_name=<manual>`. Ver data loss filial 24 en migración bodega 2026-04-23.

### `session_replication_role = replica` NO evita el rebote en réplica lógica nativa
**Qué pasa:** al backfillear una tabla que la filial también publica (bidireccional), uno quiere que el INSERT no reboste a central. La creencia intuitiva (y lo que decía una versión vieja de `replication.md`) es usar `SET session_replication_role = replica` antes del INSERT.

**Por qué falla:** `session_replication_role=replica` desactiva **triggers y reglas** — es el mecanismo anti-loop de replicación *basada en triggers* (Slony/Bucardo). La réplica lógica nativa de PostgreSQL decodifica el WAL con el walsender, que ignora ese rol; los INSERT igual se capturan y publican.

**Fix correcto:** marcar la sesión con un **replication origin** — `SELECT pg_replication_origin_session_setup('backfill_x')` dentro de la transacción del backfill. Funciona **solo si la subscription del otro lado tiene `origin = none`** (así filtra cambios con origin marcado). Verificar `suborigin` en `pg_subscription` del nodo destino ANTES. En bodega/farmacia todas las subs son `origin=none`, así que el truco aplica en ambas direcciones. Requiere superuser (franco lo es). Validado 2026-07-20/23 en el fix de `movimiento_stock` bodega + Frente A.

### Backfill por anti-join de PK, NUNCA por ventana de tiempo
**Qué pasa:** al medir/backfillear un hueco, tentador filtrar por `creado_en > corte`. Deja afuera filas fuera de esa ventana (residuo viejo de setups anteriores: p.ej. filial 24 bodega tenía 28 TRANSFERENCIA del 2025-10-30 además del hueco de abril).

**Por qué:** `creado_en` es hora de aplicación, no de commit; y hay islas de datos viejos que nada tiene que ver con la ventana. Además el reloj de una filial puede estar desfasado (farmacia suc 1: 587 ventas de junio fechadas en julio-futuro).

**Fix:** comparar por la **PK real** con `NOT EXISTS` (anti-join). Traer solo los `id` (liviano) en un primer paso, después las filas completas de esos `id`. Exacto por construcción, sin depender de fechas.

### La PK de las tablas transaccionales es COMPUESTA `(id, sucursal_id)`
**Qué pasa:** joinear/deduplicar por `id` solo da resultados basura. En farmacia hay 69.731 ids duplicados entre sucursales.

**Por qué:** cada sucursal reusa el mismo espacio de ids; la unicidad la garantiza la PK compuesta `(id, sucursal_id)`, no `id` ni la paridad. (La convención central-impar/filial-par existe pero la implementa **cada entidad a mano** en su `save()` vía `findMaxId(sucursalId)`; `inicio_sesion` NO la sigue → colisiones, ver issue filial #77.)

**Fix:** todo anti-join, dedup y `ON CONFLICT` va por `(id, sucursal_id)`. Verificar la PK real con `pg_constraint`/`conkey`, no asumirla.

### El screening por `count(*)` SUBESTIMA los huecos — usar anti-join por PK
**Qué pasa:** comparar `count(*)` filial vs central por tabla para dimensionar un hueco de replicación reporta menos de lo real. En el Frente A bodega, el triage por conteos dijo ~1.757 filas; el anti-join por PK encontró **3.185** (45% más). Filial 6 tenía 1.295 `factura_legal_item` invisibles al conteo; filiales 14/18/22 daban "0" y tenían huecos.

**Por qué:** los conteos coinciden por casualidad, o faltan filas en ambas direcciones a la vez y se compensan. El conteo miente.

**Fix:** el conteo sirve solo como orientación previa barata. La decisión y la carga van por anti-join de PK. Y verificar SIEMPRE `pg_subscription_rel.srsubstate = 'r'` explícitamente además del conteo — una tabla puede estar en la publication y NO en la subscription (ver gotcha del REFRESH abajo).

### `ALTER PUBLICATION ADD TABLE` + `REFRESH` por dblink en sesiones distintas = REFRESH no-op
**Qué pasa:** script que hace `ALTER PUBLICATION ... ADD TABLE` dentro de un bloque `DO` (transacción abierta) y luego el `REFRESH PUBLICATION` sale por `dblink_exec` (otra sesión). El refresh lee la publicación **vieja**, sin la tabla → la subscription queda SIN la tabla aunque la publication SÍ la tenga. El backfill histórico funciona (dblink directo), pero la replicación en vivo no fluye → el hueco se reabre desde ese momento, en silencio.

**Por qué:** el `ALTER PUBLICATION` no commiteado no lo ve la sesión externa del `dblink_exec`.

**Fix:** hacer el `ALTER PUBLICATION` en **autocommit** (sentencia suelta), que commitee ANTES de que salga el REFRESH. Detectado 2026-07-20: 14 filiales bodega quedaron con `movimiento_stock` en la pub pero no en la sub; se corrigió re-ejecutando el REFRESH. Verificar con `pg_subscription_rel.srsubstate`, no con el conteo de filas.

### Naming de subs INVERTIDO entre bodega y farmacia; `dblink` en schema `general` en filiales
**Qué pasa:** un script genérico que asume el nombre de la sub filial→central falla en el otro entorno.
- **Bodega:** la sub de subida de la filial se llama `bodega_filialN_central_sub` (termina en `_central_sub`).
- **Farmacia:** se llama `central_farmacia_N_sub` (empieza con `central`). Un `LIKE '%_central_sub'` NO la matchea → devuelve NULL → el loop no inserta nada y `dblink_exec` reporta `DO` sin error.

**Fix:** no adivinar el nombre; identificar la conexión a central por su host (`subconninfo LIKE '%host=172.25.1.200%'`).

**Además:** en las filiales la extensión `dblink` vive en el schema **`general`** (no en `public` ni en el search_path). Dentro de un bloque que corre en la filial hay que calificar `general.dblink(...)`. En central es `dblink(...)` a secas. Verificado 2026-07-23 en el fix de bajada de farmacia.

### Subs de filiales apagadas quedan `subenabled=true` y cuelgan los loops
**Qué pasa:** un loop que recorre `pg_subscription` y hace dblink a cada filial se cuelga en las apagadas (farmacia 5 y 6 al 2026-07): la sub sigue `enabled`, el dblink se come el `connect_timeout` y agota el `statement_timeout` de toda la corrida.

**Fix:** filtrar las filiales caídas por adelantado en el `WHERE` del loop (`subname !~ 'farmacia_[56]_sub'`), y usar `connect_timeout` corto (8s). No descubrirlas por timeout.

### `venta_item` con `presentacion_id` fantasma (integridad rota en central)
**Qué pasa:** al bajar `venta_item` a una filial, la FK a `productos.presentacion` falla porque el `presentacion_id` no existe **ni en central ni en la filial** (farmacia suc 1, presentación 5191: central tiene 3 venta_item apuntándola, la presentación no existe en ningún nodo). No es "falta bajar un padre de catálogo" — es un dato corrupto en el origen (venta con ítem que referencia catálogo inexistente; la FK de central lo permitió antes de existir, o se borró la presentación sin cascada).

**Fix operativo:** excluir del backfill las `venta_item` cuyo `presentacion_id` no exista en central (`... OR EXISTS (SELECT 1 FROM productos.presentacion p WHERE p.id=vi.presentacion_id)`), cargar el resto, reportar las corruptas aparte. No forzar una presentación falsa.

# Headscale / Tailscale — VPN mesh de FRC

VPN propia del ecosistema FRC. **No es Tailscale SaaS**: es [headscale](https://github.com/juanfont/headscale), el control server open-source, self-hosted en la VM Hetzner. Los clientes sí son el `tailscale` oficial, apuntados a nuestro control server con `--login-server`.

## 🎯 Dirección: headscale es LA VPN, ZeroTier se retira

**Decisión vigente (2026-08-11):** **ZeroTier se está removiendo del ecosistema FRC.** Headscale es la forma de conectarnos de acá en adelante — para toda máquina nueva y para todas las existentes a medida que se migren.

Consecuencias prácticas:

- **Máquina nueva (filial, PC, servidor) → se enrola en headscale, no en ZeroTier.** Sin excepciones ni "por ahora que sea zt".
- **Cada PC filial lleva su propio cliente tailscale**, enrolado nativo contra `hs.farmaciafrancopy.com`. No se accede a las filiales por un puente.
- **El bridge por `frc-mauro-subnet` se retira.** Es andamio de la migración, no arquitectura. Ver "Retiro del bridge" abajo.
- ZeroTier sigue vivo mientras queden hosts sin migrar. No apagarlo hasta que la última filial esté en el tailnet y verificada — pero **no agregar nada nuevo ahí**.
- Cuando encuentres documentación o scripts que asumen ZeroTier como la red, tratalos como legacy y anotalo.

---

## Dónde está y cómo entro

| Qué | Valor |
|---|---|
| Host | VM Hetzner `178.105.107.171` (hostname `FRC`, Fedora 42) — ver [hosts.md](../hosts.md) |
| Acceso | `ssh deploy@178.105.107.171` (key-based, sin password) |
| Modo de ejecución | **nativo por systemd** (`systemctl status headscale`). **NO docker** |
| Versión | v0.28.0 (verificado 2026-08-11; avisa que hay 0.29.0-beta disponible) |
| Binario | `headscale` en PATH → comandos van `sudo headscale ...` |
| Config | `/etc/headscale/config.yaml` |
| ACL | `/etc/headscale/policy.json` |
| DB | SQLite |
| `server_url` | `https://hs.farmaciafrancopy.com` (nginx termina TLS → `127.0.0.1:8080`) |
| Métricas / gRPC | `127.0.0.1:9090` / `127.0.0.1:50443` |
| MagicDNS | **on**, `base_domain: hs.farmacia` → los nodos resuelven por nombre (`central.hs.farmacia`) |
| Rango tailnet | `100.64.0.0/10` (IPv4) + `fd7a:115c:a1e0::/48` (IPv6) |

> **Nunca `docker exec headscale ...`.** Ese comando circula en pedidos de otros devs y no aplica acá. Siempre `sudo headscale` directo.

### Users de headscale

Un "user" en headscale es el dueño de un nodo, y es lo que la ACL usa para agrupar.

| ID | Username | Uso |
|---|---|---|
| 1 | `encargados` | otro proyecto (NVRs), acotado por ACL |
| 2 | `sim_gateways` | otro proyecto, acotado por ACL |
| 3 | `agentes` | otro proyecto, acotado por ACL |
| **4** | **`admin`** | infra FRC: la VM, `central`, PCs de administración. Malla completa (`*:*`) |
| **5** | **`filiales`** | **servidor de sucursal.** Acotado vía `tag:filial` (creado 2026-08-11) |
| **6** | **`clientes`** | **PC que solo corre el desktop** (caja, puesto). Acotado vía `tag:cliente` (creado 2026-08-11) |

**Sintaxis real de v0.28** — cambió respecto de versiones anteriores, verificar con `--help` antes de asumir:

| Acción | Comando |
|---|---|
| Crear key | `headscale preauthkeys create -u <user-id> [--tags tag:filial] [-e 1h] [--reusable] [--ephemeral]` |
| Listar keys | `headscale preauthkeys list` — **no acepta `--user`**, lista todas |
| Expirar key | `headscale preauthkeys expire -i <authkey-id>` — por **ID numérico de la key**, no por el string |
| Taggear nodo ya enrolado | `headscale nodes tag -i <node-id> -t tag:filial` |
| Nodos / rutas | `headscale nodes list` · `headscale nodes list-routes` |

Los comandos toman el **ID numérico** del user, no el nombre (`-u 5`).

---

## ⚠️ Seguridad — leer antes de enrolar nada

`/etc/headscale/policy.json` tiene `group:admin → dst ["*:*"]` = **malla completa sin restricción de puerto**. El propio archivo se documenta como "permisivas para el bootstrap".

**Consecuencia:** un nodo enrolado con `-u 4` (admin) y **sin tag** obtiene acceso a **toda la flota** — central producción, filial producción `172.25.3.4`, y todos los clusters PostgreSQL. Una preauth key filtrada = acceso total.

### Elegir la categoría del nodo — decisión obligatoria antes de crear la key

**Todo nodo cae en una de tres.** El default (`-u 4`, sin tag) es el más peligroso, así que no se elige por descarte:

| Qué es la máquina | Key | Alcance que obtiene |
|---|---|---|
| **Servidor de sucursal** (corre el backend filial) | `-u 5 --tags tag:filial` | central en app + PG de replicación. No ve otras filiales |
| **PC que solo corre el desktop** (caja, puesto operativo) | `-u 6 --tags tag:cliente` | app de central (8081/8082/8083) + app de su filial (8080/8082). **Sin PG, sin SSH**, no ve otros clientes |
| **Infra / administración** (la VM, `central`, tu PC de trabajo) | `-u 4` sin tag | **malla completa** |

Regla práctica: si la máquina no necesita administrar la flota, **no va en `admin`**. Una caja comprometida con `tag:cliente` llega al puerto de la app y nada más; la misma caja en `admin` llega a los PostgreSQL de producción.

Reglas vigentes desde 2026-08-11:

```jsonc
// Filial → infra: app central (8081 stable / 8082 beta / 8083 alpha)
// + clusters PG de replicacion (5551/5552/5553). Nada mas.
{ "action": "accept", "src": ["tag:filial"],
  "dst": ["group:admin:8081,8082,8083,5551,5552,5553"] },

// Infra → filial: dashboard (health checks), ssh, PG. La filial es destino, no par.
{ "action": "accept", "src": ["group:admin"], "dst": ["tag:filial:*"] },

// Cliente → app de central (8081 stable / 8082 beta / 8083 alpha)
{ "action": "accept", "src": ["tag:cliente"], "dst": ["group:admin:8081,8082,8083"] },

// Cliente → servidor de su filial (8082; 8080 en la filial de prueba)
{ "action": "accept", "src": ["tag:cliente"], "dst": ["tag:filial:8080,8082"] }

// Filial ↔ filial, cliente ↔ cliente: sin regla = denegado por default. Es deliberado.
// Infra → cliente: ya cubierto por la regla "admin → *:*".
```

Los puertos del cliente salen de `desktop/src/environments/conectionConfig.ts` (`port = 8082` filial, `centralPort = 8081`). Si el desktop cambia de puerto, esta regla se actualiza con él.

**Por qué `group:admin` como destino y no `tag:central`:** un nodo taggeado **pierde la identidad de su user** para efectos de ACL. Taggear `central` lo sacaría de `group:admin` como *origen* y le cortaría el acceso que hoy tiene a todo. Por eso la infra (VM, central, PCs) queda **sin tag** y solo se taggean las filiales.

Antes de enrolar una máquina de terceros / de desarrollo / un runner de CI: mismo criterio — user propio + regla acotada, nunca `-u 4` pelado.

**Backup previo obligatorio antes de editar la ACL** (el archivo lo comparte otro proyecto — NVRs, sim_gateways):
```bash
sudo cp -a /etc/headscale/policy.json /etc/headscale/policy.json.bak-$(date +%Y%m%d)
sudo systemctl reload-or-restart headscale
journalctl -u headscale --since "5 min ago" | grep -iE "error|policy"   # vacío = policy cargó
headscale nodes list                                                    # los nodos siguen ahí
```
Con `policy.mode: file`, una policy inválida **impide que headscale arranque**. Verificar siempre después de reload.

---

## Agregar un nodo

### 1. Crear preauth key (en la VM)

**Servidor de sucursal** — user `filiales` + tag, single-use, **sin** `--ephemeral`:
```bash
sudo headscale preauthkeys create -u 5 --tags tag:filial -e 1h
```

**PC cliente** (caja / puesto que solo corre el desktop):
```bash
sudo headscale preauthkeys create -u 6 --tags tag:cliente -e 1h
```

**Host de infra / administración** — sin tag, queda en la malla admin:
```bash
sudo headscale preauthkeys create -u 4 -e 1h
```

**Runner de CI / container descartable** — acá sí corresponde efímero + reusable:
```bash
sudo headscale preauthkeys create -u 4 --reusable --ephemeral -e 720h
```

Listar / expirar keys:
```bash
sudo headscale preauthkeys list                 # todas; no acepta --user
sudo headscale preauthkeys expire -i <id>       # por ID numérico de la key
```

### Estrategia de keys — ¿fija o una por máquina?

**No existe key sin vencimiento.** La expiración es obligatoria (default `1h`); el valor lo elegís (`-e 2160h` = 90 días, `-e 8760h` = 1 año). Lo más cercano a "fija" es `--reusable` con expiración larga.

**La key solo sirve para el registro inicial.** Enrolada la máquina, no la vuelve a usar. Y en este tailnet **ningún nodo expira** (`expira=NUNCA` en todos) → no hay re-auth periódica. El problema de la key es el onboarding, no la operación.

| Caso | Key |
|---|---|
| Filial / servidor (vas a la máquina igual) | single-use, `-e 1h` |
| Cajas o clientes en volumen, instalación manual | `--reusable --tags tag:cliente`, 30-90 días, rotada |
| App que se auto-enrola | emisión por API desde central, single-use por máquina |

**Trade-off de `--reusable`:** no se puede cortar una máquina sin afectar a las demás. Expirar la key **no desenrola** a las ya registradas (correcto), pero bloquea altas futuras hasta emitir otra. Filtrada = cualquiera entra con ese tag hasta que venza.

**Emisión automatizada (API):**
```bash
sudo headscale apikeys create -e 90d        # token para el que llama; guardar en central, NUNCA en el cliente
# luego: POST /api/v1/preauthkey  con Authorization: Bearer <apikey>
```
Es la pieza que habilita que la app pida su propia key tras el login del ERP, sin distribuir secretos a las PCs.

### 2. Enrolar el cliente (en la máquina nueva)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up \
  --login-server https://hs.farmaciafrancopy.com \
  --authkey <PREAUTH_KEY> \
  --hostname <nombre-descriptivo> \
  --accept-dns=true           # desde 2026-08-11: seguro, hay split DNS. Ver gotcha
sudo tailscale status
```

**Convención de nombres** — el nombre es la identidad canónica, las IPs `100.64.x` son opacas (headscale no permite asignarlas y cambian si el nodo se re-enrola):

| Tipo | Patrón | Ejemplo |
|---|---|---|
| Servidor de sucursal | `<empresa>-filial-<n>` (`n` = número de filial, **no** `sucursal_id`) | `farmacia-filial-1` |
| PC cliente | `cliente-<empresa>-suc<n>-<puesto>` | `cliente-farmacia-suc3-caja1` |
| Infra / administración | rol, o `pc-<persona>` para PCs de admin | `central`, `frc-cicd-vm` |

Renombrar no interrumpe nada (`headscale nodes rename NEW_NAME -i <id>`), y es lo que permite que una máquina reinstalada recupere su identidad sin tocar ninguna conninfo.

Flags según el rol del nodo:

| Rol | Flag extra |
|---|---|
| Consumidor de la subred on-prem (ej. la VM, un dashboard) | `--accept-routes` |
| Subnet-router (expone una LAN al tailnet) | `--advertise-routes=172.25.0.0/16` |
| Host que ya llega a `172.25.*` nativamente (ej. `central`) | nada — dejar `--accept-routes=false` |

### 3. Verificar y aprobar rutas (solo subnet-routers)

```bash
sudo headscale nodes list
sudo headscale nodes list-routes
sudo headscale nodes approve-routes --identifier <node-id> --routes 172.25.0.0/16
```

En `list-routes`, la columna **`Serving (Primary)`** es la que importa: si está **vacía**, la ruta está aprobada pero **nadie la está sirviendo** (router offline) → el tráfico no pasa aunque `Approved` diga que sí.

### 4. Nombrar bien

Los nombres son la única documentación viva del tailnet. Convención observada: `frc-cicd-vm`, `frc-mauro-subnet`, `central`, `farmacia-nueva`, `pc-central`, `pc-casa`, `centro2`, `central-caja3`. Nombre = qué máquina es + qué rol cumple.

---

## Remover / administrar un nodo

```bash
sudo headscale nodes list                                  # obtener el ID
sudo headscale nodes delete --identifier <id>              # borrar (pide confirmación)
sudo headscale nodes expire --identifier <id>              # forzar re-auth sin borrar
sudo headscale nodes rename --identifier <id> <nuevo>      # renombrar
sudo headscale nodes move --identifier <id> --user <uid>   # cambiar de user (re-evalúa ACL)
```

En la máquina, para salir limpio:
```bash
sudo tailscale logout          # desautentica, deja tailscaled corriendo
sudo tailscale down            # baja la interfaz sin desautenticar
```

**Borrar el nodo en headscale no basta** — si la máquina sigue con `tailscaled` activo y una key válida, se puede re-registrar. Hacer `logout` en la máquina *y* `delete` en el control server.

---

## Topología: el bridge a `172.25.*` (**transitorio — en retiro**)

> **Estado:** andamio de migración, con fecha de vencimiento. La arquitectura destino es **cada filial enrolada nativa**, sin puente. Ver "Retiro del bridge" abajo.

La VM Hetzner **no entró a ZeroTier**. Hoy llega a la flota on-prem por un puente:

```
VM Hetzner (100.64.0.1)  ──tailnet──►  mauro (100.64.0.2)  ──ZeroTier──►  flota 172.25.*
   frc-cicd-vm                          frc-mauro-subnet
   --accept-routes                      --advertise-routes=172.25.0.0/16
```

`mauro` = `172.25.0.172`, el host del dashboard viejo. Anuncia `172.25.0.0/16`, aprobado en headscale.

**Efecto buscado:** el registro del dashboard sigue usando IPs `172.25.*` sin reescribir nada. Transparente.

**🔴 SPOF real, no teórico:** mauro es el **único** router de esa ruta. Si mauro se apaga, la VM pierde toda la flota y el dashboard deja de monitorear — silenciosamente (`Approved` sigue diciendo `172.25.0.0/16`; lo que se vacía es `Serving (Primary)`). Ya pasó: **2026-08-08 al 2026-08-11, mauro offline 2 días = dashboard ciego**.

**Mitigación de corto plazo** (mientras el bridge siga vivo): enrolar un segundo subnet-router anunciando el mismo `172.25.0.0/16` — headscale hace failover automático entre routers de la misma ruta. Candidato natural: `central` (nodo 5, ya enrolado y online, con pata en `172.25.*`). Barato y elimina el SPOF sin esperar al rollout completo.

**Mitigación definitiva:** el rollout de abajo. Cuando toda filial esté enrolada nativa, el bridge deja de tener función.

### Chequeo de salud del bridge (rutina, mientras exista)

```bash
ssh deploy@178.105.107.171 '
  tailscale status | grep mauro
  sudo headscale nodes list-routes
  timeout 8 curl -s -o /dev/null -w "%{http_code}\n" http://172.25.1.200:8081/actuator/info
'
```
`200` = bridge sano. `UNREACHABLE` + mauro `offline` = bridge caído, hay que levantar mauro.

---

## Retiro del bridge — headscale nativo en cada PC filial

**Decisión (2026-08-11):** se deja de usar `frc-mauro-subnet` como puente. **Cada PC filial instala su propio cliente tailscale** y entra al tailnet por derecho propio.

Por qué: el bridge es un SPOF probado (2 días de dashboard ciego en agosto 2026), acopla toda la observabilidad a una máquina de pruebas, y mantiene ZeroTier como dependencia. Enrolar nativo elimina las tres cosas de una.

### Por filial (repetir 1×)

```bash
# 1. en la VM — una key por filial: user filiales + tag, single-use, SIN --ephemeral
sudo headscale preauthkeys create -u 5 --tags tag:filial -e 1h

# 2. en la PC filial
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up \
  --login-server https://hs.farmaciafrancopy.com \
  --authkey <KEY> \
  --hostname filial-<nombre> \
  --accept-dns=false
sudo tailscale status
```

- **`-u 5 --tags tag:filial`**: la filial queda acotada por ACL (solo habla con la infra en los puertos de app y PG; no alcanza otras filiales). Sin el tag hereda malla completa.
- **`--accept-dns=false`**: obligatorio. Sin esto tailscale pisa el resolver de la PC y rompe la resolución de nombres de la LAN local.
- **Sin `--advertise-routes`**: la filial es un nodo hoja, no un router. Solo el andamio que se retira anuncia subredes.
- **Sin `--accept-routes`**: la filial no necesita las rutas de nadie; habla con central por su LAN o por tailnet directo.
- Windows: instalador oficial de tailscale, después `tailscale up` con los mismos flags desde PowerShell como admin. Hay filiales Windows (`central-caja3` ya está así) — ver [hosts.md](../hosts.md).
- Si una filial ya quedó enrolada sin tag: `sudo headscale nodes tag -i <node-id> -t tag:filial` (no requiere re-enrolar).

### Después de enrolar cada filial

1. **Verificar alcance real**, no solo que aparezca en `nodes list`:
   ```bash
   ssh deploy@178.105.107.171 'timeout 8 curl -s -o /dev/null -w "%{http_code}\n" http://<ip-tailnet>:8082/actuator/info'
   ```
2. **Repuntar el registro del dashboard** de la IP `172.25.*` a la IP tailnet (o al nombre MagicDNS `filial-x.hs.farmacia`, más estable que la IP). Ver [dashboard-ops.md](../dashboard-ops.md).
3. **Revisar la replicación PG** si su conninfo usa la IP vieja — cambiar la sub apunta a downtime de replicación, coordinar. Ver [replication.md](replication.md).
4. Recién cuando **todas** las filiales estén enroladas y verificadas: retirar la ruta de mauro
   (`sudo headscale nodes delete --identifier 4`) y bajar ZeroTier host por host.

### Orden

Una filial por vez, verificada antes de la siguiente. **Farmacia se hizo primero** (2026-08-11, 4 filiales); bodega queda para después — son ~17, así que conviene guionizar el ciclo enrolar→verificar en vez de hacerlo a mano.

**Antes de tocar bodega, releer la sección de `configuraciones.local` abajo:** esa tabla es una fila única replicada a **toda** la flota, incluidas las filiales bodega que todavía no están en el tailnet. Cambiarla a un FQDN antes de que bodega resuelva `hs.farmacia` rompe la creación de suscripciones nuevas en esas filiales.

### Gotcha del rollout

Mientras conviven los dos caminos, **una filial puede ser alcanzable por dos IPs** (`172.25.x` vía bridge y `100.64.x` nativa). Si el dashboard queda con la vieja y la nueva en registros distintos, vas a ver la misma filial duplicada o "caída" según cuál se consulte. Migrar el registro **en el mismo paso** que el enrolamiento, no después.

---

## Inventario de nodos (verificado 2026-08-11 — **siempre re-verificar en vivo**)

| ID | Nombre | IP tailnet | Tag | Qué es |
|---|---|---|---|---|
| 3 | `frc-cicd-vm` | 100.64.0.1 | — | la propia VM Hetzner (dashboard frc-cicd) |
| 4 | `frc-mauro-subnet` | 100.64.0.2 | — | **subnet-router** `172.25.0.0/16` = mauro `172.25.0.172`. **Hostea el canal alpha entero** (central `:8083` y filial `:8080`) y el túnel `cloudflared` de `alpha-api.frcsuite.com`. Volvió online el 2026-08-11; verificado el 2026-08-15 |
| 5 | `central` | 100.64.0.3 | — | VM cloud `frc-servidor` (DigitalOcean). `accept-dns=true` |
| 6 | `farmacia-filial-6` | 100.64.0.4 | `tag:filial` | filial farmacia 6 = **`sucursal_id 7`, SUC. II**. Ex-`farmacia-nueva`. Sin IP `172.25.*` |
| 7 | `pc-central` | 100.64.0.5 | — | PC de administración |
| 8 | `pc-casa` | 100.64.0.6 | — | PC de administración |
| 9 | `farmacia-filial-4` | 100.64.0.7 | `tag:filial` | filial farmacia 4 (SUC. III), `172.25.3.4`. Ex-`centro2` |
| 10 | `central-caja3` | 100.64.0.8 | — | **Windows.** Por el nombre parece caja → candidata a `tag:cliente`, pendiente de confirmar qué hace |
| 15 | `pc-diego` | 100.64.0.9 | `tag:cliente` | Windows |
| 16 | `adm-bodega` | 100.64.0.10 | `tag:cliente` | Windows. Sin `:22` |
| 17 | `farmacia-filial-1` | 100.64.0.11 | `tag:filial` | filial farmacia 1 (SUC. CENTRAL), `172.25.3.1` |
| 18 | `farmacia-filial-3` | 100.64.0.12 | `tag:filial` | filial farmacia 3 (SUC. ITAIPU), `172.25.3.3` |

> **Ojo con los nombres genéricos:** `centro2` resultó ser la **filial farmacia 4** (`172.25.3.4`), enrolada tiempo atrás bajo `admin` y sin tag. No era una PC suelta. Antes de suponer qué es un nodo, entrar a la máquina y correr `tailscale ip -4` desde la IP `172.25.*` conocida — es la única forma de mapear nodo ↔ host con certeza. Renombrado a `farmacia-filial-4` (`nodes rename NEW_NAME -i <id>`; el nombre posicional va **antes** del flag).

**Los nodos del bootstrap siguen bajo `admin` y sin tags** = malla completa. Se van reclasificando a medida que se identifican. Al taggear un nodo, su `User` pasa a `tagged-devices` — eso es normal, no un error.

**Estado del rollout farmacia (2026-08-11):** las 4 filiales encendidas están enroladas y taggeadas. Filial 2 fue **dada de baja** (sucursal cerrada) y filial 5 está **apagada con la sucursal abierta** — requiere visita al local.

**Deuda abierta:** los nodos que son puestos operativos (`central-caja3` es una caja Windows; `centro2` habría que confirmar qué es) deberían pasar a `tag:cliente`. Reclasificar no requiere re-enrolar:
```bash
sudo headscale nodes tag -i <node-id> -t tag:cliente
```
⚠️ Es un cambio con efecto inmediato: al taggear, el nodo **pierde la malla completa** y queda solo con lo que permite `tag:cliente`. Si esa PC hacía algo más que correr el desktop (RDP, acceso a PG, compartir archivos), se corta. Confirmar el uso real de cada una antes de taggear, y de a una.

---

## Deploy por CI a través del tailnet

`frc-comercial/central/.github/workflows/deploy.yml` tiene un step condicional:

```yaml
- name: Connect to headscale (alpha only)
  if: inputs.instance == 'alpha'
  uses: tailscale/github-action@v3
  with:
    authkey: ${{ secrets.HEADSCALE_AUTHKEY }}
    hostname: gh-deploy-runner
    args: --login-server=https://hs.farmaciafrancopy.com --accept-dns=false
```

- El `if:` es lo que contiene el riesgo: **farmacia y bodega no ejecutan el step**, su camino de deploy queda idéntico. Sin ese `if`, una caída de headscale rompe los deploys de producción.
- Secret `HEADSCALE_AUTHKEY` vive en el **environment `alpha`** del repo central. Key `--reusable --ephemeral` (correcto acá: el runner nace y muere en cada corrida; sin `--ephemeral` headscale acumula un `gh-deploy-runner` muerto por corrida).
- `DEPLOY_HOST` del environment `alpha` = la IP tailnet del destino (`100.64.0.2`), o su nombre MagicDNS.
- El step nació en `develop`. Antes de asumir que un deploy lo usa, verificar que la rama tenga el step (`git log -- .github/workflows/deploy.yml`).

Cargar el secret:
```bash
sudo headscale preauthkeys create --user 4 --reusable --ephemeral --expiration 720h   # en la VM
gh secret set HEADSCALE_AUTHKEY --env alpha                                           # local, pegar la key
```

---

## Operación del server

### Backup (instalado 2026-08-11)

Perder `/var/lib/headscale` = **re-enrolar cada nodo a mano y en sitio**. Con la flota enrolada eso es una recorrida por todas las sucursales, así que el backup es prerequisito del rollout, no un extra.

| Pieza | Valor |
|---|---|
| Script | `/usr/local/sbin/headscale-backup.sh` |
| Unidad | `headscale-backup.service` + `.timer`, diario **04:30 UTC**, `Persistent=true` |
| Local | `/var/backups/headscale/headscale-<stamp>.tar.gz`, retención 14, `chmod 600` |
| Offsite | `scp` a `franco@100.64.0.3:/home/franco/backups/headscale` por tailnet, misma retención |
| Log | `/var/backups/headscale/backup.log` |
| Contiene | `db.sqlite` + `noise_private.key` + `policy.json` + `config.yaml` |

**Nunca `cp` de `db.sqlite` con headscale vivo** — hay MBs sin checkpointear en el `-wal` y la copia sale inconsistente. El script usa `sqlite3 ".backup"`, que consolida el WAL. Verificar una copia:
```bash
sudo tar -xzf /var/backups/headscale/headscale-<stamp>.tar.gz -C /tmp/chk
sqlite3 /tmp/chk/db.sqlite "pragma integrity_check; select count(*) from nodes;"
```
El fallo del offsite **no** aborta el backup local (queda `offsite FALLO` en el log). Revisar el log si el destino cambia de IP.

> El tarball contiene la clave privada del control server. Tratarlo como secreto: `600`, directorio destino `700`, nunca a un repo ni a almacenamiento compartido.

**Autenticación del offsite:** keypair dedicado `/root/.ssh/headscale_backup` en la VM, su pública en `~franco/.ssh/authorized_keys` de central (comentario `headscale-backup@FRC`). Si el offsite empieza a fallar, chequear esa entrada antes que nada.

### Restaurar

Escenario real: se perdió/corrompió `/var/lib/headscale`. Sin restore, cada nodo hay que re-enrolarlo en sitio.

```bash
# 1. parar el control server (los nodos siguen hablando entre sí mientras tanto)
sudo systemctl stop headscale

# 2. traer el backup (local, o desde central si se perdió la VM)
scp franco@100.64.0.3:/home/franco/backups/headscale/headscale-<stamp>.tar.gz /tmp/
sudo tar -xzf /tmp/headscale-<stamp>.tar.gz -C /tmp/restore

# 3. restaurar DB + clave. La clave es lo irreemplazable:
#    sin noise_private.key los nodos NO reconocen al server y hay que re-enrolar todo.
sudo install -o headscale -g headscale -m 600 /tmp/restore/db.sqlite          /var/lib/headscale/db.sqlite
sudo install -o headscale -g headscale -m 600 /tmp/restore/noise_private.key  /var/lib/headscale/noise_private.key
sudo rm -f /var/lib/headscale/db.sqlite-wal /var/lib/headscale/db.sqlite-shm   # WAL viejo del estado roto

# 4. ACL y config (solo si también se perdieron)
sudo cp /tmp/restore/policy.json /tmp/restore/config.yaml /etc/headscale/

# 5. arrancar y verificar
sudo systemctl start headscale
headscale nodes list          # deben aparecer todos, y reconectan solos
```
Restaurar la DB **sin** la clave no sirve: la identidad del control server vive en `noise_private.key`. Por eso el backup lleva las dos cosas juntas.

### TLS del control plane

Cert Let's Encrypt para `hs.farmaciafrancopy.com`, renovado por `certbot-renew.timer`. **Si ese cert vence, ningún nodo puede registrarse ni resincronizar** — es una caída de flota, no un detalle cosmético.

Ya pasó una vez que el timer estaba `enabled` pero `inactive (dead)` (o sea: no iba a correr nunca). Chequeo:
```bash
systemctl is-active certbot-renew.timer      # tiene que decir "active"
systemctl list-timers certbot-renew.timer    # tiene que tener NEXT
sudo certbot certificates | grep -A3 hs.farmaciafrancopy
```
`enabled` **no** implica que esté corriendo. Mirar `is-active` y el NEXT, no solo `is-enabled`.

El vhost `/etc/nginx/conf.d/headscale.conf` está correcto para el long-poll del control plane (`proxy_read_timeout 3600s`, upgrade headers, buffering off). Si alguien lo regenera con defaults de nginx (60s), los nodos empiezan a reconectar en loop.

### DERP (relay)

`derp.server.enabled: false` — se usa el DERP público de Tailscale (`controlplane.tailscale.com/derpmap/default`). La mayoría de los pares conecta P2P directo y nunca toca el relay; los que tienen NAT hostil salen por São Paulo (`relay "sao"` en `tailscale status`).

**Decisión 2026-08-11: se deja así.** Montar DERP propio en la VM (`derp.server.enabled: true` + `3478/udp` en firewalld) es la salida si aparece una filial con latencia alta o que no logra P2P — hacerlo con un caso concreto, no preventivamente.

### Versión

`v0.28.0` estable. El server avisa que hay `0.29.0-beta.4` disponible. **No upgradear durante el rollout** — migración de flota y cambio de versión mayor a la vez, no.

---

## De dónde saca el sistema las IPs de replicación

El backend **no hardcodea ninguna dirección** — arma las conninfo desde dos fuentes distintas, y eso define qué hay que cambiar al migrar (`LogicalReplicationService`):

| Sentido | Fuente del host | Quién abre la conexión |
|---|---|---|
| central → filial | `empresarial.sucursal.ip` + `.puerto` (`:663`) | **central** |
| filial → central | `configuraciones.local.ip_servidor_central` + `.puerto_servidor_central` (`:143`), fallback a `application.properties` | **la filial** |

Consecuencias que no son obvias:

- **La creación automática de suscripciones no es un riesgo, es la palanca.** Arreglás las tablas y toda sub futura nace correcta. Si *no* las arreglás, cada filial nueva regenera direcciones viejas y la migración se deshace sola, en silencio.
- **`configuraciones.local` está en `central_pub`**: es **una fila única replicada a toda la flota**. Un `UPDATE` en central llega a las ~23 filiales. Es cómodo (no hay que entrar filial por filial) y peligroso (radio de impacto total, y no se puede tener un valor distinto por filial).
- **`empresarial.sucursal` también se replica.** Su fila `id=0 SERVIDOR` está vacía; sería el lugar natural para la dirección de central, pero hoy nada la consume.
- **Cambiar esas tablas NO afecta las subs existentes** — cada una guarda su propia conninfo. Por eso el orden correcto es: DNS → tablas → `ALTER SUBSCRIPTION` de las existentes.
- El **puerto de app de central (8082) no está en la DB**: vive en `application.properties` de cada filial, hoy apuntando a la **IP pública** (`159.203.86.103`), que funciona sin VPN.
- `sucursal.ip` no la usa solo central: el **desktop** también (impresión por sucursal en `puerto_servidor`, y el diálogo de setup de replicación en `puerto` 5551 — este último **no** lo permite `tag:cliente`). Por eso conviene migrar `sucursal.ip` recién cuando los desktops de esa sucursal estén en el tailnet.

## Gotchas

### Runner cloud de GitHub no alcanza `100.64.x.x` por sí solo
`deploy.yml` corre en `runs-on: ubuntu-latest` — una VM en la nube de GitHub, **fuera del tailnet**. Poner tailscale en el host destino **no habilita el deploy**: la IP `100.64.x.x` solo existe dentro del tailnet.

Dos caminos, y solo dos:
1. **Meter el runner al tailnet** con el step de arriba (es el elegido). Requiere tocar el workflow.
2. **Endpoint público en el `:22`** del destino: IPv4 adicional de Hetzner (~€1-2/mes) + DNAT `:22 → 100.64.x.x:22`. La VM hoy tiene **una sola IP pública** y firewalld **sin `forward-ports`** — nada forwardea el `:22` (el sshd de la VM lo ocupa).

Si alguien propone "enrolá la PC a tailscale y ya deploya", el plan no cierra. Pedir que explique cómo el runner alcanza `100.64.x.x`.

### `--ephemeral` en un servidor = error
Nodo efímero se **borra de headscale al desconectarse**. El host reinicia → desaparece del tailnet → al volver toma IP nueva y **pierde las rutas aprobadas**. Efímero es solo para runners de CI y containers descartables. Para un host persistente: key single-use, expiry corta, sin `--ephemeral`.

### Subnet-router no forwardea aunque todo "esté bien" — falta `tailscale0` en zona firewalld
Ruta aprobada, `ip_forward=1`, la ruta existe en kernel (`ip route get 172.25.1.200 → dev tailscale0`) y aun así **100% packet loss**. En Fedora con firewalld el forward entre interfaces se gobierna por zonas; `tailscale0` sin zona cae en la default y el paquete muere antes de rutearse.

```bash
sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0
sudo firewall-cmd --reload
```
Ambas interfaces (`tailscale0` + la de la red destino) en `trusted`. **No** hace falta `--add-masquerade`: tailscale ya hace SNAT de subnet-routes por default (`NoSNAT:false`), así el retorno vuelve a la IP del router. Detalle completo en [gotchas.md](../gotchas.md).

### Enrolar parece romper ZeroTier — verificar desde un tercer host antes de asumirlo
Al enrolar `farmacia-filial-1` (2026-08-11) la Mac del operador perdió el acceso a `172.25.3.1` por ZeroTier justo después del `tailscale up`. Parecía causado por el enrolamiento. **No lo era:**

- filial 3 → filial 1 por ZT: OK (`:22`, `:8082`, ping 0% loss)
- central → filial 1: OK (replicación intacta)
- `RouteAll: false` y `ip route get 172.25.x` seguía saliendo por `ztyxataffb`, no por `tailscale0`

Era un corte transitorio del par ZeroTier entre esos dos peers; se recuperó solo a los pocos minutos. **Antes de revertir nada, probar desde un tercer host** (otra filial o central). La hipótesis tentadora —"tomó la ruta `172.25.0.0/16` de mauro y la manda a un router muerto"— se descarta mirando `tailscale debug prefs | grep RouteAll` y `ip route get`.

### Nodo offline se confunde con "VPN rota"
Síntoma típico: `Connection timed out` hacia una IP `100.64.x.x`. Antes de tocar red, mirar `tailscale status` del origen:
```
100.64.0.4  farmacia-nueva  admin  linux  active; relay "sao"; offline, last seen 1d ago, tx 15288 rx 0
```
`tx > 0, rx = 0` = mandamos y no vuelve nada = **el peer está apagado / sin internet / `tailscaled` no levantó**. No hay nada que arreglar del lado local. Ir a la máquina: encendido, internet, `systemctl status tailscaled`.

Esto mordió con `filial_farmacia_6_sub` (2026-07-20): la replicación PG apuntaba a `100.64.0.4`, el nodo llevaba 1 día caído, y la sub *parecía* sana (`worker = t`, `apply_error_count = 0`) — un fallo de conexión **no incrementa** `apply_error_count`. Ver [replication.md](replication.md).

### MagicDNS pisaba el resolver — resuelto con `override_local_dns: false` (2026-08-11)
**Síntoma original:** `tailscale up` con `--accept-dns=true` reemplazaba el DNS del sistema por el del tailnet, rompiendo todo lo que resolviera por nombre de LAN (impresoras, PG por hostname, dominios internos). En Windows es especialmente difícil de diagnosticar: el síntoma aparece lejos ("la app no conecta", no "cambió el DNS").

**Causa real:** no era MagicDNS, era la config del control server. Con `dns.nameservers.global` poblado, headscale empuja `~.` — "enrutá **todos** los dominios al tailnet". Se ve en el nodo:
```
DNS Domain: hs.farmacia ~.        ← el "~." es el problema
```

**Fix (aplicado):** en `/etc/headscale/config.yaml`
```yaml
dns:
  nameservers:
    global: []
  override_local_dns: false     # ← el knob real
```
`override_local_dns: false` hace que tailscale enrute **solo `hs.farmacia`** y deje el resto al resolver del sistema. Resultado en el nodo:
```
Link 2 (enp3s0)     DNS Servers: 8.8.8.8 8.8.4.4          ← intacto
Link 8 (tailscale0) DNS Domain: hs.farmacia ~0.e.1...arpa  ← solo el tailnet
```

⚠️ **`global: []` solo no alcanza — headscale no arranca:** `Fatal config error: dns.nameservers.global must be set when dns.override_local_dns is true`. Hay que setear **las dos** cosas. Con `policy.mode: file` un config inválido deja el servicio caído, así que verificar `systemctl is-active headscale` después de cada cambio.

**Regla nueva:** todos los nodos van con `--accept-dns=true`. Los ya enrolados no necesitan re-enrolarse:
```bash
sudo tailscale set --accept-dns=true
```
Esto es lo que permite usar **FQDN (`central.hs.farmacia`) en toda la configuración**, en lugar de IPs `100.64.x` que cambian si un nodo se re-enrola. El step de CI todavía usa `--accept-dns=false` (runner efímero, no lo necesita).

### Un nodo taggeado deja de pertenecer a su user (para la ACL)
Al aplicar `tag:x` a un nodo, su identidad ACL pasa a ser el tag: las reglas que lo alcanzaban por `group:<su-user>` **dejan de aplicarle**, tanto como origen como destino. Taggear un nodo de infra que hoy funciona por `group:admin → *:*` le corta el acceso en el acto.

Se ve directo en el listado: un nodo enrolado con `--tags` aparece con **`User = tagged-devices`**, no con el user de la key (verificado 2026-08-11 al enrolar `pc-diego` con `-u 6 --tags tag:cliente`). `tagged-devices` es un pseudo-user de headscale, no algo que hayas creado. Que el user "cambie solo" es lo esperado, no un error.

**Gotcha de inspección:** en `nodes list -o json` el campo es **`tags`**. No existen `forced_tags` / `valid_tags` — un script que busque esos nombres devuelve `[]` para todos los nodos y te hace creer que ninguno está taggeado.

Por eso la infra (VM, `central`, PCs) va **sin tag** y solo se taggean las filiales. Si necesitás agrupar infra por tag, hay que escribir las reglas del tag *antes* de aplicarlo.

### `central` corre con `--accept-routes=false` a propósito
`tailscale status` en central tira el warning `Some peers are advertising routes but --accept-routes is false`. **Es correcto**: central llega a `172.25.*` nativamente por su propia LAN, no necesita las rutas de mauro. No "arreglarlo" — activarlo le metería rutas redundantes.

### Filiales en tailnet vs. filiales en ZeroTier (durante la transición)
Mientras dure el rollout conviven las dos redes. Antes de asumir por qué IP se llega a una filial, mirar el registro real (`monitored_servers` del dashboard, o la conninfo de su sub de replicación): algunas todavía usan `172.25.*` (ZeroTier), `farmacia-nueva` ya usa `100.64.0.4` (tailnet). Mezclar las dos produce diagnósticos falsos — típicamente "la filial está caída" cuando lo que está caído es el camino que consultaste.

Regla mientras dure: **una filial tiene una sola dirección canónica**. Al enrolarla nativa, su dirección canónica pasa a ser la tailnet y la `172.25.*` se retira del registro en el mismo paso.

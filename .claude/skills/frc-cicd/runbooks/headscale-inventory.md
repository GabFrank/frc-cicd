# Headscale — Inventario y Monitoreo de Expiraciones

**Última actualización del snapshot:** 2026-09-04

> ⚠️ **Este es un snapshot histórico.** Siempre refrescar el inventario desde el servidor real antes de tomar decisiones operativas. Ver sección "Cómo refrescar el inventario" abajo.

---

## 🎯 Propósito

Este runbook documenta:
1. **Inventario vivo** de nodos y preauth keys de Headscale
2. **Monitoreo de expiraciones** — especialmente preauth keys que requieren rotación
3. **Runbook de rotación** de secretos con ubicaciones conocidas
4. **Criterios de alerta** para anticipar caídas de servicio

---

## Inventario de Nodos

> **Nota importante:** Casi todos los **nodos** tienen `Expiration = never` (0001-01-01). Lo que expira son las **preauth keys**, no los nodos ya enrolados.

### Snapshot 2026-09-04

| ID | Hostname | Name | IP Tailnet | User | Tags | Connected | Expired | Notas de Rol |
|----|----------|------|------------|------|------|-----------|---------|--------------|
| 3 | `frc-cicd-vm` | `frc-cicd-vm` | 100.64.0.1 | admin | — | online | no | Headscale control + CI VM |
| 4 | `frc-mauro-subnet` | `frc-mauro-subnet` | 100.64.0.2 | admin | — | online | no | Alpha test PC Mauro / subnet router |
| 5 | `central` | `central` | 100.64.0.3 | admin | — | online | no | Central prod-ish (DigitalOcean) |
| 6 | `farmacia-nueva` | `farmacia-filial-6` | 100.64.0.4 | tagged-devices | tag:filial | online | no | Filial 6 (SUC. II) |
| 7 | `pc-central` | `farmacia-filial-1` | 100.64.0.5 | tagged-devices | tag:filial | online | no | Filial 1 (SUC. CENTRAL) |
| 8 | `pc-casa` | `pc-casa` | 100.64.0.6 | admin | — | online | no | Admin home PC |
| 9 | `centro2` | `farmacia-filial-4` | 100.64.0.7 | tagged-devices | tag:filial | online | no | Filial 4 (SUC. III) |
| 10 | `central-caja3` | `central-caja3` | 100.64.0.8 | admin | — | online | no | Caja Windows |
| 15 | `pc-diego` | `pc-diego` | 100.64.0.9 | tagged-devices | tag:cliente | online | no | Cliente Windows |
| 16 | `adm-bodega` | `adm-bodega` | 100.64.0.10 | tagged-devices | tag:cliente | offline | no | Cliente Windows |
| 17 | `farmacia-filial-1` | `farmacia-filial-1-viejo` | 100.64.0.11 | tagged-devices | tag:filial | online | no | Filial 1 viejo |
| 18 | `farmacia-filial-3` | `farmacia-filial-3` | 100.64.0.12 | tagged-devices | tag:filial | online | no | Filial 3 (SUC. ITAIPU) |
| 25 | `pc-alpha-bot` | `pc-alpha-bot` | 100.64.0.19 | tagged-devices | tag:cliente | offline | **yes** | ⚠️ Stale/expired Grok Bot enrollment |
| 27 | `pc-alpha-bot` | `pc-alpha-bot-qumn7m7v` | 100.64.0.21 | admin | — | online | no | Current Grok Bot shared box |
| 32 | `pc-gabriel` | `pc-gabriel` | 100.64.0.26 | admin | — | online | no | Gabriel admin PC |
| 34 | `pc-adm-frc` | `pc-adm-frc` | 100.64.0.28 | tagged-devices | tag:cliente | online | no | Cliente/admin FRC |
| 41 | `cliente-prueba` | `cliente-prueba` | 100.64.0.35 | tagged-devices | tag:cliente | online | no | Cliente prueba |

**Resumen por estado:**
- **Online:** 15 nodos
- **Offline:** 2 nodos (`adm-bodega`, `pc-alpha-bot` expired)
- **Expired:** 1 nodo (`pc-alpha-bot` ID 25 — requiere cleanup)

---

## 🚨 Inventario de Preauth Keys — ATENCIÓN CRÍTICA

### ⚠️ Keys Activas que Requieren Monitoreo

| ID | Owner/Tag | Reusable | Ephemeral | Used | Expiration | Propósito | Estado de Urgencia |
|----|-----------|----------|-----------|------|------------|-----------|-------------------|
| **#30** | `sim_gateways` | ✅ true | ❌ false | ❌ false | **2026-09-05** | Home-bridge / SIM gateway onboarding | 🔴 **CRÍTICO** — expira en ~1 día |
| **#24** | `tag:cliente` | ✅ true | ❌ false | ❌ false | **2026-10-10** | Client onboarding (cajas, puestos) | 🟡 **36 días** — monitorear |
| **#31** | `admin` | ✅ true | ✅ true | ❌ false | **2027-09-04** | CI alpha `HEADSCALE_AUTHKEY` (replacement for #20) | ✅ **1 año** — OK |

### 🔄 Keys Recientemente Expiradas / Reemplazadas

| ID | Owner/Tag | Reusable | Ephemeral | Used | Expiration | Propósito | Estado |
|----|-----------|----------|-----------|------|------------|-----------|--------|
| **#20** | `admin` | ✅ true | ✅ true | ✅ true | ~2026-09-04 | CI HEADSCALE_AUTHKEY for alpha env | ⚠️ **EXPIRADA** — reemplazada por #31 |

### 📦 Archivo Histórico — Keys Expiradas (resumen)

Keys #1 a #29 (excepto las activas arriba): mayormente single-shot de enrolamientos históricos, expiradas y sin uso actual. No requieren acción.

---

## 🔐 Runbook de Rotación de Preauth Keys

### Criterios de Alerta

Implementar monitoreo con los siguientes umbrales:

| Umbral | Acción |
|--------|--------|
| **≤ 3 días** | 🔴 **CRÍTICO** — Rotar inmediatamente |
| **≤ 14 días** | 🟡 **WARNING** — Programar rotación |
| **> 14 días** | ✅ **OK** — Monitoreo rutinario |

**Estado actual (2026-09-04):**
- 🔴 Key #30 (`sim_gateways`) — **CRÍTICO**, expira 2026-09-05
- 🟡 Key #24 (`tag:cliente`) — **36 días**, programar rotación
- ✅ Key #31 (`admin` CI) — **1 año**, OK

### Procedimiento General de Rotación

**1. Generar nueva preauth key en el servidor Headscale**

Acceder a la VM:
```bash
ssh deploy@100.64.0.1
# o por hostname: ssh deploy@frc-cicd-vm.hs.farmacia
```

Crear nueva key según el propósito:

```bash
# Para CI (reusable + ephemeral, 30 días típico)
sudo headscale preauthkeys create -u 4 --reusable --ephemeral -e 720h

# Para cliente onboarding (reusable, NO ephemeral, 90 días típico)
sudo headscale preauthkeys create -u 6 --tags tag:cliente --reusable -e 2160h

# Para filial (single-use, NO ephemeral, 1 hora)
sudo headscale preauthkeys create -u 5 --tags tag:filial -e 1h

# Para SIM gateways (reusable, NO ephemeral, 90 días)
sudo headscale preauthkeys create -u 2 --reusable -e 2160h
```

**2. Actualizar el secreto en su ubicación**

Ver sección "Ubicaciones de Secretos" abajo.

**3. Verificar que el nuevo secreto funciona**

Antes de expirar la key antigua:
- Para CI: forzar un deploy al entorno `alpha` y verificar que conecta
- Para onboarding: probar enrolar un nodo de prueba
- Para gateways: verificar con el owner del proyecto

**4. Expirar la key antigua**

```bash
sudo headscale preauthkeys list    # obtener el ID numérico de la key vieja
sudo headscale preauthkeys expire -i <ID>
```

⚠️ **IMPORTANTE:** Expirar una key `--reusable` NO desenrola los nodos ya registrados con ella (esto es correcto). Solo bloquea nuevos enrolamientos.

**5. Documentar el cambio**

Actualizar:
- Este runbook (nueva key ID, nueva expiración)
- El log de operaciones del proyecto
- Cualquier runbook de terceros que referencie la key

---

## 📍 Ubicaciones de Secretos

### Key #31 — CI Alpha (GitHub Actions)

**Dónde:** GitHub secret `HEADSCALE_AUTHKEY` en el **environment `alpha`** del repositorio `franco-system-backend-servidor` (u otro repo del proyecto, verificar).

**Ubicación exacta:**
- Repo: `<org>/franco-system-backend-servidor`
- Settings → Secrets and variables → Actions → Environment secrets → `alpha`
- Secret name: `HEADSCALE_AUTHKEY`

**Cómo actualizar:**
```bash
# Opción 1: Via gh CLI (requiere permisos de admin en el repo)
gh secret set HEADSCALE_AUTHKEY --env alpha --repo <org>/franco-system-backend-servidor

# Opción 2: Via UI de GitHub
# Settings → Environments → alpha → Environment secrets → Edit HEADSCALE_AUTHKEY
```

⚠️ **Pendiente de verificación:** Al momento de este snapshot, la key #31 fue creada como reemplazo de la #20 expirada, pero **puede requerir actualización en GitHub**. Verificar que el secret actual sea la key #31 y no la #20 expirada.

### Key #24 — Cliente Onboarding

**Dónde:** TBD / Verificar

Posibles ubicaciones:
- Scripts de instalación en filiales
- Documentación interna de onboarding
- Sistema de auto-enrolamiento (si existe)

**Acción requerida:** Documentar la ubicación exacta cuando se identifique.

### Key #30 — SIM Gateways

**Dónde:** TBD / Verificar con el owner del proyecto `sim_gateways`

**Acción requerida:** Contactar al owner del proyecto para coordinar rotación (URGENTE, expira 2026-09-05).

---

## 🔄 Cómo Refrescar el Inventario

### Desde la VM Headscale

Acceder al servidor:
```bash
ssh deploy@100.64.0.1
# o: ssh deploy@frc-cicd-vm.hs.farmacia
```

### Listar Nodos

```bash
# Formato tabla (legible)
sudo headscale nodes list

# JSON completo (para scripts)
sudo headscale nodes list -o json > /tmp/nodes-$(date +%Y%m%d).json
```

**Campos clave:**
- `id` — ID numérico del nodo
- `hostname` / `name` — identificación
- `ip_addresses` — IP tailnet (típicamente `100.64.0.x`)
- `user.name` — owner (`admin`, `filiales`, `tagged-devices`)
- `forced_tags` — tags ACL (ej. `["tag:filial"]`)
- `online` — conectividad actual
- `expiry` — `0001-01-01T00:00:00Z` = never

### Listar Preauth Keys

```bash
# Formato tabla
sudo headscale preauthkeys list

# JSON completo
sudo headscale preauthkeys list -o json > /tmp/keys-$(date +%Y%m%d).json
```

**Campos clave:**
- `id` — ID numérico de la key
- `user` — owner (`admin`, `filiales`, `clientes`, etc.)
- `reusable` — si se puede usar múltiples veces
- `ephemeral` — si los nodos se autodestruyen al desconectarse
- `used` — si ya fue utilizada al menos una vez
- `expiration` — fecha/hora de vencimiento (UTC)
- `created_at` — cuándo se creó

### Script de Monitoreo de Expiraciones

Ejemplo para alertar sobre keys próximas a expirar:

```bash
#!/bin/bash
# check-headscale-keys.sh
# Uso: sudo ./check-headscale-keys.sh

NOW=$(date +%s)
WARN_DAYS=14
CRIT_DAYS=3

sudo headscale preauthkeys list -o json | jq -r '.[] | 
  select(.used == false) | 
  "\(.id)|\(.user)|\(.expiration)|\(.reusable)"' | \
while IFS='|' read -r id user exp reusable; do
  exp_ts=$(date -d "$exp" +%s 2>/dev/null || echo 0)
  days_left=$(( (exp_ts - NOW) / 86400 ))
  
  if [[ $days_left -le $CRIT_DAYS ]]; then
    echo "🔴 CRÍTICO: Key #$id ($user) expira en $days_left días ($exp)"
  elif [[ $days_left -le $WARN_DAYS ]]; then
    echo "🟡 WARNING: Key #$id ($user) expira en $days_left días ($exp)"
  fi
done
```

### Consultas Útiles

```bash
# Solo nodos offline
sudo headscale nodes list -o json | jq '.[] | select(.online == false) | {id, name, last_seen}'

# Solo nodos expirados (raro, pero puede pasar)
sudo headscale nodes list -o json | jq '.[] | select(.expiry != "0001-01-01T00:00:00Z") | {id, name, expiry}'

# Keys reusables activas (las que importan para rotación)
sudo headscale preauthkeys list -o json | jq '.[] | select(.reusable == true and .used == false)'

# Contar nodos por tag
sudo headscale nodes list -o json | jq 'group_by(.forced_tags[0] // "no-tag") | map({tag: .[0].forced_tags[0] // "no-tag", count: length})'
```

---

## 🛡️ Seguridad y Mejores Prácticas

### ❌ NUNCA

- **Commitear keys completas** a git — solo ID + prefijo redactado (`hskey-auth-….****`)
- **Loguear keys completas** en CI/CD logs — usar máscaras
- **Compartir keys por canales inseguros** — Slack, email sin cifrar, etc.
- **Reusar keys expiradas** — siempre generar nueva
- **Keys sin expiración** — Headscale no lo permite, pero evitar expiraciones > 1 año sin revisión

### ✅ SIEMPRE

- **Rotar keys antes de que expiren** — mínimo 14 días de antelación
- **Verificar la nueva key antes de expirar la vieja**
- **Usar `--ephemeral` solo para CI/containers descartables**
- **Scope mínimo de privilegios** — usar tags ACL (`tag:cliente`, `tag:filial`) en lugar de `admin`
- **Monitoreo automatizado** — script cron diario que alerte sobre expiraciones
- **Backup de `/var/lib/headscale`** — ver [headscale.md](headscale.md) sección Backup

### Formato de Redacción de Keys

Cuando documentar o compartir referencias a keys:

```bash
# ✅ CORRECTO
Key #31: hskey-auth-abc123def….****  (admin, ephemeral, exp 2027-09-04)

# ❌ INCORRECTO
Key #31: hskey-auth-abc123def456ghi789jkl012mno345pqr678stu901vwx234
```

---

## 📊 Dashboard de Estado (Quick Status)

**Snapshot:** 2026-09-04

| Métrica | Valor |
|---------|-------|
| Nodos totales | 17 |
| Nodos online | 15 |
| Nodos offline | 2 |
| Nodos expirados | 1 (ID 25, cleanup pendiente) |
| Keys activas monitoreadas | 3 (#30, #24, #31) |
| Keys en estado CRÍTICO | 1 (#30, expira 2026-09-05) |
| Keys en WARNING | 1 (#24, expira 2026-10-10) |
| Keys OK | 1 (#31, expira 2027-09-04) |

**Próximas acciones requeridas:**
1. 🔴 **URGENTE:** Rotar key #30 (`sim_gateways`) antes de 2026-09-05
2. 🟡 Programar rotación de key #24 (`tag:cliente`) para antes de 2026-09-26
3. ⚠️ Verificar y actualizar GitHub secret `HEADSCALE_AUTHKEY` con key #31 en repo `franco-system-backend-servidor`
4. 🧹 Cleanup del nodo expirado ID 25 (`pc-alpha-bot`)

---

## Referencias

- **Runbook principal de Headscale:** [headscale.md](headscale.md)
- **Hosts y accesos:** [../hosts.md](../hosts.md)
- **Replicación y conectividad de filiales:** [replication.md](replication.md)
- **Servidor headscale:** `hs.farmaciafrancopy.com` (VM 100.64.0.1)
- **Documentación oficial:** https://github.com/juanfont/headscale

---

## Changelog del Inventario

| Fecha | Cambio | Autor |
|-------|--------|-------|
| 2026-09-04 | Snapshot inicial — creación del runbook de inventario | Cloud Agent |

**Próxima revisión programada:** 2026-09-18 (o antes si key #30 es rotada)

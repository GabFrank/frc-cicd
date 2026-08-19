# Sudoers — patrones y fixes en filiales

El `check-update.sh` linux necesita reiniciar el service sin password. Esto requiere NOPASSWD configurado correctamente para `franco`.

## Estado esperado

`sudo -n -l` en una filial bien configurada muestra:

```
(root) NOPASSWD: /usr/bin/systemctl restart frc.service
(root) NOPASSWD: /usr/bin/systemctl status frc.service
(root) NOPASSWD: /usr/bin/systemctl stop frc.service
(root) NOPASSWD: /usr/bin/systemctl start frc.service
```

Generalmente en `/etc/sudoers.d/franco-frc` o similar.

## Gotcha #1 — regla genérica invalida el NOPASSWD

**Síntoma:** `sudo -n -l` lista el NOPASSWD **y también** lista `(ALL) ALL` sin NOPASSWD. Al invocar `sudo -n systemctl restart frc.service` pide password.

**Causa:** sudo usa la regla del **último match**. Si franco (o su grupo wheel) tiene `franco ALL=(ALL) ALL` en `/etc/sudoers` **después** del `#includedir /etc/sudoers.d`, esa regla gana y exige password.

**Detección:**
```bash
ssh franco@<IP> "sudo -n -ll 2>&1 | head -50"
```
Si ves `Sudoers entry: /etc/sudoers` con `Commands: ALL` **después** de la entry de `franco-frc`, es este caso.

**Fix durable:** `sudo visudo` → comentar la línea genérica:
```bash
# Buscar una de:
franco ALL=(ALL) ALL
franco ALL=(ALL:ALL) ALL
%wheel ALL=(ALL) ALL    # si franco está en wheel
# Comentarla con # al inicio.
```

**Fix intentado-pero-no-suficiente:** crear `/etc/sudoers.d/zz-franco-frc-nopasswd` con reglas NOPASSWD esperando que el orden alfabético lo ponga último. No funciona porque `/etc/sudoers` se evalúa completo (incluyendo la línea generic ALL=ALL) **después** de los includes si el `#includedir` no está en la última línea del archivo. Por eso: comentar la línea origen es lo confiable.

**Validación post-fix:**
```bash
ssh franco@<IP> "sudo -K; sudo -n /usr/bin/systemctl is-active frc.service"
# Esperado: "active"  (sin pedir password)
```

Si sigue pidiendo password tras comentar: revisar si franco está en otros grupos con reglas sudoers (`groups franco`), y aplicar el mismo fix.

## Gotcha #2 — path absoluto no salva del gotcha #1

Se suele pensar que `sudo /usr/bin/systemctl` (path completo) hará match con la regla NOPASSWD mientras `sudo systemctl` (sin path) no. La realidad: **sudo resuelve `systemctl` via secure_path → `/usr/bin/systemctl`** antes del match, así que ambos llegan al mismo punto. Si gana una regla generic ALL=ALL, pide password en ambos casos.

Por tanto: cambiar el script a usar path absoluto **no** resuelve el problema subyacente. Hay que corregir sudoers.

## Gotcha #3 — `sudo -S` con pipe de password se queda sin retries

Intento de automatización:
```bash
echo 'franco' | sudo -S systemctl restart frc.service
```

Falla si el prompt pide password más de una vez (sudo lo hace típicamente hasta 3 intentos). El `echo` solo envía un line → sudo usa el mismo string para los 3 retries si el password era incorrecto en el primer intento, o directamente corta.

**Workaround para automación desde shell remoto:** usar `sudo -v` primero con heredoc:
```bash
ssh franco@<IP> "sudo -v 2>&1 <<< 'franco' > /dev/null && sudo -n systemctl restart frc.service"
```
El `-v` valida credenciales y las cachea. Luego `sudo -n` aprovecha el cache.

Pero mejor: dejar NOPASSWD bien configurado y no depender de pipe.

## Cómo fue resuelto en filial 1 (2026-04-23)

1. Aplicado drop-in `/etc/sudoers.d/zz-franco-frc-nopasswd` → no alcanzó (gotcha #1 confirmado).
2. User comentó la línea generic ALL=ALL en `/etc/sudoers` via `sudo visudo` interactivo.
3. `sudo -n /usr/bin/systemctl is-active frc.service` → devolvió `active` sin password. Fix exitoso.
4. Cron arranca próxima iteración sin pedir password.

## Estado sudoers por filial (auditoría 2026-04-23)

- Filial 1: fix aplicado hoy. Operacional.
- Filial 3: originalmente funcional, no tenía generic ALL=ALL.
- Filial 4: funcional.
- Filial 5: funcional.
- Filial 2 (windows): N/A, no usa sudo (Scheduled Task corre como service account).

## Hallazgo fleet-wide bodega + fix validado (2026-06-11)

Al promover `filial v4.2.0 → bodega`, **~7 de 17 filiales Linux bodega** (172.25.1.{8,9,12,18,20,22,23}) tenían el gotcha #1: `franco ALL=(ALL) ALL` **duplicado después** del `#includedir /etc/sudoers.d` en `/etc/sudoers` (línea ~121). El `zz-franco-frc-nopasswd` drop-in NO alcanzaba (confirma el "fix que no funciona"). Las otras 10 tenían `(ALL) ALL` una sola vez arriba → nopasswd OK.

**Fix surgical validado (con backup + `visudo -c` + restore automático):**
```bash
sudo cp /etc/sudoers /etc/sudoers.frcbak
sudo sed -i -E 's/^(franco[[:space:]]+ALL=\(ALL\)[[:space:]]+ALL)[[:space:]]*$/# \1/' /etc/sudoers
sudo visudo -c || sudo cp /etc/sudoers.frcbak /etc/sudoers   # restore si inválido
```
franco conserva sudo via `%wheel` (línea ~107, antes del include), así que comentar la línea 121 no le saca acceso — solo deja que el NOPASSWD de `frc.service` sea el último match.

**Validar con `status`, NO `is-active`:** `is-active` no está en la lista NOPASSWD (solo `restart/stop/start/status`), así que pedirá password aunque el fix esté bien. Test correcto: `sudo -k; sudo -n /usr/bin/systemctl status frc.service` → rc=0 sin password.

Aplicado a 6 hosts alcanzables + bodega-18 (que volvió después). Estado: **resuelto en los 7**. Pendiente: ver si el resto de la flota (farmacia, bodega no afectadas) tiene la misma estructura por las dudas.

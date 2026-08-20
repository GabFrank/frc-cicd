# Runbook cutover — filial 1 farmacia → `192.168.0.104`

Ejecutar de noche, con la sucursal cerrada. Plan y contexto: [plan-migracion-filial1-farmacia.md](plan-migracion-filial1-farmacia.md).

**Nomenclatura:** `VIEJO` = `192.168.0.146` / `100.64.0.11` · `NUEVO` = `192.168.0.104` / `100.64.0.5` · `CENTRAL` = `central.hs.farmacia:5551` db `farmacia`.

**Acceso:** desde la mac, SSH directo a los dos por tailnet (`franco@100.64.0.11`, `franco@100.64.0.5`).

> ⚠️ **En el NUEVO, `java` a secas es OpenJDK 25 y el JAR es Spring Boot 2.1.15 — no arranca.** El unit ya apunta bien; para cualquier prueba manual usar la ruta completa: `/usr/lib/jvm/temurin-17-jdk/bin/java`.

---

## Estrategia de replicación: reutilizar los slots, no recrearlos

El estado de replicación lógica no sobrevive un dump/restore, pero **los slots viven en el otro extremo** y sí sobreviven. Por eso:

- **Central → filial:** los slots `central_farmacia_1_sub` y `central_filial_farmacia_1_sub` viven en CENTRAL. Se desprenden del VIEJO sin borrarlos (`SET (slot_name = NONE)` antes del `DROP SUBSCRIPTION`) y el NUEVO los adopta con `create_slot=false, copy_data=false`. Arranca exactamente en el LSN donde quedó el viejo: **sin hueco y sin recopia**.
- **Filial → central:** el slot vive en la FILIAL, así que se pierde con la máquina. La sub de central se recrea apuntando al NUEVO con `copy_data=false` — válido porque central ya está al día (lag 56 bytes) y la app queda detenida, así que no se genera nada en el medio.

⚠️ **El orden es lo que evita perder datos:** restaurar → crear las subs → **recién entonces** arrancar la app. Si la app arranca antes de que exista el slot de central, esas ventas no se replican nunca.

---

## Fase 0 — Pre-check (5 min antes del corte)

```bash
# VIEJO: nadie operando
sshpass -p "$FILIAL_1_PASS" ssh franco@100.64.0.11 \
  "sudo ss -tn state established '( sport = :8082 )' | wc -l"

# VIEJO: lag de sus 2 subs entrantes (informativo — esta dirección está protegida
# por la retención del slot en central, no necesita lag 0 para ser segura)
sudo docker exec postgres psql -U franco -d general -At -c \
  "select subname, received_lsn, latest_end_lsn from pg_stat_subscription"
```

**Dejar lista la conexión a CENTRAL desde ahora** (se usa en varias fases):

```bash
# en el NUEVO
export PGPASSWORD=$(grep -oP 'password=\K\S+' /tmp/central.conn)
alias psql_central='psql -h central.hs.farmacia -p 5551 -U franco -d farmacia'
psql_central -At -c "select 'conexion OK'"
```

> Si `/tmp/central.conn` no existe (vive en `/tmp` y se pierde en un reboot), regenerarlo desde el VIEJO — la password sale de la conninfo de su propia suscripción:
> ```bash
> # en el VIEJO
> sudo docker exec postgres psql -U franco -d general -At -c \
>   "select subconninfo from pg_subscription where subname='central_farmacia_1_sub'" > /tmp/central.conn
> chmod 600 /tmp/central.conn
> scp /tmp/central.conn franco@192.168.0.104:/tmp/central.conn
> ```

### ⛔ Gate: la dirección filial → central

**Este es el único chequeo cuya omisión pierde ventas de forma permanente.** El slot `filial_farmacia_1_sub` vive en la FILIAL y se pierde con la máquina: lo que central no haya consumido antes del corte, no se recupera. (La dirección inversa está protegida por la retención del slot en central y no necesita este gate.)

```bash
# correr en el NUEVO, contra CENTRAL — con la app del VIEJO YA DETENIDA (Fase 1 paso 2)
psql_central -At -c "
  select case when pg_wal_lsn_diff(sent_lsn, replay_lsn) = 0
              then 'OK lag=0 — seguir'
              else 'ESPERAR: faltan '||pg_size_pretty(pg_wal_lsn_diff(sent_lsn, replay_lsn)) end
  from pg_stat_replication r
  join pg_replication_slots s on s.active_pid = r.pid
  where s.slot_name = 'filial_farmacia_1_sub'"
```

**Criterio pass/fail: no continuar a la Fase 1 paso 4 hasta que diga `OK lag=0`.** Repetir cada 10 s. Si el slot no aparece activo, verificar que la sub de central esté habilitada antes de seguir.

## Fase 1 — Congelar el VIEJO

```bash
# 1. cron fuera: si no, en <=15 min check-update.sh rearranca el servicio solo
crontab -l > /tmp/cron.bak && crontab -r

# 2. parar la app
sudo systemctl stop frc.service
sudo systemctl disable frc.service

# 3. GATE: confirmar lag=0 en la dirección filial -> central
#    Correr el bloque "Gate" de la Fase 0. NO seguir al paso 4 sin un OK.

# 4. desprender las subs SIN borrar los slots de central
sudo docker exec postgres psql -U franco -d general <<'SQL'
ALTER SUBSCRIPTION central_farmacia_1_sub DISABLE;
ALTER SUBSCRIPTION central_filial_farmacia_1_sub DISABLE;
ALTER SUBSCRIPTION central_farmacia_1_sub SET (slot_name = NONE);
ALTER SUBSCRIPTION central_filial_farmacia_1_sub SET (slot_name = NONE);
DROP SUBSCRIPTION central_farmacia_1_sub;
DROP SUBSCRIPTION central_filial_farmacia_1_sub;
SQL
```

> `SET (slot_name = NONE)` antes del `DROP` es **el paso que no se puede saltear**. Sin él, el `DROP SUBSCRIPTION` borra el slot en central y se pierde el punto de continuidad.

## Fase 2 — Dump y restore

```bash
# VIEJO — ahora SIN --no-publications: filial1_pub (33 tablas) tiene que viajar
sudo docker exec postgres pg_dump -U franco -d general -Fc --no-subscriptions -f /tmp/general.dump
sudo docker cp postgres:/tmp/general.dump /tmp/general.dump
sudo chown franco:franco /tmp/general.dump
sshpass -p franco scp -o StrictHostKeyChecking=no /tmp/general.dump franco@192.168.0.104:/tmp/

# NUEVO — borrar la base del ensayo y restaurar limpio
sudo -u postgres psql -p 5551 -c "DROP DATABASE IF EXISTS general"

# ⚠️ EL LOCALE VA EXPLICITO. El origen es en_US.utf8 y TODOS los templates de esta
# maquina son es_ES.UTF-8: sin esto la base nueva queda con otra collation y cambia
# el orden de texto (ñ, acentos) en ORDER BY / busquedas por rango, en silencio.
# TEMPLATE template0 es obligatorio para poder fijar un locale distinto al del template.
sudo -u postgres psql -p 5551 -c "CREATE DATABASE general OWNER franco TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'"

# ⚠️ TIMEZONE del cluster: el VIEJO corre en Etc/UTC y el NUEVO en America/Asuncion.
# Hay 13+ columnas timestamp WITHOUT time zone con default now(), incluida
# financiero.documento_electronico (fiscal/SIFEN) y flyway_schema_history: cualquier
# INSERT que use el default de DB guardaria 3-4h corrido respecto del viejo.
sudo -u postgres psql -p 5551 -c "ALTER DATABASE general SET timezone='Etc/UTC'"

# verificar ANTES de restaurar
sudo -u postgres psql -p 5551 -At -c "select datname||' collate='||datcollate from pg_database where datname='general'"
sudo -u postgres psql -p 5551 -d general -At -c "show timezone"   # tiene que decir Etc/UTC
time sudo -u postgres pg_restore -p 5551 -U postgres -d general --no-owner /tmp/general.dump
```

Se esperan **3 errores** de FK (los 4 huérfanos conocidos) — se resuelven en la Fase 6. Cualquier otro error hay que leerlo.

```bash
# verificación rápida: 142 tablas, 242 índices, 137 secuencias, publicación presente
sudo -u postgres psql -p 5551 -d general -At -c \
  "select (select count(*) from pg_tables where schemaname not in ('pg_catalog','information_schema')) || ' tablas / ' ||
          (select count(*) from pg_publication_tables where pubname='filial1_pub') || ' tablas publicadas'"
```

## Fase 3 — Identidad de red

```bash
# headscale (desde la mac): liberar el nombre y dárselo al NUEVO
ssh deploy@178.105.107.171 "sudo headscale nodes rename --identifier 17 farmacia-filial-1-viejo"
ssh deploy@178.105.107.171 "sudo headscale nodes rename --identifier 7 farmacia-filial-1"

# VIEJO: soltar la IP de las cajas (queda en .145 para poder volver atrás)
sudo nmcli con mod "<nombre-con>" ipv4.addresses 192.168.0.145/24
sudo nmcli con up "<nombre-con>"

# NUEVO: tomar .146 conservando .104 (así no se corta ninguna sesión en curso)
sudo nmcli con mod "Conexión cableada 2" ipv4.addresses "192.168.0.146/24,192.168.0.104/24"
sudo nmcli con up "Conexión cableada 2"
ip -4 addr show enp46s0 | grep inet
```

## Fase 4 — Rearmar la replicación

Conexión a central (la password sale de `/tmp/central.conn`, ya copiado al NUEVO):

```bash
export PGPASSWORD=$(grep -oP 'password=\K\S+' /tmp/central.conn)
PSQL_CENTRAL="psql -h central.hs.farmacia -p 5551 -U franco -d farmacia"
```

**4a. Central → filial** (en el NUEVO, adoptando los slots existentes):

```sql
-- correr en el NUEVO, db general
CREATE SUBSCRIPTION central_farmacia_1_sub
  CONNECTION 'host=central.hs.farmacia port=5551 user=franco password=<pass> dbname=farmacia'
  PUBLICATION central_pub
  WITH (create_slot = false, slot_name = 'central_farmacia_1_sub', copy_data = false, enabled = true);

CREATE SUBSCRIPTION central_filial_farmacia_1_sub
  CONNECTION 'host=central.hs.farmacia port=5551 user=franco password=<pass> dbname=farmacia'
  PUBLICATION central_filial1_pub
  WITH (create_slot = false, slot_name = 'central_filial_farmacia_1_sub', copy_data = false, enabled = true);
```

> 🔴 **`origin = none` no es opcional.** Todas las subs del ecosistema lo llevan; un `CREATE SUBSCRIPTION` sin él queda en `origin = any` y **abre un eco**: lo que central manda a la filial, la filial lo republica a central y pisa cambios posteriores. Pasó en el cutover del 2026-08-19. Agregarlo a las tres subs (`WITH (..., origin = none)`) o corregirlo después con `ALTER SUBSCRIPTION <sub> SET (origin = none)`, y verificar con:
> ```sql
> select subname, suborigin from pg_subscription;   -- en central Y en la filial: todas 'none'
> ```

**4b. Filial → central** (en CENTRAL, recreando la sub contra el NUEVO):

```sql
ALTER SUBSCRIPTION filial_farmacia_1_sub DISABLE;
ALTER SUBSCRIPTION filial_farmacia_1_sub SET (slot_name = NONE);
DROP SUBSCRIPTION filial_farmacia_1_sub;

CREATE SUBSCRIPTION filial_farmacia_1_sub
  CONNECTION 'host=farmacia-filial-1.hs.farmacia port=5551 user=franco password=<pass> dbname=general'
  PUBLICATION filial1_pub
  WITH (copy_data = false, enabled = true);
```

**4c. Registro de la sucursal** (en CENTRAL):

```sql
UPDATE empresarial.sucursal
   SET ip = '100.64.0.5', puerto = 5551, puerto_servidor = 8082
 WHERE id = 1;
```

## Fase 5 — Arrancar la app

```bash
# NUEVO — recién ahora, con los slots ya creados
sudo systemctl enable --now frc.service
sleep 45
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8082/actuator/health   # 200
journalctl -u frc.service -n 40 --no-pager
```

> **El cron de auto-update NO se instala todavía** — va al final, después de la Fase 7. Si se instala acá y el canal `beta` tiene un release más nuevo que `5.0.0-beta.1`, `check-update.sh` puede bajar otra versión y reiniciar el servicio (corriendo migraciones Flyway nuevas) justo mientras se aplican los FK a mano y se hace la venta de prueba.

## Fase 6 — Los 3 FK

```sql
-- en el NUEVO, db general
ALTER TABLE operaciones.venta_item
  ADD CONSTRAINT venta_item_fk FOREIGN KEY (presentacion_id)
  REFERENCES productos.presentacion(id) ON UPDATE CASCADE ON DELETE SET NULL NOT VALID;

ALTER TABLE administrativo.jornada
  ADD CONSTRAINT fk_jornada_entrada FOREIGN KEY (entrada_id, entrada_sucursal_id)
  REFERENCES administrativo.marcacion(id, sucursal_id) NOT VALID;

ALTER TABLE administrativo.jornada
  ADD CONSTRAINT fk_jornada_salida FOREIGN KEY (salida_id, salida_sucursal_id)
  REFERENCES administrativo.marcacion(id, sucursal_id) NOT VALID;
```

`NOT VALID` protege toda escritura futura y tolera las 4 filas viejas. Verificar que quedan **365 FK**, igual que el viejo.

## Fase 6b — Impresoras (CUPS)

**Casi todo ya está portado** (2026-08-19, de día). CUPS guarda las impresoras en archivos y **ninguna cola usa PPD/driver** (`/etc/cups/ppd/` vacío, todas raw ESC/POS), así que el porte fue mecánico. Estado en la máquina nueva:

| Impresora | Destino | Estado |
|---|---|---|
| `ticket3` `ticket4` `ticket6` `ticket7` `ticket8` `ticket10` | `smb://` a la PC de cada caja | **portadas y validadas** (445 + auth OK con `smbclient`) |
| `ticket9` | `smb://192.168.0.206/ticket3` | portada, pero **esa PC no responde** (445 cerrado; sin actividad desde 2026-02-14) |
| `ticket11` | `usb://Printer/POS-58?serial=2022123456` | creada apuntando a la impresora local. **Hoy sin uso**: el viejo sigue reenviando su propio `ticket11` por `ipp://` a la cola `ticket` de esta máquina |
| `ticket` | `usb://Printer/POS-58?serial=2022123456` | cola local preexistente, **sin tocar** (se probó `file://`, rompió, se revirtió) |
| `ticket2` | — | **dada por muerta**, no se crea |
| `ticket5` | `ipp://192.168.0.145:631/printers/ticket5` | **resuelta por red** — la impresora se queda en la caja vieja, ver abajo |

### El problema de las dos POS-58 con el mismo serial

Las dos impresoras (la que ya está en `.104` y la que se muda) **reportan el mismo serial `2022123456`** — son clones. Con las dos enchufadas, `usb://Printer/POS-58?serial=2022123456` identifica a las dos y CUPS manda al primero que encuentra.

> 🔥 **Intento fallido, no repetir: `file:///dev/...` NO funciona en Fedora 44.**
> Se probó de día y **tumbó la impresión de esa PC durante ~1 hora**. Fedora 44 ya no
> empaqueta `/usr/lib/cups/backend/file` (ningún paquete lo provee, verificado con
> `dnf provides`). Sin backend, CUPS **acepta el trabajo, lo marca completado y lo
> descarta**: sin error, sin nada en el log salvo `total 0` en vez de `total 1`.
> Revertido a `usb://`. El anclaje udev (`/etc/udev/rules.d/99-frc-pos.rules`) y el
> `FileDevice Yes` quedaron puestos pero **hoy no se usan**.

**Cómo verificar que una impresión salió de verdad** (con el matiz que costó una falsa alarma el 2026-08-20): `lpstat -o` vacío no prueba nada, y **`total 0` tampoco prueba que se descartó**.

```bash
sudo journalctl -u cups --since '-2min' --no-pager | grep total
```
- `usb://` e `ipp://` cuentan páginas → `total 1` = imprimió.
- **`smb://` SIEMPRE registra `total 0`**, imprima o no: ese backend no cuenta páginas. Las 7 colas SMB de filial 1 lo hacen desde siempre, operando normal.

Señal confiable: **trabajos atascados en `lpstat -o`** (con `retry-current-job`, una falla real los deja encolados) y errores explícitos en el journal (`unable to`, `failed`, `not responding`).

### `ticket5` — resuelto sin mover el aparato (2026-08-20)

**El servidor viejo no se retira: sigue en el local como caja** (`local: "Caja 1"`, `pdvId: 1`). Mover su impresora la habría dejado sin poder imprimir. Así que se invirtió el planteo: **la impresora se queda donde está y el servidor nuevo la alcanza por red**, igual que las 7 impresoras de las otras cajas.

```bash
# en la caja vieja (192.168.0.145): CUPS tiene que arrancar en el boot
sudo systemctl enable cups          # estaba 'disabled' — funcionaba solo por activacion por socket

# en el servidor nuevo
sudo lpadmin -p ticket5 -v 'ipp://192.168.0.145:631/printers/ticket5' -E \
  -o printer-is-shared=true -o printer-error-policy=retry-current-job
```

Verificado end-to-end: el trabajo sale del servidor nuevo, entra al CUPS de la caja vieja (`REQUEST 192.168.0.146 ... Create-Job successful-ok`) y se imprime (`total 1` en las dos puntas).

**Consecuencia:** el problema de las dos POS-58 con serial duplicado **desaparece** — nunca hay dos impresoras en el mismo host. El backend `posdev` quedó instalado y validado en `/usr/lib/cups/backend/posdev` por si alguna vez hace falta, junto con la regla udev; hoy no se usan.

> El único requisito nuevo es que **la caja vieja quede encendida y con CUPS activo** para que esa impresora esté disponible. Es una dependencia real: si esa PC se apaga, `ticket5` deja de imprimir (los trabajos quedan encolados por `retry-current-job`).

## Fase 7 — Verificación funcional

1. Login desde una caja (que sigue apuntando a `.146`, sin tocarle nada)
2. Venta de prueba → confirmar que aparece en central:
   ```sql
   -- en CENTRAL
   select id, sucursal_id, creado_en from operaciones.venta where sucursal_id = 1 order by id desc limit 3;
   ```
3. Cambio de precio en central → confirmar que llega al NUEVO

> **Cómo probar replicación sin romper nada:** modificar una fila **existente** y revertirla. **Nunca insertar filas nuevas** en tablas que central publica (ej. `configuraciones.replication_test`): la secuencia local no está sincronizada con la de central, el id colisiona y el worker de la suscripción entra en bucle de `llave duplicada`, bloqueando toda la suscripción. Si pasa, borrar la fila insertada a mano y se destraba solo.
>
> Los tres sentidos a cubrir: (a) item en central → filial (`central_pub`), (b) venta en filial → central (`filial1_pub`), (c) venta en central → filial (`central_filial1_pub`). Con `origin = none` bien puesto, la reversión de cada prueba tiene que **quedar estable** en las dos puntas.
4. `pg_stat_subscription` en ambos extremos: `latest_end_lsn` avanzando
5. Impresión de un ticket desde la caja

---

### Cierre: recién ahora el cron de auto-update

Con la Fase 7 pasada, instalar el cron en el NUEVO:

```bash
(crontab -l 2>/dev/null; echo '*/15 * * * * /usr/bin/flock -n /tmp/frc-filial-update.lock /opt/frc-filial/check-update.sh >> /opt/frc-filial/logs/check-update.log 2>&1') | crontab -
crontab -l
```

---

## Fase 8 — Reiniciar ambas máquinas y revalidar

No es opcional: casi todo lo configurado en el cutover (IP secundaria, symlink udev, cron, unit habilitado, políticas de reinicio) recién se prueba de verdad en un arranque. Ejecutado el 2026-08-20 con resultado limpio.

```bash
# VIEJO primero: tiene que volver MUDO
sudo systemctl reboot
# al volver: frc.service inactive/disabled · contenedor pg 'exited' · 0 listeners en 8082/5551 · sin cron

# NUEVO después: tiene que volver COMPLETO
sudo systemctl reboot
# al volver: health 200, postgresql-16 y cups activos, ambas IPs, cron presente,
#            /dev/pos-ticket11 recreado, subs con worker vivo y slot activo
```

> ⚠️ **El reboot borra `/tmp/central.conn`** (Fedora limpia `/tmp` al arrancar). Regenerarla desde la propia suscripción de la filial, sin depender del servidor viejo:
> ```bash
> sudo -u postgres psql -p 5551 -d general -At -c \
>   "select subconninfo from pg_subscription where subname='central_farmacia_1_sub'" | sudo tee /tmp/central.conn >/dev/null
> sudo chown franco:franco /tmp/central.conn && chmod 600 /tmp/central.conn
> ```

---

## Rollback

Mientras el VIEJO no se haya borrado, es reversible:

```bash
# VIEJO: recuperar IP, servicio y cron
sudo nmcli con mod "<nombre-con>" ipv4.addresses 192.168.0.146/24 && sudo nmcli con up "<nombre-con>"
sudo systemctl enable --now frc.service
crontab /tmp/cron.bak
# y recrear sus 2 subs adoptando de nuevo los slots de central (mismo SQL que 4a)
```

En central: revertir la conninfo de `filial_farmacia_1_sub` al VIEJO y `empresarial.sucursal.ip` a `172.25.3.1`.

**Se pierde:** lo que se haya vendido en el NUEVO durante la prueba. Por eso la Fase 7 se hace con una venta de prueba, no abriendo la caja al público.

---

## Después (no la misma noche)

- **Dropear el slot huérfano en el VIEJO**, una vez cerrada la ventana de rollback. La Fase 4b lo desprende (`SET slot_name = NONE`) para que el `DROP SUBSCRIPTION` en central no se cuelgue contra el publisher, pero eso deja el slot vivo y sin consumidor:
  ```sql
  -- en el VIEJO
  SELECT pg_drop_replication_slot('filial_farmacia_1_sub');
  ```
  Es el mismo patrón de slots huérfanos ya documentado en `gotchas.md`; si se olvida, queda reteniendo WAL y confunde a quien audite después.
- Dejar el VIEJO apagado una semana antes de reutilizarlo o borrarlo
- `headscale nodes delete --identifier 17` cuando ya no se necesite el rollback
- Sacar la IP `.104` secundaria del NUEVO una vez estabilizado
- Evaluar apagar el wifi (`FARMA ADMIN`, `192.168.0.102`) del NUEVO: dos interfaces en la misma subred pueden dar ruteo asimétrico
- **`/home/franco/FRC/resources`** (1.8 GB, 11.249 imágenes de productos + logo) hay que copiarlo aparte: es de donde la app lee las imágenes. **`user.home` de la JVM es `/home/franco`, no el `user.home=/opt/frc-filial` del `application.properties`** — las propiedades de sistema le ganan a las de `application.properties` en Spring Boot. Omitirlo produce `javax.imageio.IIOException: Can't read input file!` en cada consulta con imagen (detectado en producción el 2026-08-20, 07:37).
- Actualizar `hosts.md` de la skill: filial 1 pasa a `100.64.0.5`, Fedora 44, PG nativo (no Docker), Temurin 17
- El slot `central_filial_5_sub` retiene **4520 MB** de WAL en central por la filial 5 apagada — problema aparte, pero creciendo

# Migración servidor filial 1 farmacia — `192.168.0.146` → `192.168.0.104`

**Estado:** preparación hecha 2026-08-19 (mañana). Cutover previsto esa misma noche al cierre.
**Regla:** el servidor viejo queda intacto y arrancable hasta que el nuevo esté verificado. Todo paso es reversible salvo los marcados 🔶.

---

## 1. Las dos máquinas

| | Actual (`filial-1`) | Nueva |
|---|---|---|
| LAN | `192.168.0.146` (estática, gw `.1`, dns 8.8.8.8) | `192.168.0.104` (cableada `enp46s0`) + `192.168.0.102` (wifi `FARMA ADMIN`) |
| Tailnet | `100.64.0.11` `farmacia-filial-1`, `tag:filial` | `100.64.0.5` — era `pc-central` user admin sin tag; **retaggeada hoy** a `farmacia-filial-1-nuevo` + `tag:filial` |
| ZeroTier | 2 redes: `172.25.3.1` (bodega) + `192.168.100.188` (Farmacia Franco) | **ninguna** |
| OS | Fedora 38 Server | Fedora 44 **KDE Desktop** |
| CPU / RAM | 4 cores / 7.6 Gi | 16 cores / 15 Gi |
| Disco | 447G LVM, 35G usados | 475G NVMe, 17G usados |
| Java | `java-17-openjdk` 17.0.11 (rpm Fedora) | **Temurin 17.0.20** (instalado hoy; Fedora 44 ya no empaqueta JDK 17) |
| PostgreSQL | **16.4 en Docker**, bind `/var/lib/pgsql/16/data`, `5551→5432`, `restart=always` | **16.14 nativo** (`postgresql-16.service`), puerto **5551**, `wal_level=logical`, 10 slots, `listen_addresses=*` |
| App | `frc.service` activo, `5.0.0-beta.1`, canal `beta`, puerto 8082 | unit creado, **disabled** a propósito |
| Impresión | CUPS 2.4.7, 10 impresoras (7 `smb://`, 1 `usb://`, 2 `ipp://` a la nueva), **ninguna con PPD** (todas raw) | CUPS 2.4.19, `samba-client` presente; 8 impresoras ya portadas + anclaje udev por puerto USB |

> La máquina nueva es un **puesto de trabajo en uso** (KDE, Chrome, la app desktop `frc` corriendo, sesión abierta desde 2026-07-29). Pasa a cumplir doble rol. A favor: `sleep.target` ya está `masked`, así que no suspende.

---

## 2. Qué ya quedó hecho (2026-08-19, sin downtime)

- [x] Temurin 17 instalado (repo Adoptium `fedora/41`) — el JAR es Spring Boot **2.1.15** / `Build-Jdk-Spec: 11`; con el Java 25 de Fedora 44 no arranca
- [x] `/opt/frc-filial/` copiado del viejo: `application.properties`, `.env`, `.channel`, `.filial-id`, `.current-version`, `.github-token`, `check-update.sh`, `releases/5.0.0-beta.1`, symlink `current`, `logs/`, `backup/` (102 MB; no se copiaron los 12 releases viejos, 1.4 G)
- [x] `/etc/systemd/system/frc.service` nuevo, apuntando a Temurin y a `postgresql-16.service`
- [x] `/etc/sudoers.d/franco-frc` (start/stop/restart/status) — `visudo -c` OK
- [x] Unit legacy que apuntaba a `/home/franco/FRC/frc-server/frc-server.jar` (fallando desde julio) reemplazado y **`disable`d**
- [x] Ensayo completo de dump → transferencia → restore, con comparación de esquema
- [x] Credenciales del `.env` validadas contra el PG nuevo (`franco` conecta a `general`)
- [x] **`/opt/frc-filial/FRC/` copiado** (49 MB: `logo.png` + 49 fotos de presentaciones). Lo referencia `ImageService` como `${user.home}/FRC/resources/images/...`, y `user.home` está overrideado a `/opt/frc-filial` — sin esto el POS quedaba con imágenes rotas. **Se me había pasado en la copia inicial**; lo detectó la auditoría. Checksum verificado idéntico
- [x] `authorized_keys` sincronizadas (el nuevo tenía 1 de las 3 claves del viejo — quedaban 2 personas sin poder entrar a troubleshootear)
- [x] `pg_hba.conf` del nuevo deduplicado (tenía el bloque repetido 2 veces) y rol `franco` alineado (`CREATEDB`, `REPLICATION`)
- [x] Verificado **central → nuevo**: TCP 5551 OK desde central, MagicDNS resuelve `farmacia-filial-1-nuevo.hs.farmacia` → `100.64.0.5`, y autenticación `franco` contra la DB `general` OK desde un host externo
- [x] **Impresoras CUPS portadas**: las 7 `smb://` de las cajas copiadas con sus credenciales y validadas con `smbclient` (6 responden; `ticket9`/`192.168.0.206` tiene el 445 cerrado hace meses). `ticket11` repuntada a la impresora local y **probada imprimiendo**. `ticket2` dada por muerta. Falta solo `ticket5`, que requiere mudar el aparato físico

### Números del ensayo — por esto NO se justifica réplica lógica previa

| Paso | Tiempo | Tamaño |
|---|---|---|
| `pg_dump -Fc` (app corriendo) | **7.8 s** | 36 MB comprimido / 320 MB en disco |
| `scp` por LAN | **0.6 s** | — |
| `pg_restore` | ~1 min | 292 MB restaurados |

Montar una réplica total para ahorrar ~2 minutos agrega slots, riesgo de desincronización y trabajo de desmontaje. **Dump en el cutover.**

### Resultado de la comparación de esquema

Idéntico en tablas (142), índices (242), secuencias (137), vistas (1), funciones (49) y distribución por schema. **Difieren 3 FK** (365 → 362), por 4 filas huérfanas preexistentes:

| FK | Filas que lo bloquean |
|---|---|
| `operaciones.venta_item.venta_item_fk` | 2 (`venta_item` 5645 y 481 → `presentacion` 5191, inexistente) |
| `administrativo.jornada.fk_jornada_entrada` | 1 |
| `administrativo.jornada.fk_jornada_salida` | 1 |

**Causa:** la replicación lógica aplica con `session_replication_role = replica`, que **no dispara los triggers de FK**. Por eso el origen tolera filas que un `pg_restore` rechaza. Los 3 constraints figuran `convalidated=true` en el viejo — eran válidos cuando se crearon y los datos derivaron después. Es un defecto preexistente que la migración *revela*, no causa.

---

## 3. Topología de replicación (lo que hay que rearmar)

**Filial → central** (ventas, movimientos):
- La filial publica `filial1_pub`; el slot `filial_farmacia_1_sub` en la filial está `active`, lag 56 bytes (sano)
- Central tiene la suscripción que lo consume, apuntando a la filial por **tailnet** (`100.64.0.11`, desde 2026-08-15)

**Central → filial** (productos, precios): la filial tiene 2 subs, ambas `enabled`, apuntando a `172.25.1.200:5551/farmacia` (**ZeroTier**):
- `central_filial_farmacia_1_sub`
- `central_farmacia_1_sub`

⚠️ **El punto delicado de toda la migración:** el estado de replicación lógica (replication origins / LSN) **no sobrevive un dump/restore**. Las suscripciones hay que recrearlas, y si se recrean con `copy_data=false` "desde ahora", se pierde en silencio todo lo que central haya cambiado entre el dump y la recreación. Con `copy_data=true` se recopian tablas enteras.

**Solución: reutilizar los slots en vez de recrearlos.** Los slots viven en el extremo *opuesto* al que se migra, así que sobreviven:

- **Central → filial:** los slots `central_farmacia_1_sub` y `central_filial_farmacia_1_sub` están en CENTRAL. Se desprenden del viejo con `SET (slot_name = NONE)` **antes** del `DROP SUBSCRIPTION` (si no, el drop los borra), y el nuevo los adopta con `create_slot=false, copy_data=false`. Continúa exactamente en el LSN donde quedó: sin hueco, sin recopia.
- **Filial → central:** ese slot vive en la filial y se pierde con la máquina. La sub de central se recrea contra el nuevo con `copy_data=false`, válido porque central está al día y la app queda detenida.

⚠️ **El orden es lo que evita perder datos:** restaurar → crear las subs → **recién entonces** arrancar la app. Si la app arranca antes de que exista el slot de central, esas ventas no se replican nunca.

---

## 4. Cutover (noche, al cierre)

Tiempo estimado **20-30 min**, de los cuales ~3 min son la copia de datos.

**El paso a paso ejecutable, con los comandos y el SQL exactos, está en [runbook-cutover-filial1.md](runbook-cutover-filial1.md).** Fases: pre-check → congelar el viejo → dump/restore → identidad de red → rearmar replicación → arrancar app → FKs → verificación funcional, más el rollback.

---

## 5. Decisiones tomadas (2026-08-19)

| # | Decisión | Resuelto |
|---|---|---|
| 1 | IP LAN | **La nueva toma `.146`** en el cutover, conservando `.104` como secundaria. Ninguna caja se toca |
| 2 | Identidad tailnet | **Retaggeada hoy**: nodo 7 → `tag:filial`, renombrado `farmacia-filial-1-nuevo`. En el cutover se libera el nombre del viejo y pasa a llamarse `farmacia-filial-1` |
| 3 | Ruta filial → central | **Tailnet**, por MagicDNS `central.hs.farmacia` (probado OK desde la nueva). ZeroTier no se instala |
| 4 | Los 3 FK | **Recrear `NOT VALID`** — no toca datos, protege escrituras futuras, esquema a la par |

Conectividad verificada desde la máquina nueva, ya con la ACL de `tag:filial` aplicada:

| Destino | Resultado |
|---|---|
| `central.hs.farmacia:5551` (MagicDNS) | **OK** — conecta a `farmacia` con las credenciales de la sub |
| `100.64.0.3:5551` (tailnet directo) | **OK** |
| `159.203.86.103:8082` (app central) | **200** |
| `172.25.1.200:5551` (ZeroTier) | timeout — esperado, no tiene ZT |
| mac (`admin`) → nueva por SSH | **OK** — la regla `admin → tag:filial` la cubre |

**El paso a paso del corte está en [runbook-cutover-filial1.md](runbook-cutover-filial1.md)**, incluida la estrategia de reutilizar los slots de central (`SET (slot_name = NONE)` antes del `DROP SUBSCRIPTION`) para no perder el punto de continuidad.

## 6. Hallazgos de la auditoría (2026-08-19)

Dos agentes auditaron el runbook y el estado real de las máquinas. Lo corregido ya está arriba; lo que queda como contexto:

### Descartado tras verificar

- **RabbitMQ**: corre en el viejo (`rabbitmq-server` 3.11.10, puertos 5672/15672/25672/4369) con una cola `filial.1`, pero **es peso muerto**: cero conexiones, cero consumidores, cola vacía, y **ninguna versión del JAR** (3.0.9 → 5.0.0-beta.1) trae librerías AMQP. Queda un `SPRING_RABBITMQ_VIRTUAL_HOST` huérfano en el `.env`. **No replicar en el nuevo.**
- **Filial vieja ↔ filial nueva no se ven por tailnet**: es correcto, la ACL deniega `tag:filial` ↔ `tag:filial` a propósito. No afecta nada del cutover.
- **tzdb de la JVM**: Temurin 17.0.20 trae tzdb 2026-07-21, muy por encima del umbral del gotcha histórico de Asunción.
- Ownership tras `--no-owner`, espacio en disco, continuidad de secuencias, extensiones: verificados sin problema.

### Aceptado con riesgo conocido

- **Firewall**: el nuevo usa la zona `FedoraWorkstation`, cuyo rango `1025-65535/tcp` cubre 8082 y 5551 *de casualidad* (el `--add-port` explícito devolvió `ALREADY_ENABLED`, no-op). Si alguien acota ese rango sin saber, la app y la replicación quedan inalcanzables sin aviso.
- **`java` por defecto en el PATH del nuevo es OpenJDK 25.** El unit apunta a la ruta completa de Temurin, así que el arranque por systemd está bien — pero **cualquier `java -jar` manual de troubleshooting esta noche corre bajo Java 25 y va a fallar de forma confusa.** Usar siempre `/usr/lib/jvm/temurin-17-jdk/bin/java`.
- **Solo hay 1 release local en el nuevo** (`5.0.0-beta.1`) contra 12 en el viejo: un rollback de versión de app requiere volver a bajar de GitHub.
- **`sudoers` con `(ALL) NOPASSWD: ALL`** se arrastró del viejo. No es nuevo, pero aprovisionar un host limpio era la oportunidad de no heredarlo (ver `REPORTE_VULNERABILIDADES.md`).
- **ZeroTier sigue instalado y corriendo en el nuevo** (paquete `zerotier-one` build fc40 sobre fc44), sin red unida. Innecesario según la dirección del ecosistema.
- AnyDesk está en las dos máquinas, así que el acceso de soporte remoto no se pierde.

## 7. Pendientes menores

- El `check-update.sh` copiado apunta al canal `beta` — verificar que en el nuevo no arranque antes del cutover (hoy **no hay cron instalado** en la nueva; se agrega en el paso 4.4.14)
- La nueva no tiene ZeroTier: si algo del ecosistema la busca por `172.25.3.1`, deja de encontrarla (ver decisión 3)
- El viejo quedó con una línea extra en `/etc/sudoers.d/franco-frc` (`systemctl start frc.service`) agregada hoy — superset inofensivo
- `known_hosts` de la filial tiene una clave vieja para `.104` (línea 10); limpiarla si se va a usar SSH desde ahí de forma habitual

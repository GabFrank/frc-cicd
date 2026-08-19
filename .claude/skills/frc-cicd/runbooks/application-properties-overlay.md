# application.properties overlay — override de valores hardcoded en el JAR filial

## Problema

El JAR legacy `frc-filial-server.jar` (serie 3.x) tiene embebido en su classpath un `application.properties` con valores hardcodeados:

```properties
sucursalId = 24
facturaCountDown = 0
ipServidorCentral = localhost:8081
jarPath = /Users/gabfranck/Downloads/
```

Spring Boot 2.1.x carga `application.properties` de classpath con **precedencia baja** — se supera con:
1. Un `application.properties` en el **working directory** del service.
2. Variables de entorno con `--spring.config.location`.
3. System properties `-D`.

Si no se override, la filial arranca creyendo que es `sucursalId=24` → cualquier `INSERT` en tablas con FK a `empresarial.sucursal` falla con `cobro_sucursal_fk Key (sucursal_id)=(24) not present`.

**Síntoma en producción:** la FK bloquea el INSERT → `@Transactional` hace rollback → no queda fila corrupta, pero el usuario ve error en el flujo de venta/cobro.

## Fix — overlay en working directory

Crear `/opt/frc-filial/application.properties` (Linux) o `C:\frc-filial\application.properties` (Windows) con los valores correctos.

**Precondición:** la systemd unit (o Scheduled Task) debe tener `WorkingDirectory=/opt/frc-filial` (Linux) o apuntar a `C:\frc-filial` (Windows). Es así por default en los runbooks actuales.

### Linux — template

```bash
cat > /opt/frc-filial/application.properties <<EOF
# Overrides de propiedades hardcoded en el JAR embedded application.properties.
# Spring Boot lee este archivo desde WorkingDirectory=/opt/frc-filial con
# precedencia mayor que el classpath del JAR.
sucursalId=${SUCURSAL_ID}
facturaCountDown=${FCD_PER_FILIAL}
ipServidorCentral=159.203.86.103:8082
jarPath=/opt/frc-filial/current
user.home=/opt/frc-filial
homepath=/opt/frc-filial
EOF
```

Restart: `sudo systemctl restart frc.service`.

### Windows — template

```powershell
$content = @"
# Overrides de propiedades hardcoded en el JAR embedded application.properties.
sucursalId=<N>
facturaCountDown=<per filial>
ipServidorCentral=159.203.86.103:8082
jarPath=C:\frc-filial\current
user.home=C:\frc-filial
homepath=C:\frc-filial
"@
[System.IO.File]::WriteAllText("C:\frc-filial\application.properties", $content)
# Restart
Get-Process java -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
schtasks /Run /TN FRC-Filial-Server | Out-Null
```

## Valores por filial farmacia

Confirmados leyendo los `application.properties` legacy de cada filial antes de migrar. Cada filial tiene **su propio `facturaCountDown`** — no asumir default.

| Filial | sucursalId | facturaCountDown |
|---|---|---|
| 1 | 1 | 2 |
| 2 | 2 | 2 |
| 3 | 3 | **1** |
| 4 | 4 | 2 |
| 5 | 5 | 2 |

`ipServidorCentral=159.203.86.103:8082` es común a los 5 (apunta al central productivo farmacia).

## Verificación post-fix

```sql
-- Filas nuevas tras el fix deben usar el sucursal_id correcto.
SELECT id, sucursal_id, creado_en
FROM operaciones.cobro
ORDER BY id DESC LIMIT 5;

-- Smoke test: no debería haber rows con sucursal_id inexistente.
SELECT COUNT(*) FROM operaciones.cobro
WHERE sucursal_id NOT IN (SELECT id FROM empresarial.sucursal);
-- Esperado: 0
```

**Por qué 0 rows corruptas aunque el bug estuvo activo:** la FK `cobro_sucursal_fk` rechaza el INSERT → Spring `@Transactional` hace rollback automático → la transacción completa se deshace sin dejar residuo. No hay corrupción que limpiar.

## Variables adicionales que pueden necesitar override

Según el caso específico:
- `user.home` y `homepath` → path base que el server usa para escribir archivos temporales.
- `jarPath` → el server usa esto para lanzar sub-procesos (e.g. backup).
- `spring.profiles.active` → si se quiere forzar un perfil distinto al default.
- Cualquier `@Value("${...}")` del código fuente que apunte a algo embebido.

`spring.rabbitmq.virtual-host` — **no agregar**, es legacy, ya no se usa.

## Ubicación en la documentación del proyecto

Este override está documentado con más detalle en:
- `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-cicd/runbook-migracion-filial-linux-beta.md`
- `/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-cicd/runbook-migracion-filial-windows-beta.md`

Ambos runbooks tienen sección "application.properties externo — override de valores hardcoded en el JAR".

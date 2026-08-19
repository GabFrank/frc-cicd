# Scripts de escaneo — auditoría solo-lectura de hosts FRC

Vivan en `frc-cicd/scans/`. Reutilizables para cualquier auditoría previa o posterior a migración, incidente, o cambio de infra. **NO modifican nada** — solo leen estado y dumpean a stdout.

## Archivos disponibles

| Archivo | Uso |
|---|---|
| `scans/README.md` | Procedimiento paso a paso + plantilla de REPORTE.md + tabla matriz de prereqs |
| `scans/scan-central-farmacia.sh` | Escanea central (JAR en uso, paths, systemd unit, PG cluster, pubs/subs, empresarial.sucursal) |
| `scans/scan-filial-linux.sh <IP>` | Escanea una filial Linux (Java, jq, /opt/frc-filial/, .env, cron, pubs/subs, versiones) |
| `scans/scan-filial-windows.ps1 -IP <IP>` | Escanea una filial Windows (Java, PG service, C:\frc-filial\, Task Scheduler) |

## Cuándo usarlos

1. **Antes de una migración** (inventario GO/NO-GO). Poblar `scans/<topic>-<fecha>/REPORTE.md` siguiendo la plantilla del README.
2. **Post-migración como baseline** (snapshot "estado sano"). Útil para diff contra scans futuros si algo rompe.
3. **Tras incidente** (captura de estado + diff contra último baseline).
4. **Antes de auditar un nuevo grupo de hosts** (e.g. filiales bodega cuando se migren).

## Ejecución típica

```bash
cd /Users/gabfranck/workspace/frc-sistemas-informaticos/frc-cicd/scans

OUT="farmacia-$(date +%F)"
mkdir -p "$OUT"

# Central
bash scan-central-farmacia.sh | tee "$OUT/central.txt"

# Filiales Linux (1, 3, 4, 5)
for ip in 172.25.3.1 172.25.3.3 172.25.3.4 172.25.3.5; do
  bash scan-filial-linux.sh "$ip" | tee "$OUT/filial-$(echo $ip | cut -d. -f4).txt"
done

# Filial Windows (2)
pwsh ./scan-filial-windows.ps1 -IP 172.25.3.2 | tee "$OUT/filial-2.txt"
```

Duración: 10-30s por host. Output: 80-200 líneas por host.

## Estructura actual de `scans/`

```
scans/
├── README.md                                  (procedimiento)
├── scan-central-farmacia.sh                   (script)
├── scan-filial-linux.sh                       (script)
├── scan-filial-windows.ps1                    (script)
├── farmacia-2026-04-21/                       (PRE-migración, tracked en git con REPORTE.md)
│   ├── REPORTE.md                             ← evidencia GO/NO-GO de la migración
│   ├── central.txt
│   └── filial-{1..5}.txt
└── post-cutover-2026-04-22/                   (POST-migración, baseline de estado sano)
    ├── central.txt
    ├── central-pg.txt
    └── filial-{1..5}.txt
```

## Lo que los scripts capturan (scan-filial-linux.sh)

Secciones principales del output:

- **HOSTNAME / OS** — distro + versión.
- **Prereq binarios** — Java version, jq, curl, flock (flock es crítico para el cron concurrente).
- **PostgreSQL cluster** — puerto, DB existente.
- **GRANT pg_subscription** — permisos del user `franco` para leer `pg_subscription`.
- **Systemd units FRC** — `frc.service` status.
- **Paths legacy vs CI/CD pool** — `/home/franco/FRC/` vs `/opt/frc-filial/`.
- **.env / application.properties** — presencia.
- **Versión actual** — `.current-version` + actuator/info.
- **Canal / filial-id / token** — archivos de identidad.
- **check-update.sh instalado** — existencia y permisos.
- **Cron** — entries de `franco` y root que refieren `check-update`.
- **Replication** — publications + subscriptions existentes.
- **Logs recientes** — tail de `update.log`.

**Secciones que requieren sudo password** (PG interno, pg_catalog.pg_subscription, slots) fallan silenciosamente en SSH no-interactivo con `sudo: a password is required`. Para cubrirlas hay que hacer `ssh -t franco@<IP> sudo -i` y correr manualmente, o usar el fix del gotcha sudoers primero.

## Transferencia de DBs entre hosts

Para dry-runs o staging que requieran copiar una DB de un host a otro:

- **NO usar pipe raw cross-host** (`pg_dump | ssh | psql`) — extremadamente lento para DBs > 100 MB.
- **Usar `pg_dump -Fc`** (formato custom comprimido). Compresión típica ~13x (354 MB → 26 MB).
- **Flujo recomendado:**
  1. Dump en origen: `pg_dump -p <port> --no-publications --no-subscriptions -Fc <db> -f /tmp/<db>.dump`
  2. SCP al destino (o via máquina local como relay): `scp franco@<origen>:/tmp/<db>.dump franco@<destino>:<path>/`
  3. Restore local en destino: `pg_restore -p <port> -U franco -d <db> <path>/<db>.dump`
- Si origen y destino están en el **mismo host** (distintos clusters PG), el pipe directo funciona bien: `pg_dump -p 5551 ... | psql -p 5552 -d ...`

## Commit de los reportes

Los scans **están tracked en git** (no en .gitignore) como evidencia de auditoría. Tras un escaneo importante:

```bash
cd /Users/gabfranck/workspace/frc-sistemas-informaticos/frc-cicd
git add scans/<topic>-<fecha>/
git commit -m "scan(<topic>): inventario <fecha>"
git push
```

No contienen secretos (passwords, tokens) — los scripts son solo-lectura y nunca leen `.github-token` ni `.env`.

## Política de retención

- **Scripts y README**: permanentes (código).
- **Reportes con REPORTE.md** (e.g. `farmacia-2026-04-21/`): permanentes (evidencia de audit).
- **Snapshots sin REPORTE.md** (e.g. `post-cutover-2026-04-22/`): mantener ~3 meses. Si pasa ese tiempo sin consultarlo, archivar a `scans/_archive/` o eliminar.
- **Snapshots intermedios** (tipo "entre dos checkpoints"): eliminar inmediatamente si no tienen REPORTE.md asociado — son ruido.

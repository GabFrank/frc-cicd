# Scans — inventario previo a migración a beta

Scripts **solo lectura** que escanean los hosts de farmacia (central + 5 filiales) y reportan el estado actual contra los prereqs de los runbooks. No modifican nada. Output va a archivo, se revisa, se arman los blockers, recién después se planifica ventana de mantenimiento.

## Hosts

| # | Host | IP | Script | User SSH |
|---|---|---|---|---|
| 1 | Central farmacia | 172.25.1.200 (:8082) | `scan-central-farmacia.sh` | `franco` |
| 2 | Filial 1 linux | 172.25.3.1 | `scan-filial-linux.sh 172.25.3.1` | `franco` |
| 3 | Filial 2 windows | 172.25.3.2 | `scan-filial-windows.ps1 -IP 172.25.3.2` | `franco` |
| 4 | Filial 3 windows | 172.25.3.3 | `scan-filial-windows.ps1 -IP 172.25.3.3` | `franco` |
| 5 | Filial 4 linux | 172.25.3.4 | `scan-filial-linux.sh 172.25.3.4` | `franco` |
| 6 | Filial 5 linux | 172.25.3.5 | `scan-filial-linux.sh 172.25.3.5` | `franco` |

## Ejecución

Desde tu Mac, dentro de `frc-cicd/scans/`:

```bash
# Un directorio por día
OUT="farmacia-$(date +%F)"
mkdir -p "$OUT"

# Central
bash scan-central-farmacia.sh | tee "$OUT/central.txt"

# Filiales Linux (1, 4, 5)
for ip in 172.25.3.1 172.25.3.4 172.25.3.5; do
  bash scan-filial-linux.sh "$ip" | tee "$OUT/filial-$(echo $ip | cut -d. -f4).txt"
done

# Filiales Windows (2, 3) — desde PowerShell o pwsh
pwsh ./scan-filial-windows.ps1 -IP 172.25.3.2 | tee "$OUT/filial-2.txt"
pwsh ./scan-filial-windows.ps1 -IP 172.25.3.3 | tee "$OUT/filial-3.txt"
```

Cada script tarda 10-30s. Output típico: 80-200 líneas por host.

## Qué mirar en cada sección

| Sección | OK si … | Blocker si … | Runbook |
|---|---|---|---|
| HOSTNAME / OS | aparece nombre y versión | error de SSH | — |
| Prereq binarios | Java 17+, jq, curl, flock presentes | Java 8, jq missing | `runbook-migracion-filial-linux-beta.md` §Phase 0 |
| PostgreSQL cluster | puerto esperado (5551 central / 5432 filial), DB `general` o `farmacia` existe | cluster parado | central-beta §Pre-checklist |
| GRANT pg_subscription | `true` | `false` → `GRANT SELECT ON pg_catalog.pg_subscription TO franco;` | filial §Permiso |
| Systemd unit | `active (running)`, unit existe | servicio caído, unit ausente | central §Phase A o filial §systemd |
| Paths | pool `/opt/frc-...` existe | solo path legacy `/home/franco/FRC/` | Phase A o filial §layout |
| .env | EXISTS | MISSING → crear con vars de `application.properties` legacy | filial §`.env` |
| Canal / filial-id / token | los 3 existen | alguno falta | filial §bootstrap |
| check-update.sh/.ps1 | EXISTS | MISSING → copiar `scripts/check-update.{sh,ps1}` | filial §scripts |
| Cron / Task Scheduler | entry cada 15 min a `check-update.*` | sin entry → configurar | filial §cron |
| Replication | pubs + subs existen y streaming | subs deshabilitadas, slots muertos | runbook filial §Phase 0 |
| empresarial.sucursal (central) | IPs apuntan a filiales de producción correctas | IPs clonadas de piloto que no son | central-beta §Schedulers |

## Tabla matriz consolidada

Tras correr los scripts, poblar esta tabla en `farmacia-YYYY-MM-DD/REPORTE.md`:

| Host | Java | jq | PG port | GRANT subs | Pool CI/CD | .env | check-update | Cron | Pub/Sub | Blocker principal |
|---|---|---|---|---|---|---|---|---|---|---|
| Central farmacia | ? | — | ? | ? | ? | ? | — | — | ? | ? |
| Filial 1 | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Filial 2 (win) | ? | — | ? | ? | ? | ? | ? (ps1) | ? (Task) | ? | ? |
| Filial 3 (win) | ? | — | ? | ? | ? | ? | ? (ps1) | ? (Task) | ? | ? |
| Filial 4 | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |
| Filial 5 | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |

Para cada "?" reemplazar con:
- `OK` si el prereq está
- `FALTA: <acción>` con 1 línea de qué hacer y link al runbook

### Plantilla REPORTE.md

```markdown
# Reporte de escaneo Farmacia — YYYY-MM-DD

## Resumen
- Hosts escaneados: 6/6
- Blockers críticos: X
- Blockers menores: Y
- Estado general: READY / NEEDS_FIXES

## Matriz por host
(tabla de arriba completa)

## Blockers críticos (bloquean migración)
1. [Host] — [qué] — [fix]
...

## Blockers menores (pre-migración pero no blocking)
1. [Host] — [qué] — [fix]
...

## Desviaciones del runbook
(cualquier cosa que no aparezca en el runbook y que requiera nota)

## Recomendación
[ ] GO para Phase A central (runbook-migracion-central-beta.md)
[ ] NO-GO — resolver primero: ...
```

## Criterios de cierre del escaneo (Fase 12b del plan maestro)

- [ ] 6 scripts ejecutados
- [ ] `REPORTE.md` escrito y revisado por LT
- [ ] Lista de fixes pre-migración identificada
- [ ] Ventana de mantenimiento propuesta para central farmacia

Al terminar, commit a `frc-cicd`:

```bash
cd frc-cicd
git add scans/farmacia-YYYY-MM-DD/
git commit -m "scan(farmacia): inventario pre-migracion beta YYYY-MM-DD"
git push
```

Los reportes quedan trackeados como evidencia de la preparación.

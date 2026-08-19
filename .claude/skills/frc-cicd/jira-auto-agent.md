# Jira Auto-Agent — resolución automatizada de issues

Sistema que conecta Jira → GitHub → Claude Code Routines para resolver tickets automáticamente. Implementado 2026-04-29.

## Flujo end-to-end

```
1. Dev crea ticket en Jira con Resolution Mode = Auto-Agent
2. Dev mueve ticket a EN CURSO
3. Jira Automation valida condiciones y dispara repository_dispatch al repo GitHub
4. jira-receiver.yml (GitHub Actions) crea Issue con label jira-auto
5. Claude Code Routine (cloud, plan Max) se dispara por GitHub trigger "Issue opened"
6. Claude analiza, implementa, corre tests, abre PR draft a develop (o comenta si no puede)
7. Humano revisa PR. Claude nunca mergea.
```

## Componentes

### 1. Jira Automation Rule: `Auto-Agent: dispatch Claude Code`

**Proyecto:** frc-desktop (FD) — scope `project/10007`
**Trigger:** campo `Estado` cambia (transicion) → condiciones:
- Estado = `In Progress`
- Resolution Mode = `Auto-Agent`
- Acceptance Criteria no vacia
- Target Repository contiene alguno de `central, filial, desktop, mobile`

**Accion:** crea variable `repoName` via `.replace()` chain que mapea valores del checkbox multi-select a nombres de repos GitHub:
- `central` → `franco-system-backend-servidor`
- `filial` → `franco-system-backend-filial`
- `desktop` → `frc-sistemas-integrados-angular`
- `mobile` → `frc-mobile`

Luego envia POST a `https://api.github.com/repos/GabFrank/{{repoName}}/dispatches` con `event_type: "jira-issue"` y payload con issueKey, summary, description, criteria, etc.

**Limitacion conocida:** `.replace()` chain no funciona para multi-select simultaneo (central+filial). Solo funciona bien con un repo seleccionado a la vez. Multi-repo real requiere loop o 4 reglas separadas (V2).

**Export de la regla:** `frc-cicd/jira/automation-rule-019dd58f-*.json`

### 2. GitHub Actions Workflow: `jira-receiver.yml`

Deployado en los 4 repos (en `master` desde 2026-04-28).

- Recibe `repository_dispatch` tipo `jira-issue`
- Valida `client_payload.token` contra secret `JIRA_WEBHOOK_TOKEN`
- Crea GitHub Issue con titulo `[JIRA-KEY] summary`, label `jira-auto`, y body con instrucciones para Claude

Body incluye 8 reglas explicitas: branch naming (`auto/<key>-<slug>` desde develop), respetar CLAUDE.md, correr tests, no abrir PR si confianza baja, PR draft con Conventional Commits, nunca mergear, nunca push directo.

### 3. Claude Code Routines (cloud)

4 Routines creadas en claude.ai/code/routines, una por repo. Nombre: `Jira Auto-Fix`.

**Trigger:** GitHub event "Issue opened" con filtro label `jira-auto`, por repo.
**Repositorios:** los 4 repos conectados.
**Modelo:** Opus (configurable en la Routine).
**Limite:** 15 ejecuciones/dia en plan Max.

Pipeline de 3 fases (definido en el prompt de la Routine):
1. **Analyze & Plan** — lee CLAUDE.md, explora codebase, identifica root cause
2. **Implement** — crea branch `auto/*` desde develop, implementa, corre tests
3. **Review & PR** — revisa sus propios cambios, abre PR draft a develop o comenta si no puede

### 4. Watcher local (fallback, no activo)

`frc-cicd/scripts/claude-watcher.sh` — script bash que pollea GitHub por issues con label `jira-auto` y ejecuta Claude Code CLI localmente. Pipeline multi-modelo (Opus plan → Sonnet code → Opus review).

`frc-cicd/scripts/claude-watcher-start.sh` — launcher tmux con start/stop/status/logs/attach.

**No esta activo.** Queda como fallback si las 15 Routines/dia no alcanzan.

## Custom fields en Jira

| Campo | Tipo | Obligatorio | Valores |
|---|---|---|---|
| Target Repository | Multi-checkbox | Si para Auto-Agent | central, filial, desktop, mobile |
| Resolution Mode | Select (dropdown) | Si | Auto-Agent, Manual-Human |
| Acceptance Criteria | Textarea | Si para Auto-Agent | Texto libre |

## Labels en GitHub (los 4 repos)

| Label | Color | Significado |
|---|---|---|
| `jira-auto` | default | Issue creado por jira-receiver.yml, pendiente de procesamiento |
| `claude-processing` | #8b5cf6 | Watcher local procesando (solo si se usa el fallback) |
| `claude-done` | #22c55e | Watcher local completado (solo fallback) |
| `claude-failed` | #ef4444 | Watcher local fallido (solo fallback) |

## Secrets en GitHub (los 4 repos)

| Secret | Uso |
|---|---|
| `JIRA_WEBHOOK_TOKEN` | Validacion del dispatch en jira-receiver.yml |

Token: almacenado en `frc-cicd/.env` bajo `JIRA_WEBHOOK_TOKEN`.

## Secrets en Jira

| Dato | Donde |
|---|---|
| GitHub PAT (Bearer en webhook) | Header `Authorization` de la regla (marcado como Oculto) |

PAT: almacenado en `frc-cicd/.env` bajo `JIRA_PAT`.

## Lo que NUNCA hacer

1. Setear "Allow unrestricted branch pushes" sin verificar que el prompt prohiba push a master/develop/release
2. Mergear PRs del auto-agent sin revision humana
3. Eliminar label `jira-auto` de un issue antes de que la Routine lo procese
4. Poner credenciales reales en Acceptance Criteria (la Routine tiene acceso pero los issues son publicos)

## Troubleshooting

### Jira dispara pero no llega issue a GitHub
- Revisar historial de la regla en Jira Automation
- Error 400 "Problems parsing JSON" → algun smart value genera JSON invalido (comillas sin escapar en description). **Fix aplicado 2026-04-30:** agregar `.jsonEncode` a `summary`, `description` y `criteria` en el customBody de la regla Jira. Sin este sufijo, cualquier ticket con comillas o saltos de linea en description rompe el dispatch.
- Error 404 → PAT sin scope `repo` o repo name mal escrito en `.replace()` chain

### Issue se crea pero Routine no se dispara
- Verificar que Claude GitHub App esta instalada en el repo
- Verificar que la Routine tiene trigger configurado para ese repo especifico
- Verificar label `jira-auto` esta presente (la Routine filtra por label)
- Verificar limite de 15/dia no agotado

### Routine se dispara pero no abre PR
- Comportamiento correcto si: ticket de prueba, confianza baja, tests fallan, toca multiples repos
- Revisar comentario que Claude deja en el issue explicando por que no abrio PR

### PR del auto-agent no se identifica como generado por IA
- **Problema encontrado 2026-04-30 (primer run real FD-146):** PR no era draft, no tenia label `auto-agent`, usó `fix:` en vez de `feat:`, sin `Co-Authored-By` trailer.
- **Fix aplicado:** instrucciones del issue body en `jira-receiver.yml` actualizadas (reglas 5, 7, 8) para exigir: prefijo correcto segun tipo de cambio, label `auto-agent` en PR, `Co-Authored-By` trailer, footer `Generated by Claude Code (auto-agent)`.
- Si la Routine sigue ignorando alguna regla, el prompt de la Routine en claude.ai/code/routines tambien debe reforzar esa regla.

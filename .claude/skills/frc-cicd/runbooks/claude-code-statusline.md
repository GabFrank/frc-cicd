# Statusline de Claude Code (entorno dev FRC)

Statusline custom del terminal de Claude Code. Muestra modelo, output style, barra de contexto, rate limit 5h y estado git **con nombre de repo + branch**:

```
Opus 5 | ███░░░░░░░ 37% | 5h:22% rst:2h14m | frc-comercial-central - release/beta *3 ↑45
```

Formato git: `{repo} - {branch} *{dirty} ↑{ahead} ↓{behind}`.
Útil cuando hay varias sesiones abiertas contra repos distintos (central, filial, desktop, mobile, frc-cicd): antes solo se veía el branch y `release/beta` es idéntico en los 4 repos.

## Instalación

1. Guardar el script como `~/.claude/statusline.sh` y `chmod +x`.
2. En `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "~/.claude/statusline.sh",
  "padding": 1,
  "refreshInterval": 15
}
```

Dep: `jq`. Aplica a sesiones nuevas o al próximo refresh (15s).

## Script

```bash
#!/usr/bin/env bash
# Claude Code statusline — modelo, ctx %, rate limit, git
# Deps: jq

set -euo pipefail

input=$(cat)

MODEL=$(printf '%s' "$input" | jq -r '.model.display_name // "?"')
DIR=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // ""')
SESSION_ID=$(printf '%s' "$input" | jq -r '.session_id // "default"')
PCT=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
OUTPUT_STYLE=$(printf '%s' "$input" | jq -r '.output_style.name // empty')

# Rate limits (Pro/Max only)
FIVE_H_PCT=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
FIVE_H_RESET=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')

RATE_STR=""
if [ -n "$FIVE_H_PCT" ] && [ -n "$FIVE_H_RESET" ]; then
  NOW=$(date +%s)
  SECS_LEFT=$(( FIVE_H_RESET - NOW ))
  if [ "$SECS_LEFT" -gt 0 ]; then
    MINS_LEFT=$(( SECS_LEFT / 60 ))
    if [ "$MINS_LEFT" -ge 60 ]; then
      TIME_LEFT="$(( MINS_LEFT / 60 ))h$(( MINS_LEFT % 60 ))m"
    else
      TIME_LEFT="${MINS_LEFT}m"
    fi
  else
    TIME_LEFT="reset"
  fi
  RATE_PCT=${FIVE_H_PCT%.*}
  [ -z "$RATE_PCT" ] && RATE_PCT=0
  RATE_STR=" | 5h:${RATE_PCT}% rst:${TIME_LEFT}"
fi

# Git con cache 5s por session
CACHE_FILE="/tmp/claude-statusline-git-${SESSION_ID}"
CACHE_MAX_AGE=5

cache_is_stale() {
  [ ! -f "$CACHE_FILE" ] && return 0
  MTIME=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - MTIME )) -gt $CACHE_MAX_AGE ]
}

if cache_is_stale; then
  if [ -n "$DIR" ] && git -C "$DIR" rev-parse --git-dir >/dev/null 2>&1; then
    BRANCH=$(git -C "$DIR" branch --show-current 2>/dev/null || git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo "?")
    DIRTY=$(git -C "$DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    AB=$(git -C "$DIR" rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null || echo "0	0")
    BEHIND=$(printf '%s' "$AB" | cut -f1)
    AHEAD=$(printf '%s' "$AB" | cut -f2)
    # Nombre repo: remote origin (owner/repo -> repo), fallback a dir raiz del worktree
    REMOTE=$(git -C "$DIR" remote get-url origin 2>/dev/null || echo "")
    if [ -n "$REMOTE" ]; then
      REPO=$(basename "${REMOTE%.git}")
    else
      TOP=$(git -C "$DIR" rev-parse --show-toplevel 2>/dev/null || echo "")
      REPO=$([ -n "$TOP" ] && basename "$TOP" || echo "")
    fi
    printf '%s|%s|%s|%s|%s' "$BRANCH" "$DIRTY" "$AHEAD" "$BEHIND" "$REPO" > "$CACHE_FILE"
  else
    printf '||||' > "$CACHE_FILE"
  fi
fi

GIT_STR=""
if [ -f "$CACHE_FILE" ]; then
  IFS='|' read -r GIT_BRANCH GIT_DIRTY GIT_AHEAD GIT_BEHIND GIT_REPO < "$CACHE_FILE" || true
  if [ -n "$GIT_BRANCH" ]; then
    if [ -n "${GIT_REPO:-}" ]; then
      GIT_STR=" | \033[35m${GIT_REPO}\033[0m \033[90m-\033[0m \033[36m${GIT_BRANCH}\033[0m"
    else
      GIT_STR=" | \033[36m${GIT_BRANCH}\033[0m"
    fi
    [ "${GIT_DIRTY:-0}" -gt 0 ] && GIT_STR="${GIT_STR} \033[33m*${GIT_DIRTY}\033[0m"
    [ "${GIT_AHEAD:-0}" -gt 0 ]  && GIT_STR="${GIT_STR} \033[32m↑${GIT_AHEAD}\033[0m"
    [ "${GIT_BEHIND:-0}" -gt 0 ] && GIT_STR="${GIT_STR} \033[31m↓${GIT_BEHIND}\033[0m"
  fi
fi

# Barra contexto
PCT_INT=${PCT:-0}
FILLED=$(( PCT_INT / 10 ))
EMPTY=$(( 10 - FILLED ))
BAR=""
if [ "$FILLED" -gt 0 ]; then
  printf -v F "%${FILLED}s" ""
  BAR="${F// /█}"
fi
if [ "$EMPTY" -gt 0 ]; then
  printf -v E "%${EMPTY}s" ""
  BAR="${BAR}${E// /░}"
fi

if   [ "$PCT_INT" -ge 90 ]; then CTX_COLOR='\033[31m'
elif [ "$PCT_INT" -ge 70 ]; then CTX_COLOR='\033[33m'
else                              CTX_COLOR='\033[32m'
fi
RESET='\033[0m'
BOLD='\033[1m'

STYLE_STR=""
[ -n "$OUTPUT_STYLE" ] && [ "$OUTPUT_STYLE" != "default" ] && STYLE_STR=" | ${OUTPUT_STYLE}"

printf '%b' "${BOLD}${MODEL}${RESET}${STYLE_STR} | ${CTX_COLOR}${BAR} ${PCT_INT}%${RESET}${RATE_STR}${GIT_STR}"
```

## Cómo se resuelve el nombre del repo

1. `git remote get-url origin` → basename sin `.git`. Sirve tanto para SSH (`git@github.com:frc-comercial/central.git`) como HTTPS.
2. Sin remote (repo local, worktree raro): basename de `git rev-parse --show-toplevel`.
3. Fuera de un repo git: no se imprime bloque git.

## Cache

El bloque git se cachea 5s en `/tmp/claude-statusline-git-<session_id>` para no correr 5 comandos git en cada refresh (15s + cada turno). Formato: `branch|dirty|ahead|behind|repo` (5 campos).

**Gotcha:** si venís de la versión vieja (4 campos, sin repo), los caches existentes se leen con `GIT_REPO` vacío → statusline cae al formato solo-branch hasta que el cache expira (≤5s). No requiere limpieza manual; si querés forzar: `rm -f /tmp/claude-statusline-git-*`.

## Test sin abrir sesión

```bash
echo '{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"/Users/gabfranck/workspace/frc-sistemas-informaticos/frc-comercial/central"},"session_id":"test","context_window":{"used_percentage":37.2}}' \
  | bash ~/.claude/statusline.sh; echo
```

Cambiar `current_dir` para probar otros repos; `session_id` distinto evita chocar con el cache de una sesión real.

## Notas

- `rate_limits` solo llega en planes Pro/Max; sin eso el bloque `5h:` no aparece.
- El script corre con `set -euo pipefail` en cada refresh: si falla, la statusline queda vacía. Probar siempre con el comando de test antes de dejarlo.
- Los repos FRC usan `master` + `release/beta` + `develop` en los 4 → el nombre de repo es lo único que distingue una sesión de otra a simple vista.

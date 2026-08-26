#!/usr/bin/env bash
# wa-agent-watchdog — detecta el wa-agent "vivo pero colgado" y lo reinicia.
#
# Modo de falla que cubre (visto el 2026-08-25): el proceso sigue corriendo, así
# que el KeepAlive del LaunchAgent lo da por sano, pero el loop de adentro está
# muerto: 5 h sin una línea de log y sin un solo socket abierto.
#
# Cómo distingue "colgado" de "tranquilo": un loop vivo consulta la API cada
# ~15 s, así que abre conexiones. Cero conexiones en la ventana de muestreo Y
# log mudo = colgado. Si el log tiene errores recientes, el loop está vivo
# (fallando, pero vivo) y no se toca.
#
# Antes de reiniciar nada, chequea el servidor: si el socket de Evolution está
# caído, el problema NO es el demonio y reiniciarlo no arregla nada.
#
# Uso:  wa-agent-watchdog            # diagnostica
#       wa-agent-watchdog --reparar  # reinicia si está colgado
set -uo pipefail

LABEL="com.frc.wa-agent"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/.claude/logs/wa-agent.log"
VENTANA="${WA_WATCHDOG_VENTANA:-60}"     # segundos de muestreo de red
MUDO_MIN="${WA_WATCHDOG_MUDO_MIN:-10}"   # minutos de log mudo para sospechar
REPARAR=0
[ "${1:-}" = "--reparar" ] && REPARAR=1

pid=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')
if [ -z "${pid:-}" ]; then
  echo "wa-agent: NO está corriendo"
  [ "$REPARAR" -eq 1 ] && {
    launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1 && echo "arrancado"; }
  exit 1
fi
echo "wa-agent: pid $pid"

# Aviso de escritorio: cuando el caído es el servidor no se puede avisar por
# WhatsApp (es justo lo que no anda), y corriendo desde launchd nadie mira stderr.
avisar_escritorio() {
  osascript -e "display notification \"$1\" with title \"FRC · canal de WhatsApp\"" >/dev/null 2>&1 || true
}

# ¿El problema es el servidor y no el demonio? (la confusión del 2026-08-25)
if ! "$HOME/.claude/bin/wa-health" >/dev/null 2>&1; then
  echo "DIAGNÓSTICO: el socket de Evolution está caído — el demonio no es el problema." >&2
  echo "             reparar allá:  wa-health --reparar" >&2
  avisar_escritorio "Socket de Evolution caído: no se puede enviar. Reparar con wa-health --reparar"
  exit 2
fi

# Log mudo, en minutos
if [ -r "$LOG" ]; then
  mtime=$(stat -f %m "$LOG" 2>/dev/null || echo 0)
  mudo=$(( ( $(date +%s) - mtime ) / 60 ))
else
  mudo=999
fi
echo "log:      mudo hace ${mudo} min (umbral ${MUDO_MIN})"

# Muestreo de actividad de red del proceso
conex=0
fin=$(( $(date +%s) + VENTANA ))
while [ "$(date +%s)" -lt "$fin" ]; do
  n=$(lsof -p "$pid" -a -i 2>/dev/null | grep -c ESTABLISHED)
  conex=$(( conex + n ))
  [ "$conex" -gt 0 ] && break
  sleep 2
done
echo "red:      $conex conexiones en la ventana de ${VENTANA}s"

if [ "$conex" -gt 0 ]; then
  echo "estado:   SANO (el loop está consultando)"
  exit 0
fi
if [ "$mudo" -lt "$MUDO_MIN" ]; then
  echo "estado:   SANO (sin conexiones ahora, pero el log escribió recién)"
  exit 0
fi

echo "estado:   COLGADO — proceso vivo, loop muerto" >&2
[ "$REPARAR" -eq 1 ] || { echo "          reparar con: wa-agent-watchdog --reparar" >&2; exit 1; }

echo "reparando: bootout + bootstrap" >&2
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
sleep 3
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1
sleep 5
nuevo=$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk '/^\tpid = /{print $3}')
[ -n "${nuevo:-}" ] && { echo "reiniciado: pid $nuevo"; exit 0; }
echo "no arrancó — revisar ~/.claude/logs/wa-agent.err.log" >&2; exit 1

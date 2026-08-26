#!/usr/bin/env bash
# wa-health — verifica que el canal de WhatsApp pueda ENVIAR de verdad.
#
# Por qué existe: `connectionState` sale del Postgres de Evolution, no del socket
# real de Baileys. Puede decir "open" con el WebSocket muerto — pasó el 2026-08-25
# y el canal estuvo 7 h caído sin que ningún chequeo lo notara.
# Ver gotchas.md de la skill frc-cicd.
#
# Uso:
#   wa-health              # diagnostica, exit 0 sano / 1 caído
#   wa-health --reparar    # si está caído, reinicia el contenedor y reverifica
#   wa-health --avisar     # si está caído y luego se repara, manda un WhatsApp
set -uo pipefail

ENV_FILE="${WA_ENV:-$HOME/.claude/wa.env}"
[ -r "$ENV_FILE" ] || { echo "wa-health: no puedo leer $ENV_FILE" >&2; exit 2; }
set -a; . "$ENV_FILE"; set +a

VM_SSH="${WA_VM_SSH:-deploy@178.105.107.171}"
CONTENEDOR="${WA_CONTENEDOR:-evolution-api}"
REPARAR=0; AVISAR=0
for a in "$@"; do
  case "$a" in
    --reparar) REPARAR=1 ;;
    --avisar)  AVISAR=1 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "wa-health: opcion desconocida: $a" >&2; exit 2 ;;
  esac
done

estado_declarado() {
  curl -s --max-time 12 -H "apikey: $EVOLUTION_API_KEY" \
    "$EVOLUTION_URL/instance/connectionState/$EVOLUTION_INSTANCE" 2>/dev/null
}

# Probe REAL: /chat/whatsappNumbers consulta a WhatsApp por el socket de Baileys.
# No envía ningún mensaje. Si el socket está cerrado, no devuelve el jid.
socket_vivo() {
  local r
  r=$(curl -s --max-time 20 -X POST \
        -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" \
        -d "{\"numbers\":[\"$WA_DEFAULT_TO\"]}" \
        "$EVOLUTION_URL/chat/whatsappNumbers/$EVOLUTION_INSTANCE" 2>/dev/null)
  printf '%s' "$r" | grep -q '"exists"'
}

decl=$(estado_declarado)
echo "instancia:  $EVOLUTION_INSTANCE"
echo "declarado:  ${decl:-<sin respuesta>}"

if socket_vivo; then
  echo "socket:     VIVO — el canal puede enviar"
  exit 0
fi

echo "socket:     MUERTO — declarado 'open' pero no responde por Baileys" >&2
echo "            (esta es la falla del 2026-08-25: enviar da 500, leer sigue andando)" >&2

[ "$REPARAR" -eq 1 ] || {
  echo "            reparar con: wa-health --reparar" >&2
  exit 1
}

echo "reparando:  docker restart $CONTENEDOR en $VM_SSH" >&2
ssh -o ConnectTimeout=15 -o BatchMode=yes "$VM_SSH" "docker restart $CONTENEDOR" >/dev/null 2>&1 || {
  echo "            fallo el restart por ssh" >&2; exit 1; }

for i in $(seq 1 12); do
  sleep 5
  if socket_vivo; then
    echo "socket:     RECUPERADO tras $((i*5))s"
    [ "$AVISAR" -eq 1 ] && "$HOME/.claude/bin/wa-send" --sin-typing \
      "wa-health: el socket de Evolution estaba caido y se reparo reiniciando el contenedor." >/dev/null 2>&1
    exit 0
  fi
done

echo "socket:     SIGUE MUERTO tras el restart — puede necesitar QR nuevo" >&2
echo "            revisar: ssh $VM_SSH 'docker logs --since 5m $CONTENEDOR'" >&2
exit 1

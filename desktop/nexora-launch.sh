#!/usr/bin/env bash
# Lanzador de Nexora para el menú de aplicaciones:
# arranca el servidor si no está en marcha y abre el navegador.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${NEXORA_HOST:-127.0.0.1}"
PORT="${NEXORA_PORT:-8080}"
URL="http://${HOST}:${PORT}"

# ¿hay algo escuchando ya en el puerto? (sin dependencias externas)
is_up() { (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null; }

if ! is_up; then
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/nexora"
  mkdir -p "$STATE_DIR"
  # Arranca el servidor desacoplado de esta sesión.
  setsid nohup "${ROOT}/run.sh" >>"${STATE_DIR}/server.log" 2>&1 < /dev/null &
  # Espera hasta ~20 s a que levante.
  for _ in $(seq 1 40); do
    is_up && break
    sleep 0.5
  done
fi

# Abre la interfaz en el navegador por defecto.
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
elif command -v gio >/dev/null 2>&1; then
  gio open "$URL" >/dev/null 2>&1 &
fi

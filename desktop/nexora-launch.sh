#!/usr/bin/env bash
# Lanzador de Nexora para el menú de aplicaciones:
# arranca el servidor si no está en marcha y abre la ventana de la aplicación.
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

# Abre la interfaz como aplicación (ventana propia, sin navegador).
HERE="$(cd "$(dirname "$0")" && pwd)"

# 1) Ventana nativa GTK + WebKit (lo preferido: parece una app del sistema).
if python3 - <<'PY' >/dev/null 2>&1
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2  # noqa
PY
then
  exec python3 "$HERE/nexora-app.py" "$URL"
fi

# 2) Navegador de la familia Chromium en modo aplicación.
for b in brave-browser chromium chromium-browser google-chrome google-chrome-stable \
         microsoft-edge microsoft-edge-stable vivaldi vivaldi-stable; do
  if command -v "$b" >/dev/null 2>&1; then
    exec "$b" --app="$URL" --class=Nexora --name=nexora
  fi
done

# 3) Último recurso: navegador por defecto (pestaña normal).
if command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$URL"; fi

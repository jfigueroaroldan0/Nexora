#!/usr/bin/env bash
# Arranca el servidor de Nexora.
set -euo pipefail
cd "$(dirname "$0")"

if [[ -d .venv ]]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

HOST="${NEXORA_HOST:-127.0.0.1}"
PORT="${NEXORA_PORT:-8080}"

echo "Nexora escuchando en http://${HOST}:${PORT}"
exec uvicorn app.main:app --host "$HOST" --port "$PORT" "$@"

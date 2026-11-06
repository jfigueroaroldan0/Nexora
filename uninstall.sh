#!/usr/bin/env bash
# Desinstala Nexora.
#   ./uninstall.sh           -> quita el menú, el icono y para el servidor (conserva el código)
#   ./uninstall.sh --purge   -> además borra entorno virtual, datos y la propia carpeta del proyecto
#   ./uninstall.sh --yes     -> no pregunta
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/nexora"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/nexora"

PURGE=0; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    *) echo "Opción desconocida: $a"; exit 1 ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  if [ -t 0 ]; then
    read -r -p "$1 [s/N] " r
    [[ "$r" =~ ^[sSyY]$ ]]
  else
    echo "Ejecución no interactiva: añade --yes para confirmar." >&2
    return 1
  fi
}

echo "== Nexora :: desinstalación =="
if [ "$PURGE" = 1 ]; then
  confirm "--purge borrará menú, icono, entorno, DATOS y la carpeta del proyecto. ¿Continuar?" \
    || { echo "Cancelado."; exit 1; }
fi

# 1) Parar el servidor si está en marcha.
if pkill -f "uvicorn app.main:app" 2>/dev/null; then
  echo "-> servidor detenido"
else
  echo "-> el servidor no estaba en marcha"
fi

# 2) Quitar entrada de menú e iconos.
rm -f "$APPS/nexora.desktop"
rm -f "$ICONS/scalable/apps/nexora.svg"
for s in 48 64 128 256; do rm -f "$ICONS/${s}x${s}/apps/nexora.png"; done
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$ICONS" 2>/dev/null || true
echo "-> entrada de menú e icono eliminados"

# 3) (opcional) Borrado completo.
if [ "$PURGE" = 1 ]; then
  rm -rf "$ROOT/.venv" "$DATA" "$STATE"
  echo "-> entorno virtual, base de datos y logs eliminados"
  echo "-> eliminando la carpeta del proyecto: $ROOT"
  cd /
  rm -rf "$ROOT"
  echo "Nexora desinstalado por completo."
else
  echo
  echo "Nexora quitado del sistema (menú, icono y servidor)."
  echo "El código sigue en: $ROOT"
  echo "Para borrarlo TODO (entorno, datos y carpeta): ./uninstall.sh --purge"
fi

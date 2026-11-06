#!/usr/bin/env bash
# Añade Nexora al menú de aplicaciones del usuario (entrada .desktop + icono).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
LAUNCHER="$HERE/nexora-launch.sh"

echo "== Nexora :: instalar en el menú de aplicaciones =="

chmod +x "$LAUNCHER" "$ROOT/run.sh" 2>/dev/null || true
mkdir -p "$APPS"

SRC_PNG="$HERE/nexora.png"   # icono rasterizado propio (preferente)
SRC_SVG="$HERE/nexora.svg"   # icono vectorial de reserva

install_size() {
  local size="$1"
  local out="$ICONS/${size}x${size}/apps/nexora.png"
  mkdir -p "$(dirname "$out")"
  if [ -f "$SRC_PNG" ]; then
    if command -v convert >/dev/null 2>&1; then
      convert "$SRC_PNG" -resize "${size}x${size}" "$out" && return 0
    fi
    cp "$SRC_PNG" "$out" && return 0
  elif command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$SRC_SVG" -o "$out" && return 0
  elif command -v convert >/dev/null 2>&1; then
    convert -background none -resize "${size}x${size}" "$SRC_SVG" "$out" && return 0
  fi
  return 1
}

if [ -f "$SRC_PNG" ]; then
  # Quita el SVG antiguo del tema para que no compita con el icono PNG.
  rm -f "$ICONS/scalable/apps/nexora.svg"
  for s in 512 256 128 64 48; do install_size "$s" || true; done
  echo "-> icono instalado (PNG en varios tamaños)"
elif [ -f "$SRC_SVG" ]; then
  mkdir -p "$ICONS/scalable/apps"
  cp "$SRC_SVG" "$ICONS/scalable/apps/nexora.svg"
  for s in 256 128 64 48; do install_size "$s" || true; done
  echo "-> icono instalado (SVG + PNG)"
fi

# Entrada .desktop con la ruta real del lanzador.
sed "s|__EXEC__|$LAUNCHER|g" "$HERE/nexora.desktop.in" > "$APPS/nexora.desktop"
chmod 644 "$APPS/nexora.desktop"

# Refresca cachés del escritorio (sin fallar si no están las herramientas).
command -v desktop-file-validate >/dev/null 2>&1 && desktop-file-validate "$APPS/nexora.desktop" || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$ICONS" 2>/dev/null || true

echo
echo "Hecho. Busca «Nexora» en el menú de aplicaciones."
echo "(Si no aparece al momento, cierra y abre la sesión o reinicia el panel.)"

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
mkdir -p "$APPS" "$ICONS/scalable/apps"

# Icono vectorial.
cp "$HERE/nexora.svg" "$ICONS/scalable/apps/nexora.svg"

# Iconos PNG en varios tamaños si hay un conversor disponible (mejor compatibilidad).
render_png() {
  local size="$1" out="$ICONS/${1}x${1}/apps/nexora.png"
  mkdir -p "$(dirname "$out")"
  if command -v rsvg-convert >/dev/null 2>&1; then
    rsvg-convert -w "$size" -h "$size" "$HERE/nexora.svg" -o "$out" && return 0
  elif command -v inkscape >/dev/null 2>&1; then
    inkscape "$HERE/nexora.svg" -w "$size" -h "$size" -o "$out" >/dev/null 2>&1 && return 0
  elif command -v convert >/dev/null 2>&1; then
    convert -background none -resize "${size}x${size}" "$HERE/nexora.svg" "$out" && return 0
  fi
  return 1
}
if render_png 128; then
  for s in 48 64 256; do render_png "$s" || true; done
  echo "-> iconos PNG generados"
else
  echo "-> sin conversor SVG→PNG; se usará el icono vectorial"
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

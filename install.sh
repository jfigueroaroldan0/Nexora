#!/usr/bin/env bash
# Instalador de Nexora: crea el entorno virtual y las dependencias de Python.
set -euo pipefail

cd "$(dirname "$0")"

echo "== Nexora :: instalación =="

# Dependencias del sistema recomendadas (Debian/Ubuntu). Se instalan con --deps.
SYS_DEPS=(python3-venv python3-libvirt python3-psutil libvirt-clients lxc)

if [[ "${1:-}" == "--deps" ]]; then
  echo "-> Instalando dependencias del sistema (sudo apt)..."
  sudo apt-get update
  sudo apt-get install -y "${SYS_DEPS[@]}"
fi

# Aviso si faltan utilidades clave (no bloquea: cada backend se degrada solo).
for bin in virsh docker lxc-ls; do
  command -v "$bin" >/dev/null 2>&1 || echo "   aviso: '$bin' no está en el PATH (ese backend quedará inactivo)"
done

echo "-> Creando entorno virtual (.venv) con acceso a los paquetes del sistema..."
python3 -m venv --system-site-packages .venv
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip >/dev/null
python -m pip install -r requirements.txt

echo
echo "Listo. Arranca Nexora con:"
echo "    ./run.sh"
echo "y abre http://127.0.0.1:8080 en el navegador."

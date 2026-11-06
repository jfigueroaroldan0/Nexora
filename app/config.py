"""Configuración de Nexora leída de variables de entorno."""
from __future__ import annotations

import os
from pathlib import Path

# Directorio de datos (base de datos SQLite con las etiquetas/módulos/notas).
DATA_DIR = Path(os.environ.get("NEXORA_DATA_DIR", Path.home() / ".local/share/nexora"))
DB_PATH = Path(os.environ.get("NEXORA_DB", DATA_DIR / "nexora.db"))

# Servidor — por defecto solo accesible desde la propia máquina.
HOST = os.environ.get("NEXORA_HOST", "127.0.0.1")
PORT = int(os.environ.get("NEXORA_PORT", "8080"))

# Conexión a libvirt (KVM/QEMU).
LIBVIRT_URI = os.environ.get("NEXORA_LIBVIRT_URI", "qemu:///system")

# LXC clásico: los contenedores de sistema suelen ser de root, así que las
# órdenes lxc-* se ejecutan con sudo salvo que se desactive.
LXC_SUDO = os.environ.get("NEXORA_LXC_SUDO", "1") not in ("0", "false", "no")

# Lista blanca de backends activos (por si quieres desactivar alguno).
ENABLED_BACKENDS = {
    b.strip()
    for b in os.environ.get("NEXORA_BACKENDS", "kvm,docker,lxc").split(",")
    if b.strip()
}

DATA_DIR.mkdir(parents=True, exist_ok=True)

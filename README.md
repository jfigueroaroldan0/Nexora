<div align="center">

# Nexora

**Un único panel web para gestionar máquinas KVM/QEMU, contenedores Docker y LXC, clasificadas por módulo del grado.**

</div>

Nexora reúne en una sola interfaz las máquinas virtuales de **libvirt/KVM**, los contenedores **Docker** y los contenedores **LXC clásico** de un anfitrión, con métricas del host, consola web, gestión de redes y un sistema propio de **etiquetas por módulo/asignatura**. Pensado para laboratorios docentes: ejecuta en local y se ata por defecto a `127.0.0.1`.

![estado](https://img.shields.io/badge/estado-v0.1-blue) ![licencia](https://img.shields.io/badge/licencia-MIT-green)

---

## Características

| Área | Qué hace |
|------|----------|
| **Inventario unificado** | Lista en vivo de KVM + Docker + LXC con tipo, CPU, RAM, IP, estado y descripción |
| **Buscador y filtros** | Por nombre, IP, etiqueta o descripción; y por estado, tipo y módulo |
| **Ciclo de vida** | Arrancar, apagar, reiniciar, forzar apagado, pausar y reanudar |
| **Módulos/asignaturas** | Etiqueta cada máquina con un módulo (desplegable por fila), persistido en SQLite |
| **Métricas del host** | CPU, RAM y disco del anfitrión (psutil) |
| **Ficha de máquina** | Características, discos, interfaces y usuarios `/etc/passwd` (vía guest-agent / exec / lxc-attach) |
| **Redes** | Redes de libvirt y Docker con modo, CIDR, puerta de enlace, DHCP y máquinas conectadas |
| **Consola web** | Terminal real sobre WebSocket: consola serie (KVM), `exec` (Docker), `lxc-attach` (LXC) |

### Pendiente (próximas iteraciones)

Crear máquinas (KVM desde ISO/clonar/qcow2+cloud-init, LXC desde `lxc-download`, Docker con puertos/volúmenes), snapshots, añadir/ampliar/quitar discos, cambiar IPs e interfaces desde la UI, pantalla gráfica con **virt-viewer** (fichero `.vv`) y exportación de un módulo a Markdown. La estructura ya está preparada para añadirlas.

---

## Arquitectura

```
Navegador  ──HTTP/WebSocket──►  FastAPI (app/main.py)
                                   │
                 ┌─────────────────┼─────────────────┐
                 ▼                 ▼                 ▼
            KvmBackend        DockerBackend      LxcBackend
            (libvirt)         (docker SDK)       (lxc-* + sudo)
                 │                 │                 │
            qemu:///system    /var/run/docker   /var/lib/lxc
                 └──────── manager + SQLite (módulos/notas/etiquetas) ────────┘
```

- **Backend:** Python + FastAPI, un proceso. Métricas con `psutil`.
- **Frontend:** HTML/CSS/JS sin framework ni build, servido por el propio FastAPI. Terminal con [xterm.js].
- **Persistencia:** SQLite (`~/.local/share/nexora/nexora.db`) solo para los metadatos propios (módulo, descripción, notas, etiquetas). El estado real vive en cada backend.

---

## Requisitos

- Debian/Ubuntu con Python 3.11+.
- Acceso a los backends que quieras usar:
  - **KVM:** `libvirt` y `python3-libvirt` (`qemu:///system`). El usuario en el grupo `libvirt`.
  - **Docker:** daemon de Docker y el usuario en el grupo `docker`.
  - **LXC:** herramientas `lxc-*` (LXC clásico). Los contenedores de sistema son de root, así que Nexora usa `sudo` para las órdenes `lxc-*`.
- `python3-psutil` para las métricas.

Cada backend se degrada de forma independiente: si falta uno, el resto sigue funcionando.

---

## Instalación

```bash
git clone git@github.com:jfigueroaroldan0/Nexora.git
cd Nexora

# Opción A: instala también las dependencias del sistema (apt)
./install.sh --deps

# Opción B: si ya tienes libvirt/docker/lxc/psutil en el sistema
./install.sh
```

`install.sh` crea un entorno virtual `.venv` con `--system-site-packages` (para reutilizar `python3-libvirt` y `python3-psutil` del sistema) e instala el resto por pip.

---

## Uso

```bash
./run.sh
# Nexora escuchando en http://127.0.0.1:8080
```

Abre <http://127.0.0.1:8080>.

Como servicio systemd (opcional): edita `nexora.service`, cópialo a `/etc/systemd/system/` y:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nexora
```

### Configuración (variables de entorno)

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `NEXORA_HOST` | `127.0.0.1` | Interfaz donde escucha |
| `NEXORA_PORT` | `8080` | Puerto |
| `NEXORA_LIBVIRT_URI` | `qemu:///system` | URI de libvirt |
| `NEXORA_LXC_SUDO` | `1` | Usa `sudo` para las órdenes `lxc-*` |
| `NEXORA_BACKENDS` | `kvm,docker,lxc` | Backends activos |
| `NEXORA_DATA_DIR` | `~/.local/share/nexora` | Directorio de la base de datos |

### Seguridad

Nexora **no** trae autenticación: tiene control real sobre el host (crear/borrar nada todavía, pero sí arrancar/parar). Por eso escucha solo en `127.0.0.1`. Si lo expones a la red local (`NEXORA_HOST=0.0.0.0`), ponlo detrás de un proxy con autenticación.

---

## Menú de aplicaciones

Para tener Nexora como una aplicación más del sistema, con su icono:

```bash
./desktop/install-menu.sh
```

Instala la entrada `.desktop` y el icono en `~/.local/share`. Después busca **Nexora** en el menú de aplicaciones: al abrirla arranca el servidor (si no lo estaba) y abre la interfaz en una **ventana de aplicación propia** (GTK + WebKit, sin barra de navegador). Si no hay WebKit, usa un navegador de la familia Chromium en modo app (`--app`) y, como último recurso, el navegador por defecto.

## Desinstalación

```bash
./uninstall.sh          # quita el menú, el icono y para el servidor (conserva el código)
./uninstall.sh --purge  # además borra el entorno virtual, los datos y la carpeta del proyecto
```

---

## API

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Versión y backends disponibles |
| GET | `/api/metrics` | Métricas del host |
| GET | `/api/machines` | Inventario unificado |
| GET | `/api/machines/{id}` | Ficha de una máquina (`id` = `tipo:nombre`) |
| POST | `/api/machines/{id}/action` | `{ "op": "start\|stop\|reboot\|forceoff\|pause\|resume" }` |
| PATCH | `/api/machines/{id}` | Actualiza módulo/descripción/notas/etiquetas |
| GET | `/api/machines/{id}/users` | Usuarios `/etc/passwd` de dentro de la máquina |
| GET | `/api/networks` | Redes de todos los backends |
| GET | `/api/modules` | Módulos definidos |
| WS | `/ws/console/{id}` | Consola interactiva (PTY) |

---

## Desarrollo y tests

```bash
source .venv/bin/activate
pip install pytest httpx
pytest -q
```

Los tests no requieren libvirt/docker/lxc (los backends se simulan como no disponibles). CI en GitHub Actions ejecuta la suite en cada push.

---

## Licencia

MIT © 2026 Jesús Figueroa Roldán.

[xterm.js]: https://xtermjs.org/

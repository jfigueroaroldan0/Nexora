"""Nexora — API FastAPI y servidor estático."""
from __future__ import annotations

import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
import termios
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__, db, metrics
from .backends.base import BackendError
from .backends.manager import manager

app = FastAPI(title="Nexora", version=__version__)

STATIC_DIR = Path(__file__).parent / "static"


@app.middleware("http")
async def no_cache(request, call_next):
    """La interfaz se ve en una ventana WebKit que cachea de forma agresiva;
    al editar los estáticos (app.js/index.html/styles.css) la ventana seguía
    mostrando la versión vieja. Marcamos todo como no cacheable: en localhost
    el coste es nulo y cada recarga trae siempre la última versión."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


# ---- modelos de entrada ------------------------------------------------
class ActionBody(BaseModel):
    op: str


class MetaBody(BaseModel):
    module: str | None = None
    description: str | None = None
    notes: str | None = None
    tags: list[str] | None = None


class NetworkBody(BaseModel):
    backend: str | None = None
    name: str | None = None
    mode: str | None = None
    gateway: str | None = None
    prefix: str | None = None
    dhcp_start: str | None = None
    dhcp_end: str | None = None
    bridge: str | None = None
    cidr: str | None = None
    autostart: bool = True
    active: bool = True


class NetActionBody(BaseModel):
    op: str


class DiskResizeBody(BaseModel):
    size_gib: float


class DiskAddBody(BaseModel):
    size_gib: float
    pool: str | None = None
    format: str | None = None


class ResourcesBody(BaseModel):
    vcpus: int | None = None
    memory_mib: int | None = None


class NicBody(BaseModel):
    network: str
    model: str | None = None


class CreateVmBody(BaseModel):
    mode: str = "cloud"            # "cloud" | "normal"
    name: str
    vcpus: int = 1
    memory_mib: int = 1024
    disk_gib: float | None = None
    network: str | None = None
    # modo cloud
    base_image: str | None = None
    username: str | None = None
    password: str | None = None
    ssh_key: str | None = None
    hostname: str | None = None
    packages: str | None = None
    # modo normal (instalar desde ISO)
    iso: str | None = None
    firmware: str | None = None    # "bios" | "uefi"


# ---- API ---------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {"version": __version__, "backends": manager.available()}


@app.get("/api/metrics")
def get_metrics() -> dict:
    return metrics.host_metrics()


@app.get("/api/machines")
def list_machines() -> list:
    return manager.list_machines()


@app.get("/api/machines/{machine_id}")
def machine_detail(machine_id: str) -> dict:
    try:
        return manager.detail(machine_id)
    except BackendError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/machines/{machine_id}/action")
def machine_action(machine_id: str, body: ActionBody) -> dict:
    if body.op not in {"start", "stop", "reboot", "forceoff", "pause", "resume"}:
        raise HTTPException(status_code=400, detail=f"Operación no válida: {body.op}")
    try:
        manager.action(machine_id, body.op)
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Operación no implementada en este backend")
    return {"ok": True}


@app.patch("/api/machines/{machine_id}")
def machine_meta(machine_id: str, body: MetaBody) -> dict:
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    return manager.set_meta(machine_id, **fields)


@app.get("/api/pools")
def list_pools() -> list:
    return manager.storage_pools()


@app.get("/api/base-images")
def list_base_images() -> list:
    return manager.base_images()


@app.get("/api/isos")
def list_isos() -> list:
    return manager.isos()


@app.post("/api/machines")
def create_machine(body: CreateVmBody) -> dict:
    try:
        name = manager.create_vm(body.model_dump())
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite crear máquinas")
    return {"ok": True, "id": f"kvm:{name}"}


@app.post("/api/machines/{machine_id}/disks")
def machine_add_disk(machine_id: str, body: DiskAddBody) -> dict:
    if not body.size_gib or body.size_gib <= 0:
        raise HTTPException(status_code=400, detail="Tamaño no válido")
    try:
        manager.add_disk(machine_id, body.size_gib, body.pool, body.format or "qcow2")
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite añadir discos")
    return {"ok": True}


@app.post("/api/machines/{machine_id}/disks/{dev}/resize")
def machine_disk_resize(machine_id: str, dev: str, body: DiskResizeBody) -> dict:
    new_bytes = int(round(body.size_gib * (1024 ** 3)))
    if new_bytes <= 0:
        raise HTTPException(status_code=400, detail="Tamaño no válido")
    try:
        manager.resize_disk(machine_id, dev, new_bytes)
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite redimensionar discos")
    return {"ok": True}


@app.post("/api/machines/{machine_id}/resources")
def machine_resources(machine_id: str, body: ResourcesBody) -> dict:
    if body.vcpus is None and body.memory_mib is None:
        raise HTTPException(status_code=400, detail="No se indicó ningún recurso a cambiar")
    try:
        manager.set_resources(machine_id, body.vcpus, body.memory_mib)
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite cambiar los recursos")
    return {"ok": True}


@app.post("/api/machines/{machine_id}/nics")
def machine_add_nic(machine_id: str, body: NicBody) -> dict:
    if not body.network:
        raise HTTPException(status_code=400, detail="No se indicó la red")
    try:
        manager.attach_network(machine_id, body.network, body.model or "virtio")
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite añadir interfaces")
    return {"ok": True}


@app.delete("/api/machines/{machine_id}/nics/{mac}")
def machine_del_nic(machine_id: str, mac: str) -> dict:
    try:
        manager.detach_network(machine_id, mac)
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite quitar interfaces")
    return {"ok": True}


@app.get("/api/machines/{machine_id}/users")
def machine_users(machine_id: str) -> list:
    try:
        return manager.users(machine_id)
    except BackendError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="No implementado en este backend")


@app.get("/api/networks")
def list_networks() -> list:
    return manager.networks()


@app.post("/api/networks")
def create_network(body: NetworkBody) -> dict:
    spec = body.model_dump()
    if not spec.get("backend") or not spec.get("name"):
        raise HTTPException(status_code=400, detail="Faltan el backend o el nombre")
    try:
        manager.create_network(spec)
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite crear redes")
    return {"ok": True}


@app.patch("/api/networks/{backend}/{name}")
def edit_network(backend: str, name: str, body: NetworkBody) -> dict:
    try:
        manager.update_network(backend, name, body.model_dump())
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite editar redes")
    return {"ok": True}


@app.delete("/api/networks/{backend}/{name}")
def remove_network(backend: str, name: str) -> dict:
    try:
        manager.delete_network(backend, name)
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite borrar redes")
    return {"ok": True}


@app.post("/api/networks/{backend}/{name}/action")
def network_action(backend: str, name: str, body: NetActionBody) -> dict:
    try:
        manager.network_action(backend, name, body.op)
    except BackendError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except NotImplementedError:
        raise HTTPException(status_code=501, detail="Este backend no permite esa acción")
    return {"ok": True}


@app.get("/api/modules")
def list_modules() -> list:
    return db.list_modules()


@app.exception_handler(BackendError)
async def backend_error_handler(_request, exc: BackendError):  # pragma: no cover
    return JSONResponse(status_code=502, content={"detail": str(exc)})


# ---- consola por WebSocket (PTY real) ----------------------------------
@app.websocket("/ws/console/{machine_id}")
async def console(ws: WebSocket, machine_id: str) -> None:
    await ws.accept()
    try:
        argv = manager.console_command(machine_id)
    except BackendError as exc:
        await ws.send_text(f"\r\n[Nexora] {exc}\r\n")
        await ws.close()
        return

    pid, master_fd = pty.fork()
    if pid == 0:  # proceso hijo: ejecuta la consola
        # Un TERM válido es imprescindible para que `clear`, `tput` y las apps
        # ncurses funcionen. Al lanzarse desde la app GTK (sin terminal padre)
        # TERM viene vacío y `clear` no limpia; lo forzamos aquí.
        os.environ["TERM"] = "xterm-256color"
        try:
            os.execvp(argv[0], argv)
        except Exception as exc:  # pragma: no cover
            os.write(2, f"No se pudo abrir la consola: {exc}\n".encode())
        os._exit(1)

    loop = asyncio.get_event_loop()
    flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
    fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def on_master_readable() -> None:
        try:
            data = os.read(master_fd, 65536)
        except (OSError, BlockingIOError):
            return
        if not data:
            loop.remove_reader(master_fd)
            asyncio.create_task(_safe_close(ws))
            return
        asyncio.create_task(_send_bytes(ws, data))

    loop.add_reader(master_fd, on_master_readable)

    try:
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                os.write(master_fd, msg["bytes"])
            elif msg.get("text") is not None:
                _handle_text(master_fd, msg["text"])
    except WebSocketDisconnect:
        pass
    finally:
        try:
            loop.remove_reader(master_fd)
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except Exception:
            pass
        try:
            os.close(master_fd)
        except Exception:
            pass
        try:
            os.waitpid(pid, os.WNOHANG)
        except Exception:
            pass


def _handle_text(master_fd: int, text: str) -> None:
    try:
        payload = json.loads(text)
    except ValueError:
        os.write(master_fd, text.encode())
        return
    if isinstance(payload, dict) and payload.get("type") == "resize":
        rows = int(payload.get("rows", 24))
        cols = int(payload.get("cols", 80))
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        try:
            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
        except Exception:
            pass
    else:
        os.write(master_fd, text.encode())


async def _send_bytes(ws: WebSocket, data: bytes) -> None:
    try:
        await ws.send_bytes(data)
    except Exception:
        pass


async def _safe_close(ws: WebSocket) -> None:
    try:
        await ws.close()
    except Exception:
        pass


# ---- frontend estático (debe ir el último para no tapar /api) ----------
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

"""Tipos comunes a los tres backends (KVM, Docker, LXC)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

# Estados normalizados que usa toda la app.
RUN = "run"
STOP = "stop"
PAUSE = "pause"
UNKNOWN = "unknown"


@dataclass
class Machine:
    type: str  # "kvm" | "docker" | "lxc"
    name: str
    state: str = UNKNOWN
    vcpus: str = "—"
    memory: str = "—"
    ip: str = "—"
    autostart: bool = False
    ref: str = ""  # dominio/contenedor, dato técnico opcional
    uuid: str = ""

    @property
    def id(self) -> str:
        return f"{self.type}:{self.name}"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["id"] = self.id
        return data


class BackendError(Exception):
    """Error recuperable de un backend (se reporta al cliente sin tumbar la app)."""


class Backend:
    """Interfaz que implementa cada backend. Los métodos no implementados
    levantan NotImplementedError y la API los traduce a 501."""

    type = "base"

    def available(self) -> bool:
        return False

    def list_machines(self) -> list[Machine]:
        raise NotImplementedError

    def get_machine(self, name: str) -> Machine:
        for m in self.list_machines():
            if m.name == name:
                return m
        raise BackendError(f"No existe la máquina {name!r}")

    def detail(self, name: str) -> dict[str, Any]:
        return self.get_machine(name).to_dict()

    # Ciclo de vida -------------------------------------------------------
    def action(self, name: str, op: str) -> None:
        """op ∈ {start, stop, reboot, forceoff, pause, resume}."""
        raise NotImplementedError

    # Discos --------------------------------------------------------------
    def resize_disk(self, name: str, dev: str, new_bytes: int) -> None:
        """Agranda un disco de la máquina hasta new_bytes."""
        raise NotImplementedError

    # Consola -------------------------------------------------------------
    def console_command(self, name: str) -> list[str]:
        """Devuelve el argv para abrir una consola interactiva de la máquina."""
        raise NotImplementedError

    # Usuarios (/etc/passwd dentro de la máquina) -------------------------
    def users(self, name: str) -> list[dict[str, str]]:
        raise NotImplementedError

    # Redes ---------------------------------------------------------------
    def networks(self) -> list[dict[str, Any]]:
        return []

    def create_network(self, spec: dict[str, Any]) -> None:
        raise NotImplementedError

    def update_network(self, name: str, spec: dict[str, Any]) -> None:
        raise NotImplementedError

    def delete_network(self, name: str) -> None:
        raise NotImplementedError

    def network_action(self, name: str, op: str) -> None:
        raise NotImplementedError

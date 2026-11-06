"""Agrega los tres backends y fusiona los metadatos propios (módulo, notas…)."""
from __future__ import annotations

from typing import Any

from .. import config, db
from .base import Backend, BackendError, Machine
from .docker_be import DockerBackend
from .kvm import KvmBackend
from .lxc import LxcBackend


class Manager:
    def __init__(self) -> None:
        self._backends: dict[str, Backend] = {}
        if "kvm" in config.ENABLED_BACKENDS:
            self._backends["kvm"] = KvmBackend()
        if "docker" in config.ENABLED_BACKENDS:
            self._backends["docker"] = DockerBackend()
        if "lxc" in config.ENABLED_BACKENDS:
            self._backends["lxc"] = LxcBackend()

    def backend(self, type_: str) -> Backend:
        be = self._backends.get(type_)
        if be is None:
            raise BackendError(f"Backend desconocido: {type_}")
        return be

    def available(self) -> dict[str, bool]:
        return {t: be.available() for t, be in self._backends.items()}

    def _enabled_available(self) -> list[Backend]:
        return [be for be in self._backends.values() if be.available()]

    def list_machines(self) -> list[dict[str, Any]]:
        meta = db.all_meta()
        out: list[dict[str, Any]] = []
        for be in self._enabled_available():
            try:
                machines = be.list_machines()
            except BackendError:
                continue
            for m in machines:
                d = m.to_dict()
                d.update(_default_meta())
                d.update(meta.get(m.id, {}))
                out.append(d)
        out.sort(key=lambda d: (d["type"], d["name"].lower()))
        return out

    def _split_id(self, machine_id: str) -> tuple[str, str]:
        type_, _, name = machine_id.partition(":")
        if not name:
            raise BackendError(f"Id de máquina no válido: {machine_id!r}")
        return type_, name

    def detail(self, machine_id: str) -> dict[str, Any]:
        type_, name = self._split_id(machine_id)
        data = self.backend(type_).detail(name)
        data.update(_default_meta())
        data.update(db.get_meta(machine_id))
        return data

    def action(self, machine_id: str, op: str) -> None:
        type_, name = self._split_id(machine_id)
        self.backend(type_).action(name, op)

    def users(self, machine_id: str) -> list[dict[str, str]]:
        type_, name = self._split_id(machine_id)
        return self.backend(type_).users(name)

    def console_command(self, machine_id: str) -> list[str]:
        type_, name = self._split_id(machine_id)
        return self.backend(type_).console_command(name)

    def set_meta(self, machine_id: str, **fields: Any) -> dict[str, Any]:
        return db.set_meta(machine_id, **fields)

    def networks(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for be in self._enabled_available():
            try:
                out.extend(be.networks())
            except (BackendError, NotImplementedError):
                continue
        return out

    def create_network(self, spec: dict[str, Any]) -> None:
        self.backend(spec.get("backend", "")).create_network(spec)

    def update_network(self, backend: str, name: str, spec: dict[str, Any]) -> None:
        self.backend(backend).update_network(name, spec)

    def delete_network(self, backend: str, name: str) -> None:
        self.backend(backend).delete_network(name)

    def network_action(self, backend: str, name: str, op: str) -> None:
        self.backend(backend).network_action(name, op)


def _default_meta() -> dict[str, Any]:
    return {"module": None, "description": "", "notes": "", "tags": []}


manager = Manager()

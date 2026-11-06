"""Backend LXC clásico (liblxc) mediante las órdenes lxc-* por subprocess."""
from __future__ import annotations

import shutil
import subprocess
from typing import Any

from .. import config
from .base import PAUSE, RUN, STOP, UNKNOWN, Backend, BackendError, Machine


class LxcBackend(Backend):
    type = "lxc"

    def _argv(self, *args: str) -> list[str]:
        base = ["sudo", "-n"] if config.LXC_SUDO else []
        return base + list(args)

    def _run(self, *args: str, check: bool = True) -> str:
        try:
            proc = subprocess.run(
                self._argv(*args),
                capture_output=True,
                text=True,
                timeout=20,
            )
        except FileNotFoundError:
            raise BackendError("Las herramientas lxc-* no están instaladas")
        except subprocess.TimeoutExpired:
            raise BackendError(f"Tiempo agotado ejecutando {args[0]}")
        if check and proc.returncode != 0:
            raise BackendError((proc.stderr or proc.stdout or "").strip() or f"Error en {args[0]}")
        return proc.stdout

    def available(self) -> bool:
        if not shutil.which("lxc-ls"):
            return False
        try:
            self._run("lxc-ls", "-1", check=True)
            return True
        except Exception:
            return False

    @staticmethod
    def _state(raw: str) -> str:
        return {
            "RUNNING": RUN,
            "STOPPED": STOP,
            "FROZEN": PAUSE,
        }.get(raw.strip().upper(), UNKNOWN)

    def _info(self, name: str) -> dict[str, str]:
        out = self._run("lxc-info", "-n", name, check=False)
        info: dict[str, str] = {}
        for line in out.splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                info[key.strip().lower()] = value.strip()
        return info

    def _machine(self, name: str) -> Machine:
        info = self._info(name)
        return Machine(
            type="lxc",
            name=name,
            state=self._state(info.get("state", "")),
            vcpus="—",
            memory=info.get("memory use", "—"),
            ip=info.get("ip", "—") or "—",
            autostart=False,
            ref="contenedor",
        )

    def list_machines(self) -> list[Machine]:
        out = self._run("lxc-ls", "-1", check=True)
        names = [n.strip() for n in out.splitlines() if n.strip()]
        return [self._machine(n) for n in names]

    def detail(self, name: str) -> dict[str, Any]:
        data = self._machine(name).to_dict()
        data["info"] = self._info(name)
        return data

    def action(self, name: str, op: str) -> None:
        if op == "start":
            self._run("lxc-start", "-n", name)
        elif op == "stop":
            self._run("lxc-stop", "-n", name)
        elif op == "reboot":
            self._run("lxc-stop", "-n", name, "--reboot")
        elif op == "forceoff":
            self._run("lxc-stop", "-n", name, "--kill")
        elif op == "pause":
            self._run("lxc-freeze", "-n", name)
        elif op == "resume":
            self._run("lxc-unfreeze", "-n", name)
        else:
            raise BackendError(f"Operación no soportada: {op}")

    def console_command(self, name: str) -> list[str]:
        return self._argv("lxc-attach", "-n", name)

    def users(self, name: str) -> list[dict[str, str]]:
        out = self._run("lxc-attach", "-n", name, "--", "cat", "/etc/passwd", check=False)
        users = []
        for line in out.splitlines():
            parts = line.split(":")
            if len(parts) >= 7:
                users.append({"user": parts[0], "uid": parts[2], "home": parts[5], "shell": parts[6]})
        if not users:
            raise BackendError("No se pudo leer /etc/passwd (¿el contenedor está arrancado?)")
        return users

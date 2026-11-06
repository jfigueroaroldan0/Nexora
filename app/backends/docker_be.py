"""Backend Docker vía el SDK oficial."""
from __future__ import annotations

from typing import Any

from .base import PAUSE, RUN, STOP, UNKNOWN, Backend, BackendError, Machine

try:
    import docker  # type: ignore
except Exception:  # pragma: no cover
    docker = None


def _fmt_mem(nbytes: int) -> str:
    if not nbytes:
        return "sin límite"
    gib = nbytes / (1024 ** 3)
    if gib >= 1:
        return f"{gib:.1f} GiB"
    return f"{nbytes / (1024 ** 2):.0f} MiB"


def _fmt_cpu(nano: int) -> str:
    if not nano:
        return "sin límite"
    return f"{nano / 1e9:g} CPU"


class DockerBackend(Backend):
    type = "docker"

    def __init__(self) -> None:
        self._client = None

    def _c(self):
        if docker is None:
            raise BackendError("El SDK de Docker no está instalado")
        if self._client is None:
            try:
                self._client = docker.from_env()
            except Exception as exc:  # pragma: no cover
                raise BackendError(f"No se pudo conectar a Docker: {exc}")
        return self._client

    def available(self) -> bool:
        if docker is None:
            return False
        try:
            self._c().ping()
            return True
        except Exception:
            return False

    @staticmethod
    def _state(status: str) -> str:
        return {
            "running": RUN,
            "paused": PAUSE,
            "exited": STOP,
            "created": STOP,
            "dead": STOP,
        }.get(status, UNKNOWN)

    def _machine(self, c) -> Machine:
        attrs = c.attrs
        host = attrs.get("HostConfig", {})
        ip = "—"
        for net in (attrs.get("NetworkSettings", {}).get("Networks") or {}).values():
            if net.get("IPAddress"):
                ip = net["IPAddress"]
                break
        return Machine(
            type="docker",
            name=c.name,
            state=self._state(c.status),
            vcpus=_fmt_cpu(host.get("NanoCpus", 0)),
            memory=_fmt_mem(host.get("Memory", 0)),
            ip=ip,
            autostart=host.get("RestartPolicy", {}).get("Name") in ("always", "unless-stopped"),
            ref=(c.image.tags[0] if c.image and c.image.tags else c.short_id),
            uuid=c.id,
        )

    def list_machines(self) -> list[Machine]:
        return [self._machine(c) for c in self._c().containers.list(all=True)]

    def _get(self, name: str):
        try:
            return self._c().containers.get(name)
        except Exception:
            raise BackendError(f"No existe el contenedor {name!r}")

    def detail(self, name: str) -> dict[str, Any]:
        c = self._get(name)
        data = self._machine(c).to_dict()
        attrs = c.attrs
        data["image"] = attrs.get("Config", {}).get("Image", "")
        data["command"] = " ".join(attrs.get("Config", {}).get("Cmd") or [])
        data["restart_policy"] = attrs.get("HostConfig", {}).get("RestartPolicy", {}).get("Name", "")
        data["created"] = attrs.get("Created", "")
        ports = []
        for cont, binds in (attrs.get("NetworkSettings", {}).get("Ports") or {}).items():
            for b in binds or []:
                ports.append(f"{b.get('HostPort')}:{cont}")
        data["ports"] = ports
        data["nics"] = [
            {"network": name, "ip": net.get("IPAddress", ""), "mac": net.get("MacAddress", "")}
            for name, net in (attrs.get("NetworkSettings", {}).get("Networks") or {}).items()
        ]
        mounts = [
            {"source": m.get("Source", ""), "dest": m.get("Destination", "")}
            for m in attrs.get("Mounts") or []
        ]
        data["mounts"] = mounts
        return data

    def action(self, name: str, op: str) -> None:
        c = self._get(name)
        try:
            if op == "start":
                c.start()
            elif op == "stop":
                c.stop()
            elif op == "reboot":
                c.restart()
            elif op == "forceoff":
                c.kill()
            elif op == "pause":
                c.pause()
            elif op == "resume":
                c.unpause()
            else:
                raise BackendError(f"Operación no soportada: {op}")
        except Exception as exc:
            raise BackendError(str(exc))

    def console_command(self, name: str) -> list[str]:
        # Shell dentro del contenedor (sh si no hay bash).
        return [
            "docker", "exec", "-it", name,
            "/bin/sh", "-c", "exec $(command -v bash || command -v sh) -l 2>/dev/null || exec sh",
        ]

    def users(self, name: str) -> list[dict[str, str]]:
        c = self._get(name)
        try:
            code, out = c.exec_run(["cat", "/etc/passwd"])
        except Exception as exc:
            raise BackendError(str(exc))
        if code != 0:
            raise BackendError("No se pudo leer /etc/passwd en el contenedor")
        return _parse_passwd(out.decode("utf-8", "replace"))

    def networks(self) -> list[dict[str, Any]]:
        nets = []
        for n in self._c().networks.list():
            attrs = n.attrs
            ipam = attrs.get("IPAM", {}).get("Config") or [{}]
            subnet = ipam[0].get("Subnet", "—") if ipam else "—"
            gateway = ipam[0].get("Gateway", "—") if ipam else "—"
            machines = [
                {"type": "docker", "name": c.get("Name", ""), "ip": (c.get("IPv4Address") or "").split("/")[0]}
                for c in (attrs.get("Containers") or {}).values()
            ]
            nets.append({
                "backend": "docker",
                "name": n.name,
                "mode": attrs.get("Driver", ""),
                "cidr": subnet,
                "gateway": gateway,
                "dhcp": "IPAM automático",
                "bridge": attrs.get("Options", {}).get("com.docker.network.bridge.name", ""),
                "active": True,
                "machines": machines,
            })
        return nets


def _parse_passwd(text: str) -> list[dict[str, str]]:
    users = []
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) >= 7:
            users.append({"user": parts[0], "uid": parts[2], "home": parts[5], "shell": parts[6]})
    return users

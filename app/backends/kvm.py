"""Backend KVM/QEMU vía libvirt."""
from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

from .. import config
from .base import PAUSE, RUN, STOP, UNKNOWN, Backend, BackendError, Machine

try:  # libvirt es opcional (se instala del sistema: python3-libvirt)
    import libvirt  # type: ignore
except Exception:  # pragma: no cover
    libvirt = None


def _fmt_gib(kib: int) -> str:
    gib = kib / (1024 * 1024)
    if gib >= 1:
        return f"{gib:.1f} GiB"
    return f"{kib / 1024:.0f} MiB"


def _fmt_bytes(n: int) -> str:
    gib = n / (1024 ** 3)
    if gib >= 1:
        return f"{gib:.1f} GiB"
    return f"{n / (1024 ** 2):.0f} MiB"


class KvmBackend(Backend):
    type = "kvm"

    def __init__(self) -> None:
        self._uri = config.LIBVIRT_URI

    def available(self) -> bool:
        if libvirt is None:
            return False
        try:
            conn = libvirt.openReadOnly(self._uri)
            conn.close()
            return True
        except Exception:
            return False

    def _open(self, read_only: bool = False):
        if libvirt is None:
            raise BackendError("libvirt-python no está instalado")
        try:
            conn = libvirt.openReadOnly(self._uri) if read_only else libvirt.open(self._uri)
        except Exception as exc:  # pragma: no cover
            raise BackendError(f"No se pudo conectar a libvirt ({self._uri}): {exc}")
        if conn is None:
            raise BackendError(f"No se pudo conectar a libvirt ({self._uri})")
        return conn

    @staticmethod
    def _state(dom) -> str:
        try:
            st = dom.state()[0]
        except Exception:
            return UNKNOWN
        if st == libvirt.VIR_DOMAIN_RUNNING:
            return RUN
        if st == libvirt.VIR_DOMAIN_PAUSED:
            return PAUSE
        if st in (libvirt.VIR_DOMAIN_SHUTOFF, libvirt.VIR_DOMAIN_SHUTDOWN, libvirt.VIR_DOMAIN_CRASHED):
            return STOP
        return UNKNOWN

    def _ip(self, dom) -> str:
        if self._state(dom) != RUN:
            return "—"
        sources = [
            libvirt.VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_LEASE,
            libvirt.VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT,
            libvirt.VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_ARP,
        ]
        for src in sources:
            try:
                ifaces = dom.interfaceAddresses(src, 0)
            except Exception:
                continue
            for data in (ifaces or {}).values():
                for addr in data.get("addrs") or []:
                    ip = addr.get("addr", "")
                    if ip and not ip.startswith("127.") and ":" not in ip:
                        return ip
        return "—"

    def _machine(self, dom) -> Machine:
        info = dom.info()  # [state, maxMem(KiB), mem(KiB), nrVirtCpu, cpuTime]
        try:
            autostart = bool(dom.autostart())
        except Exception:
            autostart = False
        return Machine(
            type="kvm",
            name=dom.name(),
            state=self._state(dom),
            vcpus=str(info[3]),
            memory=_fmt_gib(info[1]),
            ip=self._ip(dom),
            autostart=autostart,
            ref=f"dominio {dom.ID() if dom.ID() > 0 else '—'}",
            uuid=dom.UUIDString(),
        )

    def list_machines(self) -> list[Machine]:
        conn = self._open(read_only=True)
        try:
            return [self._machine(d) for d in conn.listAllDomains()]
        finally:
            conn.close()

    def _lookup(self, conn, name: str):
        try:
            return conn.lookupByName(name)
        except Exception:
            raise BackendError(f"No existe el dominio {name!r}")

    def detail(self, name: str) -> dict[str, Any]:
        conn = self._open(read_only=True)
        try:
            dom = self._lookup(conn, name)
            data = self._machine(dom).to_dict()
            xml = dom.XMLDesc(0)
            root = ET.fromstring(xml)
            # Arquitectura / máquina / firmware
            os_el = root.find("os/type")
            data["arch"] = os_el.get("arch") if os_el is not None else ""
            data["machine_type"] = os_el.get("machine") if os_el is not None else ""
            loader = root.find("os/loader")
            data["firmware"] = "UEFI (OVMF)" if loader is not None else "BIOS"
            # Discos
            disks = []
            for disk in root.findall("devices/disk"):
                target = disk.find("target")
                source = disk.find("source")
                driver = disk.find("driver")
                src = ""
                if source is not None:
                    src = source.get("file") or source.get("dev") or source.get("volume") or ""
                dev = target.get("dev") if target is not None else ""
                cap = 0
                if dev:
                    try:
                        cap = dom.blockInfo(dev)[0]
                    except Exception:
                        cap = 0
                disks.append({
                    "dev": dev,
                    "device": disk.get("device", "disk"),
                    "format": driver.get("type") if driver is not None else "",
                    "source": src,
                    "capacity_bytes": cap,
                    "capacity": _fmt_bytes(cap) if cap else "—",
                })
            data["disks"] = disks
            # Interfaces de red
            nics = []
            for iface in root.findall("devices/interface"):
                mac = iface.find("mac")
                src = iface.find("source")
                model = iface.find("model")
                nics.append({
                    "mac": mac.get("address") if mac is not None else "",
                    "network": (src.get("network") or src.get("bridge")) if src is not None else "",
                    "model": model.get("type") if model is not None else "",
                })
            data["nics"] = nics
            # Pantalla gráfica (SPICE/VNC)
            graphics = root.find("devices/graphics")
            if graphics is not None:
                data["graphics"] = {
                    "type": graphics.get("type", ""),
                    "port": graphics.get("port", ""),
                }
            return data
        finally:
            conn.close()

    def action(self, name: str, op: str) -> None:
        conn = self._open()
        try:
            dom = self._lookup(conn, name)
            try:
                if op == "start":
                    if not dom.isActive():
                        dom.create()
                elif op == "stop":
                    dom.shutdown()
                elif op == "reboot":
                    dom.reboot(0)
                elif op == "forceoff":
                    dom.destroy()
                elif op == "pause":
                    dom.suspend()
                elif op == "resume":
                    dom.resume()
                else:
                    raise BackendError(f"Operación no soportada: {op}")
            except libvirt.libvirtError as exc:
                raise BackendError(str(exc))
        finally:
            conn.close()

    def resize_disk(self, name: str, dev: str, new_bytes: int) -> None:
        """Agranda un disco del dominio. En caliente usa blockResize; con la
        VM apagada redimensiona el volumen a través de libvirt (permisos del
        demonio). Solo permite aumentar el tamaño."""
        conn = self._open()
        try:
            dom = self._lookup(conn, name)
            root = ET.fromstring(dom.XMLDesc(0))
            path = None
            device = "disk"
            for disk in root.findall("devices/disk"):
                target = disk.find("target")
                if target is not None and target.get("dev") == dev:
                    device = disk.get("device", "disk")
                    source = disk.find("source")
                    if source is not None:
                        path = source.get("file") or source.get("dev") or source.get("volume")
                    break
            else:
                raise BackendError(f"No existe el disco {dev!r} en {name!r}")
            if device == "cdrom":
                raise BackendError("Un CD-ROM no se puede redimensionar")
            try:
                cap = dom.blockInfo(dev)[0]
            except libvirt.libvirtError:
                cap = 0
            if cap and new_bytes <= cap:
                raise BackendError(
                    f"El disco ya mide {_fmt_bytes(cap)}; solo se puede agrandar"
                )
            try:
                if dom.isActive():
                    dom.blockResize(dev, new_bytes, libvirt.VIR_DOMAIN_BLOCK_RESIZE_BYTES)
                else:
                    if not path:
                        raise BackendError("No se pudo localizar el fichero del disco")
                    try:
                        vol = conn.storageVolLookupByPath(path)
                    except libvirt.libvirtError:
                        raise BackendError(
                            "El disco no está en un pool de libvirt; arranca la VM "
                            "y vuelve a intentarlo para redimensionarlo en caliente"
                        )
                    vol.resize(new_bytes, 0)
            except libvirt.libvirtError as exc:
                raise BackendError(str(exc))
        finally:
            conn.close()

    def console_command(self, name: str) -> list[str]:
        # Consola serie del dominio.
        return ["virsh", "-c", self._uri, "console", name, "--force"]

    def users(self, name: str) -> list[dict[str, str]]:
        # Lee /etc/passwd dentro del guest mediante el agente QEMU.
        conn = self._open()
        try:
            dom = self._lookup(conn, name)
            try:
                import base64
                import json as _json

                exec_ret = dom.qemuAgentCommand(
                    _json.dumps({
                        "execute": "guest-exec",
                        "arguments": {"path": "/bin/cat", "arg": ["/etc/passwd"], "capture-output": True},
                    }),
                    10,
                    0,
                )
                pid = _json.loads(exec_ret)["return"]["pid"]
                status = dom.qemuAgentCommand(
                    _json.dumps({"execute": "guest-exec-status", "arguments": {"pid": pid}}),
                    10,
                    0,
                )
                out = _json.loads(status)["return"].get("out-data", "")
                text = base64.b64decode(out).decode("utf-8", "replace")
            except Exception as exc:
                raise BackendError(
                    "No se pudo leer /etc/passwd (¿tiene el guest-agent instalado y arrancado?): "
                    f"{exc}"
                )
        finally:
            conn.close()
        return _parse_passwd(text)

    def networks(self) -> list[dict[str, Any]]:
        conn = self._open(read_only=True)
        try:
            # Mapa red -> máquinas conectadas (escaneando los dominios).
            members: dict[str, list[dict[str, str]]] = {}
            for dom in conn.listAllDomains():
                try:
                    root = ET.fromstring(dom.XMLDesc(0))
                except Exception:
                    continue
                for iface in root.findall("devices/interface"):
                    src = iface.find("source")
                    if src is None:
                        continue
                    net = src.get("network")
                    if net:
                        members.setdefault(net, []).append(
                            {"type": "kvm", "name": dom.name(), "ip": self._ip(dom)}
                        )

            nets = []
            for net in conn.listAllNetworks():
                try:
                    root = ET.fromstring(net.XMLDesc(0))
                except Exception:
                    continue
                forward = root.find("forward")
                mode = forward.get("mode") if forward is not None else "aislada"
                mode_map = {"nat": "NAT", "route": "Ruta", "bridge": "Puente", "open": "Abierta"}
                ip_el = root.find("ip")
                cidr = gateway = dhcp = "—"
                if ip_el is not None:
                    gateway = ip_el.get("address", "—")
                    netmask = ip_el.get("netmask")
                    prefix = ip_el.get("prefix")
                    if netmask:
                        cidr = f"{gateway}/{_mask_to_prefix(netmask)}"
                    elif prefix:
                        cidr = f"{gateway}/{prefix}"
                    dhcp_range = ip_el.find("dhcp/range")
                    if dhcp_range is not None:
                        dhcp = f"{dhcp_range.get('start')} – {dhcp_range.get('end')}"
                    else:
                        dhcp = "sin DHCP"
                nets.append({
                    "backend": "kvm",
                    "name": net.name(),
                    "mode": mode_map.get(mode, mode if mode else "Aislada"),
                    "cidr": cidr,
                    "gateway": gateway,
                    "dhcp": dhcp,
                    "bridge": net.bridgeName() if net.isActive() else "",
                    "active": bool(net.isActive()),
                    "machines": members.get(net.name(), []),
                })
            return nets
        finally:
            conn.close()

    def create_network(self, spec: dict[str, Any]) -> None:
        xml = _build_network_xml(spec)
        conn = self._open()
        try:
            net = conn.networkDefineXML(xml)
            if net is None:
                raise BackendError("No se pudo definir la red")
            try:
                net.setAutostart(bool(spec.get("autostart", True)))
            except Exception:
                pass
            if spec.get("active", True):
                net.create()
        except libvirt.libvirtError as exc:
            raise BackendError(str(exc))
        finally:
            conn.close()

    def update_network(self, name: str, spec: dict[str, Any]) -> None:
        conn = self._open()
        try:
            was_active, autostart = True, True
            try:
                old = conn.networkLookupByName(name)
                was_active = bool(old.isActive())
                try:
                    autostart = bool(old.autostart())
                except Exception:
                    autostart = True
                if was_active:
                    old.destroy()
                old.undefine()
            except libvirt.libvirtError:
                pass  # no existía: se define de cero
            spec = dict(spec)
            spec["name"] = name
            net = conn.networkDefineXML(_build_network_xml(spec))
            if net is None:
                raise BackendError("No se pudo redefinir la red")
            net.setAutostart(bool(spec.get("autostart", autostart)))
            if spec.get("active", was_active):
                net.create()
        except libvirt.libvirtError as exc:
            raise BackendError(str(exc))
        finally:
            conn.close()

    def delete_network(self, name: str) -> None:
        conn = self._open()
        try:
            net = conn.networkLookupByName(name)
            if net.isActive():
                net.destroy()
            net.undefine()
        except libvirt.libvirtError as exc:
            raise BackendError(str(exc))
        finally:
            conn.close()

    def network_action(self, name: str, op: str) -> None:
        conn = self._open()
        try:
            net = conn.networkLookupByName(name)
            if op == "activate":
                net.create()
            elif op == "deactivate":
                net.destroy()
            elif op == "autostart":
                net.setAutostart(True)
            elif op == "noautostart":
                net.setAutostart(False)
            else:
                raise BackendError(f"Operación no soportada: {op}")
        except libvirt.libvirtError as exc:
            raise BackendError(str(exc))
        finally:
            conn.close()


def _build_network_xml(spec: dict[str, Any]) -> str:
    import html

    name = str(spec.get("name", "")).strip()
    if not name:
        raise BackendError("La red necesita un nombre")
    name = html.escape(name)
    mode = (spec.get("mode") or "nat").lower()

    parts = ["<network>", f"<name>{name}</name>"]
    if mode in ("nat", "route", "open"):
        parts.append(f"<forward mode='{mode}'/>")
    elif mode == "bridge":
        parts.append("<forward mode='bridge'/>")
    # "isolated" -> sin elemento <forward>

    bridge = (spec.get("bridge") or "").strip()
    if mode == "bridge":
        if not bridge:
            raise BackendError("El modo puente necesita el nombre de un puente existente")
        parts.append(f"<bridge name='{html.escape(bridge)}'/>")
    else:
        if bridge:
            parts.append(f"<bridge name='{html.escape(bridge)}'/>")
        gateway = (spec.get("gateway") or "").strip()
        prefix = str(spec.get("prefix") or "").strip()
        if gateway and prefix:
            ip = [f"<ip address='{html.escape(gateway)}' prefix='{html.escape(prefix)}'>"]
            ds = (spec.get("dhcp_start") or "").strip()
            de = (spec.get("dhcp_end") or "").strip()
            if ds and de:
                ip.append(
                    f"<dhcp><range start='{html.escape(ds)}' end='{html.escape(de)}'/></dhcp>"
                )
            ip.append("</ip>")
            parts.append("".join(ip))

    parts.append("</network>")
    return "".join(parts)


def _mask_to_prefix(netmask: str) -> int:
    try:
        return sum(bin(int(o)).count("1") for o in netmask.split("."))
    except Exception:
        return 24


def _parse_passwd(text: str) -> list[dict[str, str]]:
    users = []
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) >= 7:
            users.append({
                "user": parts[0],
                "uid": parts[2],
                "home": parts[5],
                "shell": parts[6],
            })
    return users

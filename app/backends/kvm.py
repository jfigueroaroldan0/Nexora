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
            # vCPU y memoria en números, para poder editarlos desde la ficha
            try:
                info = dom.info()
                data["vcpus_n"] = int(info[3])
                data["memory_mib"] = int(round(info[1] / 1024))
            except Exception:
                pass
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

    def storage_pools(self) -> list[dict[str, Any]]:
        """Pools de almacenamiento activos donde se puede crear un disco."""
        conn = self._open(read_only=True)
        try:
            out = []
            for pool in conn.listAllStoragePools():
                try:
                    if not pool.isActive():
                        continue
                    info = pool.info()  # [state, capacity, allocation, available]
                    path = ""
                    try:
                        proot = ET.fromstring(pool.XMLDesc(0))
                        p = proot.find("target/path")
                        path = p.text if p is not None else ""
                    except Exception:
                        pass
                    out.append({
                        "name": pool.name(),
                        "path": path,
                        "available_bytes": int(info[3]),
                        "available": _fmt_bytes(int(info[3])),
                    })
                except Exception:
                    continue
            # El pool "default" primero si existe
            out.sort(key=lambda p: (p["name"] != "default", p["name"]))
            return out
        finally:
            conn.close()

    def add_disk(self, name: str, size_gib: float, pool: str | None = None,
                 fmt: str = "qcow2") -> None:
        """Crea un volumen nuevo en un pool y lo conecta como disco a la máquina.
        En caliente si está encendida y siempre de forma persistente."""
        import html

        if not size_gib or size_gib <= 0:
            raise BackendError("El tamaño del disco debe ser mayor que 0")
        fmt = (fmt or "qcow2").strip().lower()
        if fmt not in ("qcow2", "raw"):
            raise BackendError("Formato no soportado (usa qcow2 o raw)")
        conn = self._open()
        try:
            dom = self._lookup(conn, name)
            root = ET.fromstring(dom.XMLDesc(0))
            # Siguiente letra libre para un disco virtio (vda, vdb, …)
            used = set()
            for disk in root.findall("devices/disk"):
                t = disk.find("target")
                if t is not None and t.get("dev"):
                    used.add(t.get("dev"))
            dev = None
            for c in "abcdefghijklmnopqrstuvwxyz":
                cand = "vd" + c
                if cand not in used:
                    dev = cand
                    break
            if dev is None:
                raise BackendError("No quedan letras libres para un disco virtio")
            # Pool de destino
            spool = None
            if pool:
                try:
                    spool = conn.storagePoolLookupByName(pool)
                except libvirt.libvirtError:
                    raise BackendError(f"No existe el pool {pool!r}")
                if not spool.isActive():
                    raise BackendError(f"El pool {pool!r} no está activo")
            else:
                try:
                    spool = conn.storagePoolLookupByName("default")
                except libvirt.libvirtError:
                    spool = None
                if spool is None or not spool.isActive():
                    spool = None
                    for p in conn.listAllStoragePools():
                        if p.isActive():
                            spool = p
                            break
                if spool is None:
                    raise BackendError(
                        "No hay ningún pool de almacenamiento activo donde crear el disco"
                    )
            # Nombre de volumen único dentro del pool
            try:
                existing = set(spool.listVolumes())
            except libvirt.libvirtError:
                existing = set()
            ext = "qcow2" if fmt == "qcow2" else "img"
            base = f"{name}-{dev}"
            volname = f"{base}.{ext}"
            i = 1
            while volname in existing:
                volname = f"{base}-{i}.{ext}"
                i += 1
            capacity = int(round(size_gib * (1024 ** 3)))
            vol_xml = (
                "<volume>"
                f"<name>{html.escape(volname)}</name>"
                f"<capacity unit='bytes'>{capacity}</capacity>"
                f"<target><format type='{fmt}'/></target>"
                "</volume>"
            )
            try:
                vol = spool.createXML(vol_xml, 0)
                if vol is None:
                    raise BackendError("No se pudo crear el volumen del disco")
                path = vol.path()
            except libvirt.libvirtError as exc:
                raise BackendError(str(exc))
            disk_xml = (
                "<disk type='file' device='disk'>"
                f"<driver name='qemu' type='{fmt}'/>"
                f"<source file='{html.escape(path)}'/>"
                f"<target dev='{dev}' bus='virtio'/>"
                "</disk>"
            )
            flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
            if dom.isActive():
                flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
            try:
                dom.attachDeviceFlags(disk_xml, flags)
            except libvirt.libvirtError as exc:
                # Si falla el enganche, borramos el volumen recién creado
                try:
                    vol.delete(0)
                except Exception:
                    pass
                raise BackendError(str(exc))
        finally:
            conn.close()

    def base_images(self) -> list[dict[str, Any]]:
        """Volúmenes del pool «default» que pueden servir de imagen base para
        crear una máquina nueva (se omiten los .iso). Marca los que ya usa
        algún dominio para avisar de que no conviene clonarlos."""
        conn = self._open(read_only=True)
        try:
            in_use: set[str] = set()
            for dom in conn.listAllDomains():
                try:
                    root = ET.fromstring(dom.XMLDesc(0))
                except Exception:
                    continue
                for disk in root.findall("devices/disk"):
                    s = disk.find("source")
                    if s is not None:
                        p = s.get("file") or s.get("dev") or ""
                        if p:
                            in_use.add(p)
            try:
                pool = conn.storagePoolLookupByName("default")
            except libvirt.libvirtError:
                return []
            out = []
            for volname in pool.listVolumes():
                if volname.lower().endswith(".iso"):
                    continue
                try:
                    vol = pool.storageVolLookupByName(volname)
                    info = vol.info()  # [type, capacity, allocation]
                    path = vol.path()
                except libvirt.libvirtError:
                    continue
                fmt = ""
                try:
                    vroot = ET.fromstring(vol.XMLDesc(0))
                    f = vroot.find("target/format")
                    fmt = f.get("type") if f is not None else ""
                except Exception:
                    pass
                out.append({
                    "name": volname,
                    "path": path,
                    "format": fmt,
                    "capacity_bytes": int(info[1]),
                    "capacity": _fmt_bytes(int(info[1])),
                    "in_use": path in in_use,
                })
            out.sort(key=lambda v: (v["in_use"], v["name"].lower()))
            return out
        finally:
            conn.close()

    def isos(self) -> list[dict[str, Any]]:
        """Imágenes ISO disponibles en los pools activos, para instalar una
        máquina «normal» arrancando desde ellas."""
        conn = self._open(read_only=True)
        try:
            out = []
            for pool in conn.listAllStoragePools():
                try:
                    if not pool.isActive():
                        continue
                    pname = pool.name()
                except Exception:
                    continue
                try:
                    volumes = pool.listVolumes()
                except libvirt.libvirtError:
                    continue
                for volname in volumes:
                    if not volname.lower().endswith(".iso"):
                        continue
                    try:
                        vol = pool.storageVolLookupByName(volname)
                        info = vol.info()
                        path = vol.path()
                    except libvirt.libvirtError:
                        continue
                    out.append({
                        "name": volname,
                        "path": path,
                        "pool": pname,
                        "capacity_bytes": int(info[1]),
                        "capacity": _fmt_bytes(int(info[1])),
                    })
            out.sort(key=lambda v: v["name"].lower())
            return out
        finally:
            conn.close()

    def create_vm(self, spec: dict[str, Any]) -> str:
        """Crea una máquina KVM nueva. Dos modos:
        - «cloud»: disco qcow2 en cadena (copia-al-escribir) sobre una imagen
          base del pool + cloud-init (usuario, contraseña, hostname, clave SSH,
          paquetes) mediante un seed NoCloud.
        - «normal»: disco qcow2 vacío + arranque desde una ISO para instalar el
          sistema a mano (BIOS o UEFI).
        Se apoya en virt-install para que libvirt cree los discos con los
        permisos del pool y para generar un XML correcto."""
        import os
        import re
        import shutil
        import subprocess
        import tempfile

        mode = (spec.get("mode") or "cloud").strip().lower()
        if mode not in ("cloud", "normal"):
            raise BackendError("Modo no válido (usa «cloud» o «normal»)")

        name = (spec.get("name") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,62}", name or ""):
            raise BackendError(
                "Nombre no válido: letras, números, punto, guion y guion bajo "
                "(sin espacios), empezando por letra o número"
            )
        try:
            vcpus = int(spec.get("vcpus") or 1)
        except (TypeError, ValueError):
            raise BackendError("vCPU no válidas")
        if vcpus < 1:
            raise BackendError("La máquina necesita al menos 1 vCPU")
        try:
            memory_mib = int(spec.get("memory_mib") or 1024)
        except (TypeError, ValueError):
            raise BackendError("Memoria no válida")
        if memory_mib < 256:
            raise BackendError("La memoria mínima es 256 MiB")
        network = (spec.get("network") or "default").strip() or "default"

        # Validación específica de cada modo antes de tocar libvirt.
        if mode == "cloud":
            base_path = (spec.get("base_image") or "").strip()
            if not base_path:
                raise BackendError("Elige una imagen base")
            username = (spec.get("username") or "").strip()
            if not re.fullmatch(r"[a-z_][a-z0-9_-]*", username or ""):
                raise BackendError("Usuario no válido (minúsculas y sin espacios)")
            password = spec.get("password") or ""
            ssh_key = (spec.get("ssh_key") or "").strip()
            if not password and not ssh_key:
                raise BackendError("Pon una contraseña o una clave SSH para el usuario")
            hostname = (spec.get("hostname") or name).strip()
            hostname = re.sub(r"[^A-Za-z0-9.-]", "-", hostname) or name
            packages = [p for p in re.split(r"[,\s]+", spec.get("packages") or "") if p]
        else:
            iso_path = (spec.get("iso") or "").strip()
            if not iso_path:
                raise BackendError("Elige una ISO de instalación")
            firmware = (spec.get("firmware") or "bios").strip().lower()
            if firmware not in ("bios", "uefi"):
                firmware = "bios"

        conn = self._open()
        try:
            try:
                conn.lookupByName(name)
                raise BackendError(f"Ya existe una máquina llamada {name!r}")
            except libvirt.libvirtError:
                pass
            try:
                pool = conn.storagePoolLookupByName("default")
            except libvirt.libvirtError:
                raise BackendError("No existe el pool «default» de almacenamiento")
            pool_path = ""
            try:
                proot = ET.fromstring(pool.XMLDesc(0))
                p = proot.find("target/path")
                pool_path = p.text if p is not None else ""
            except Exception:
                pass
            disk_name = f"{name}.qcow2"
            try:
                if disk_name in set(pool.listVolumes()):
                    raise BackendError(
                        f"Ya existe un disco {disk_name!r} en el pool; elige otro nombre"
                    )
            except libvirt.libvirtError:
                pass
            disk_path = os.path.join(pool_path, disk_name) if pool_path else disk_name

            base_fmt = "qcow2"
            base_gib = 0.0
            if mode == "cloud":
                # Formato y tamaño virtual de la imagen base (vía libvirt, que sí
                # puede leer los volúmenes aunque sean de root).
                try:
                    bvol = conn.storageVolLookupByPath(base_path)
                    base_cap = int(bvol.info()[1])
                    base_gib = base_cap / (1024 ** 3) if base_cap else 0
                    vroot = ET.fromstring(bvol.XMLDesc(0))
                    f = vroot.find("target/format")
                    if f is not None and f.get("type"):
                        base_fmt = f.get("type")
                except libvirt.libvirtError:
                    raise BackendError("La imagen base no está en el pool «default»")
            else:
                try:
                    conn.storageVolLookupByPath(iso_path)
                except libvirt.libvirtError:
                    raise BackendError("La ISO no está en ningún pool de almacenamiento")

            try:
                disk_gib = float(spec.get("disk_gib") or 0)
            except (TypeError, ValueError):
                disk_gib = 0
            if disk_gib <= 0:
                disk_gib = max(10.0 if mode == "cloud" else 20.0, base_gib)
            if base_gib and disk_gib < base_gib:
                disk_gib = base_gib
            disk_gib = int(round(disk_gib))
        finally:
            conn.close()

        argv = [
            "virt-install", "--connect", self._uri,
            "--name", name,
            "--memory", str(memory_mib),
            "--vcpus", str(vcpus),
            "--network", f"network={network},model=virtio",
            "--osinfo", "detect=on,require=off",
            "--graphics", "spice",
            "--noautoconsole", "--quiet",
        ]
        tmp = None
        try:
            if mode == "cloud":
                user_data = _cloud_user_data(hostname, username, password, ssh_key, packages)
                meta_data = f"instance-id: {name}\nlocal-hostname: {hostname}\n"
                tmp = tempfile.mkdtemp(prefix="nexora-ci-")
                ud = os.path.join(tmp, "user-data")
                md = os.path.join(tmp, "meta-data")
                with open(ud, "w") as fh:
                    fh.write(user_data)
                with open(md, "w") as fh:
                    fh.write(meta_data)
                argv += [
                    "--disk",
                    f"path={disk_path},backing_store={base_path},backing_format={base_fmt},"
                    f"format=qcow2,size={disk_gib},bus=virtio",
                    "--cloud-init", f"user-data={ud},meta-data={md},disable=on",
                    "--console", "pty,target_type=serial",
                    "--import",
                ]
            else:
                argv += [
                    "--disk", f"path={disk_path},format=qcow2,size={disk_gib},bus=virtio",
                    "--cdrom", iso_path,
                ]
                if firmware == "uefi":
                    argv += ["--boot", "uefi"]
            try:
                proc = subprocess.run(argv, capture_output=True, text=True, timeout=180)
            except subprocess.TimeoutExpired:
                raise BackendError(
                    "virt-install tardó demasiado; revisa el estado de la máquina"
                )
            except FileNotFoundError:
                raise BackendError("No está instalado virt-install (paquete virtinst)")
            if proc.returncode != 0:
                err = (proc.stderr or proc.stdout or "").strip()
                err = err.splitlines()[-1].strip() if err else "error desconocido"
                raise BackendError(f"No se pudo crear la máquina: {err}")
        finally:
            if tmp:
                shutil.rmtree(tmp, ignore_errors=True)
        return name

    def set_resources(self, name: str, vcpus: int | None, memory_mib: int | None) -> None:
        """Cambia vCPU y/o memoria en la configuración persistente del dominio.
        Si la VM está encendida, se aplica al apagarla y volver a arrancarla."""
        conn = self._open()
        try:
            dom = self._lookup(conn, name)
            root = ET.fromstring(dom.XMLDesc(0))
            if vcpus is not None:
                v = int(vcpus)
                if v < 1:
                    raise BackendError("La máquina necesita al menos 1 vCPU")
                vcpu_el = root.find("vcpu")
                if vcpu_el is None:
                    vcpu_el = ET.SubElement(root, "vcpu")
                vcpu_el.text = str(v)
                vcpu_el.attrib.pop("current", None)
            if memory_mib is not None:
                kib = int(memory_mib) * 1024
                if kib < 256 * 1024:
                    raise BackendError("La memoria mínima es 256 MiB")
                for tag in ("memory", "currentMemory"):
                    el = root.find(tag)
                    if el is None:
                        el = ET.SubElement(root, tag)
                    el.set("unit", "KiB")
                    el.text = str(kib)
            try:
                if conn.defineXML(ET.tostring(root, encoding="unicode")) is None:
                    raise BackendError("No se pudo redefinir la máquina")
            except libvirt.libvirtError as exc:
                raise BackendError(str(exc))
        finally:
            conn.close()

    def attach_network(self, name: str, network: str, model: str = "virtio") -> None:
        """Conecta una nueva interfaz de red del dominio a una red de libvirt.
        Si la VM está encendida se conecta en caliente y se guarda también en la
        configuración persistente; si está apagada solo se añade a la config."""
        import html

        network = (network or "").strip()
        if not network:
            raise BackendError("Hay que indicar a qué red conectar la interfaz")
        model = (model or "virtio").strip() or "virtio"
        conn = self._open()
        try:
            dom = self._lookup(conn, name)
            try:
                conn.networkLookupByName(network)
            except libvirt.libvirtError:
                raise BackendError(f"No existe la red {network!r}")
            iface_xml = (
                "<interface type='network'>"
                f"<source network='{html.escape(network)}'/>"
                f"<model type='{html.escape(model)}'/>"
                "</interface>"
            )
            flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
            if dom.isActive():
                flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
            try:
                dom.attachDeviceFlags(iface_xml, flags)
            except libvirt.libvirtError as exc:
                raise BackendError(str(exc))
        finally:
            conn.close()

    def detach_network(self, name: str, mac: str) -> None:
        """Quita la interfaz de red cuya MAC se indica. Si la VM está encendida
        se desconecta en caliente y se quita también de la config persistente;
        si está apagada solo se quita de la config."""
        mac = (mac or "").strip().lower()
        if not mac:
            raise BackendError("Hay que indicar la MAC de la interfaz a quitar")
        conn = self._open()
        try:
            dom = self._lookup(conn, name)
            root = ET.fromstring(dom.XMLDesc(0))
            target = None
            for iface in root.findall("devices/interface"):
                m = iface.find("mac")
                if m is not None and (m.get("address") or "").strip().lower() == mac:
                    target = iface
                    break
            if target is None:
                raise BackendError(f"La máquina no tiene ninguna interfaz con MAC {mac}")
            iface_xml = ET.tostring(target, encoding="unicode")
            flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
            if dom.isActive():
                flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
            try:
                dom.detachDeviceFlags(iface_xml, flags)
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


def _cloud_user_data(hostname: str, username: str, password: str,
                     ssh_key: str, packages: list[str]) -> str:
    """Genera el #cloud-config (user-data NoCloud) para la máquina nueva.
    Los valores se serializan con JSON (escalar válido en YAML) para que
    contraseñas, claves y paquetes con caracteres raros no rompan el YAML."""
    import json as _json

    lines = [
        "#cloud-config",
        f"hostname: {_json.dumps(hostname)}",
        f"fqdn: {_json.dumps(hostname)}",
        "manage_etc_hosts: true",
        "users:",
        f"  - name: {_json.dumps(username)}",
        "    groups: [sudo]",
        '    sudo: "ALL=(ALL) NOPASSWD:ALL"',
        "    shell: /bin/bash",
        "    lock_passwd: false",
    ]
    if ssh_key:
        keys = [k.strip() for k in ssh_key.splitlines() if k.strip()]
        if keys:
            lines.append("    ssh_authorized_keys:")
            for k in keys:
                lines.append(f"      - {_json.dumps(k)}")
    lines.append("ssh_pwauth: true")
    if password:
        lines += [
            "chpasswd:",
            "  expire: false",
            "  users:",
            f"    - {{name: {_json.dumps(username)}, password: {_json.dumps(password)}, type: text}}",
        ]
    if packages:
        lines.append("package_update: true")
        lines.append("packages:")
        for p in packages:
            lines.append(f"  - {_json.dumps(p)}")
    return "\n".join(lines) + "\n"


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

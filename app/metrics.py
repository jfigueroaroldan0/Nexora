"""Métricas del host anfitrión vía psutil."""
from __future__ import annotations

import time
from typing import Any

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover
    psutil = None


def _gib(n: float) -> float:
    return round(n / (1024 ** 3), 1)


def host_metrics() -> dict[str, Any]:
    if psutil is None:
        return {"available": False}
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    try:
        load1 = psutil.getloadavg()[0]
    except (AttributeError, OSError):
        load1 = 0.0
    cpu_count = psutil.cpu_count() or 1
    boot = psutil.boot_time()
    return {
        "available": True,
        "cpu_percent": round(psutil.cpu_percent(interval=0.2), 1),
        "cpu_count": cpu_count,
        "load1": round(load1, 2),
        "mem_used_gib": _gib(vm.used),
        "mem_total_gib": _gib(vm.total),
        "mem_percent": vm.percent,
        "disk_used_gib": _gib(disk.used),
        "disk_total_gib": _gib(disk.total),
        "disk_percent": disk.percent,
        "uptime_seconds": int(time.time() - boot),
    }

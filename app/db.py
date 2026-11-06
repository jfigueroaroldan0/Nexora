"""Almacén SQLite de metadatos propios de Nexora.

Guarda lo que los backends (KVM/Docker/LXC) no tienen de forma uniforme:
módulo/asignatura, descripción, notas en Markdown y etiquetas de cada máquina.
La clave es el id estable de la máquina: ``<tipo>:<nombre>`` (p. ej. ``kvm:proxy``).
"""
from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any

from . import config

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS machine_meta (
                id          TEXT PRIMARY KEY,
                module      TEXT,
                description TEXT,
                notes       TEXT,
                tags        TEXT
            )
            """
        )
        _conn.execute(
            """
            CREATE TABLE IF NOT EXISTS modules (
                name  TEXT PRIMARY KEY,
                color TEXT
            )
            """
        )
        _conn.commit()
        _seed_modules()
    return _conn


def _seed_modules() -> None:
    assert _conn is not None
    cur = _conn.execute("SELECT COUNT(*) AS n FROM modules")
    if cur.fetchone()["n"] == 0:
        defaults = [
            ("SRI", "#2d7ff0"),
            ("SAD", "#0d9488"),
            ("ASO", "#8a5bf7"),
            ("IV", "#0ea5e9"),
            ("Implantación", "#d97706"),
            ("Bases de datos", "#c67a06"),
        ]
        _conn.executemany("INSERT INTO modules (name, color) VALUES (?, ?)", defaults)
        _conn.commit()


def _row_to_meta(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        return {"module": None, "description": "", "notes": "", "tags": []}
    return {
        "module": row["module"],
        "description": row["description"] or "",
        "notes": row["notes"] or "",
        "tags": json.loads(row["tags"]) if row["tags"] else [],
    }


def get_meta(machine_id: str) -> dict[str, Any]:
    with _lock:
        conn = _connect()
        row = conn.execute(
            "SELECT * FROM machine_meta WHERE id = ?", (machine_id,)
        ).fetchone()
    return _row_to_meta(row)


def all_meta() -> dict[str, dict[str, Any]]:
    with _lock:
        conn = _connect()
        rows = conn.execute("SELECT * FROM machine_meta").fetchall()
    return {row["id"]: _row_to_meta(row) for row in rows}


def set_meta(machine_id: str, **fields: Any) -> dict[str, Any]:
    """Actualiza (upsert) solo los campos indicados: module, description, notes, tags."""
    allowed = {"module", "description", "notes", "tags"}
    with _lock:
        conn = _connect()
        current = _row_to_meta(
            conn.execute(
                "SELECT * FROM machine_meta WHERE id = ?", (machine_id,)
            ).fetchone()
        )
        for key, value in fields.items():
            if key in allowed:
                current[key] = value
        conn.execute(
            """
            INSERT INTO machine_meta (id, module, description, notes, tags)
            VALUES (:id, :module, :description, :notes, :tags)
            ON CONFLICT(id) DO UPDATE SET
                module=:module, description=:description, notes=:notes, tags=:tags
            """,
            {
                "id": machine_id,
                "module": current["module"],
                "description": current["description"],
                "notes": current["notes"],
                "tags": json.dumps(current["tags"], ensure_ascii=False),
            },
        )
        conn.commit()
    return current


def list_modules() -> list[dict[str, Any]]:
    with _lock:
        conn = _connect()
        rows = conn.execute("SELECT name, color FROM modules ORDER BY name").fetchall()
    return [{"name": r["name"], "color": r["color"]} for r in rows]


def upsert_module(name: str, color: str | None = None) -> None:
    with _lock:
        conn = _connect()
        conn.execute(
            "INSERT INTO modules (name, color) VALUES (?, ?) "
            "ON CONFLICT(name) DO UPDATE SET color=excluded.color",
            (name, color),
        )
        conn.commit()


def delete_module(name: str) -> None:
    with _lock:
        conn = _connect()
        conn.execute("DELETE FROM modules WHERE name = ?", (name,))
        conn.commit()

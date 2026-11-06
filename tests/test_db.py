from app import db


def test_meta_roundtrip():
    db.set_meta("kvm:demo", module="SRI", description="web", tags=["nginx"])
    meta = db.get_meta("kvm:demo")
    assert meta["module"] == "SRI"
    assert meta["description"] == "web"
    assert meta["tags"] == ["nginx"]


def test_meta_partial_update():
    db.set_meta("docker:x", module="SAD")
    db.set_meta("docker:x", description="cambiada")
    meta = db.get_meta("docker:x")
    assert meta["module"] == "SAD"  # se conserva
    assert meta["description"] == "cambiada"


def test_default_modules_seeded():
    names = {m["name"] for m in db.list_modules()}
    assert "SRI" in names and "SAD" in names

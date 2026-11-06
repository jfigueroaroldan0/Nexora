from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert "backends" in body and "version" in body


def test_metrics():
    r = client.get("/api/metrics")
    assert r.status_code == 200
    assert "available" in r.json()


def test_machines_is_list():
    r = client.get("/api/machines")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_networks_is_list():
    r = client.get("/api/networks")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_modules():
    r = client.get("/api/modules")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_patch_meta():
    r = client.patch("/api/machines/kvm:apitest", json={"module": "BBDD", "description": "x"})
    assert r.status_code == 200
    assert r.json()["module"] == "BBDD"


def test_bad_action():
    r = client.post("/api/machines/kvm:whatever/action", json={"op": "explode"})
    assert r.status_code == 400

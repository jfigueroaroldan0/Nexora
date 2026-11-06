"""Configuración de tests: base de datos y datos en un directorio temporal."""
import os
import tempfile

# Debe fijarse ANTES de importar la app (config lee el entorno al importarse).
_tmp = tempfile.mkdtemp(prefix="nexora-test-")
os.environ.setdefault("NEXORA_DATA_DIR", _tmp)
os.environ.setdefault("NEXORA_DB", os.path.join(_tmp, "test.db"))
# Sin backends reales en CI.
os.environ.setdefault("NEXORA_BACKENDS", "kvm,docker,lxc")

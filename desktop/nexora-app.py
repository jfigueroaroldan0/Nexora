#!/usr/bin/env python3
"""Ventana de aplicación nativa de Nexora (GTK3 + WebKit2).

Muestra la interfaz de Nexora en una ventana propia, sin barra ni pestañas
de navegador, como una aplicación más del sistema.
"""
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GLib, Gtk, WebKit2  # noqa: E402

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"

# Para que GNOME asocie la ventana con el icono y la entrada de menú "nexora".
GLib.set_prgname("nexora")
try:
    Gtk.Window.set_default_icon_name("nexora")
except Exception:
    pass


class NexoraWindow(Gtk.Window):
    def __init__(self):
        super().__init__(title="Nexora")
        self.set_default_size(1280, 820)
        # Permitir encoger la ventana bastante (la UI es responsive por debajo
        # de 720px); sin esto WebKit impone un mínimo grande.
        self.set_size_request(380, 360)
        self._fullscreen = False
        try:
            self.set_wmclass("nexora", "Nexora")
        except Exception:
            pass
        icon_png = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nexora.png")
        try:
            if os.path.exists(icon_png):
                self.set_icon_from_file(icon_png)
        except Exception:
            pass

        self.webview = WebKit2.WebView()
        settings = self.webview.get_settings()
        settings.set_property("enable-developer-extras", True)
        self.webview.load_uri(URL)
        # Dentro de un ScrolledWindow para que la ventana pueda reducirse por
        # debajo del tamaño natural del contenido sin bloquearse.
        scroller = Gtk.ScrolledWindow()
        scroller.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scroller.add(self.webview)
        self.add(scroller)

        self.connect("destroy", Gtk.main_quit)
        self.connect("key-press-event", self._on_key)

    def _on_key(self, _widget, event):
        # Solo atajos que NO use una terminal; todo lo demás (Ctrl+W, Ctrl+C,
        # Ctrl+R, Ctrl+Q...) se deja pasar a la consola web.
        key = event.keyval
        if key == Gdk.KEY_F11:
            if self._fullscreen:
                self.unfullscreen()
            else:
                self.fullscreen()
            self._fullscreen = not self._fullscreen
            return True
        if key == Gdk.KEY_F5:
            # Recarga ignorando la caché de WebKit: tras actualizar los
            # estáticos, F5 trae siempre la última versión de la interfaz.
            self.webview.reload_bypass_cache()
            return True
        return False


def main():
    os.environ.setdefault("GDK_BACKEND", os.environ.get("GDK_BACKEND", ""))
    win = NexoraWindow()
    win.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()

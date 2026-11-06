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
        try:
            self.set_wmclass("nexora", "Nexora")
        except Exception:
            pass

        self.webview = WebKit2.WebView()
        settings = self.webview.get_settings()
        settings.set_property("enable-developer-extras", True)
        self.webview.load_uri(URL)
        self.add(self.webview)

        self.connect("destroy", Gtk.main_quit)
        self.connect("key-press-event", self._on_key)

    def _on_key(self, _widget, event):
        ctrl = event.state & Gdk.ModifierType.CONTROL_MASK
        key = event.keyval
        if ctrl and key in (Gdk.KEY_q, Gdk.KEY_w):
            self.close()
        elif key == Gdk.KEY_F5 or (ctrl and key == Gdk.KEY_r):
            self.webview.reload()
        elif ctrl and key in (Gdk.KEY_plus, Gdk.KEY_equal):
            self.webview.set_zoom_level(self.webview.get_zoom_level() + 0.1)
        elif ctrl and key == Gdk.KEY_minus:
            self.webview.set_zoom_level(max(0.5, self.webview.get_zoom_level() - 0.1))
        elif ctrl and key == Gdk.KEY_0:
            self.webview.set_zoom_level(1.0)
        else:
            return False
        return True


def main():
    os.environ.setdefault("GDK_BACKEND", os.environ.get("GDK_BACKEND", ""))
    win = NexoraWindow()
    win.show_all()
    Gtk.main()


if __name__ == "__main__":
    main()

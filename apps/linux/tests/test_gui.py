import os
import tempfile
import time
import unittest
from unittest.mock import patch


@unittest.skipUnless(os.environ.get("TERMRELAY_GUI_TEST") == "1", "requires Linux GTK/VTE and a display")
class GuiTests(unittest.TestCase):
    def test_window_and_vte_can_be_created_without_server(self):
        from termrelay.app import Application, GLib, Gtk

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"XDG_CONFIG_HOME": directory}):
            app = Application()
            app.register(None)
            app.activate()
            chooser = unittest.mock.MagicMock()
            chooser.run.return_value = Gtk.ResponseType.OK
            chooser.get_filename.return_value = directory
            try:
                with patch("termrelay.app.Gtk.FileChooserDialog", return_value=chooser):
                    app.new_shell()
                self.assertEqual(app.window.get_title(), "TermRelay Linux")
                self.assertEqual(app.notebook.get_n_pages(), 1)
                session_id = app.current_session()
                terminal = app.terminals[session_id]
                command = "printf '\\n__GTK_READY__\\n'\n"
                terminal.emit("commit", command, len(command))
                deadline = time.monotonic() + 5
                observed = b""
                while time.monotonic() < deadline:
                    while GLib.MainContext.default().pending():
                        GLib.MainContext.default().iteration(False)
                    app.tick()
                    observed = b"".join(app.protocol.sessions[session_id].pending.values())
                    if b"\r\n__GTK_READY__\r\n" in observed:
                        break
                    time.sleep(0.01)
                self.assertIn(b"\r\n__GTK_READY__\r\n", observed)
                self.assertIsNone(app.connection)
                self.assertNotIn("credential", app.config)
            finally:
                app.closing = True
                for process in app.processes.values():
                    if process.process.poll() is None:
                        process.close()
                app.window.destroy()
                app.quit()

import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Vte", "2.91")
from gi.repository import Gdk, Gio, GLib, Gtk, Vte

from . import pairing
from .protocol import Protocol, server_url
from .runtime import TerminalProcess
from .transport import RelayConnection


class Application(Gtk.Application):
    def __init__(self):
        super().__init__(application_id="io.github.termrelay.Linux", flags=Gio.ApplicationFlags.FLAGS_NONE)
        self.window = None
        self.closing = False
        self.events = queue.Queue(maxsize=512)
        self.connection = None
        self.generation = 0
        self.processes = {}
        self.terminals = {}
        self.workspace_ids = {}
        self.bound_url = None
        self.pair_cancel = threading.Event()
        self.config_path = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "termrelay" / "linux.json"
        try:
            self.config = json.loads(self.config_path.read_text())
            uuid.UUID(self.config["deviceId"])
            if not isinstance(self.config.get("serverURL"), str):
                raise ValueError("Invalid server URL")
        except FileNotFoundError:
            self.config = {"deviceId": str(uuid.uuid4()), "serverURL": "ws://localhost:3007/ws/client"}
        self.protocol = Protocol(
            self.config["deviceId"], socket.gethostname()[:128],
            self.send, self.remote_command,
        )
        self.save_config()

    def save_config(self):
        self.config_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.config_path.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(self.config, stream)
        temporary.replace(self.config_path)

    def do_activate(self):
        if self.window:
            self.window.present()
            return
        self.window = Gtk.ApplicationWindow(application=self, title="TermRelay Linux")
        self.window.set_default_size(1100, 760)
        self.window.connect("delete-event", self.on_close)
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=10)
        self.window.add(root)
        connection_bar = Gtk.Box(spacing=6)
        self.url = Gtk.Entry(text=self.config["serverURL"], hexpand=True)
        self.url.set_placeholder_text("ws://localhost:3007/ws/client")
        self.credential = Gtk.Entry(visibility=False)
        self.credential.set_placeholder_text("设备凭据（仅内存）")
        connection_bar.pack_start(self.url, True, True, 0)
        connection_bar.pack_start(self.credential, False, False, 0)
        for label, callback in (("连接", self.connect_server), ("断开", self.disconnect_server), ("公网配对", self.pair)):
            button = Gtk.Button(label=label)
            button.connect("clicked", callback)
            connection_bar.pack_start(button, False, False, 0)
        root.pack_start(connection_bar, False, False, 0)
        self.status = Gtk.Label(label="未连接；本地终端不依赖 Server", xalign=0)
        self.status.set_selectable(True)
        root.pack_start(self.status, False, False, 0)
        actions = Gtk.Box(spacing=6)
        for label, callback in (("新建 Shell（选择工作目录）", self.new_shell), ("Ctrl-C", self.interrupt), ("停止当前会话", self.stop)):
            button = Gtk.Button(label=label)
            button.connect("clicked", callback)
            actions.pack_start(button, False, False, 0)
        root.pack_start(actions, False, False, 0)
        self.notebook = Gtk.Notebook(scrollable=True)
        root.pack_start(self.notebook, True, True, 0)
        self.window.show_all()
        self.last_heartbeat = time.monotonic()
        self.heartbeat_interval = 15
        GLib.timeout_add(50, self.tick)

    def error(self, message):
        self.status.set_text(str(message))

    def enqueue(self, event):
        while not self.closing:
            try:
                self.events.put(event, timeout=0.1)
                return
            except queue.Full:
                continue

    def send(self, packet):
        if self.connection:
            self.connection.send(packet)

    def connect_server(self, _button=None):
        try:
            url = self.url.get_text().strip()
            server_url(url)
            if self.bound_url and self.bound_url != url:
                raise ValueError("本次运行已绑定其他 Server；请重启 App 后切换，避免会话历史混用")
            self.disconnect_server()
            generation = self.generation
            self.connection = RelayConnection(
                url, self.credential.get_text().strip(),
                lambda event: self.enqueue(("relay", (generation, event))),
            )
            self.bound_url = url
            self.config["serverURL"] = url
            self.save_config()
            self.connection.start()
            self.status.set_text("正在连接…")
        except (ValueError, OSError) as error:
            self.disconnect_server()
            self.error(error)

    def disconnect_server(self, _button=None):
        self.generation += 1
        if self.connection:
            self.connection.close()
            self.connection = None
        self.protocol.disconnected()
        self.status.set_text("已断开；本地会话继续运行")

    def pair(self, _button=None):
        try:
            url = self.url.get_text().strip()
            parsed = server_url(url)
            if parsed.scheme != "wss" or parsed.path != "/ws/client-public":
                raise ValueError("公网配对需要 wss://主机/ws/client-public")
        except ValueError as error:
            self.error(error)
            return
        self.pair_cancel.set()
        cancel = threading.Event()
        self.pair_cancel = cancel
        self.status.set_text("正在申请配对…")

        def work():
            try:
                session = pairing.create(url, self.protocol.device_id, self.protocol.name)
                verification = urlsplit(session["verificationURL"])
                if (verification.scheme != "https" or verification.netloc != parsed.netloc
                        or verification.username or verification.password):
                    raise ValueError("Server 返回了不受信任的配对地址")
                if cancel.is_set():
                    return
                self.enqueue(("pair-created", (cancel, session)))
                deadline = time.monotonic() + session["expiresIn"]
                while not cancel.wait(session["pollInterval"]):
                    if time.monotonic() >= deadline:
                        raise ValueError("配对已过期，请重试")
                    result = pairing.exchange(url, session)
                    if result["status"] == "issued":
                        self.enqueue(("pair-issued", (cancel, url, result["credential"])))
                        return
                    if result["status"] != "authorization_pending":
                        raise ValueError("配对已拒绝或过期")
            except (OSError, ValueError) as error:
                if not cancel.is_set():
                    self.enqueue(("error", f"配对失败：{error}"))

        threading.Thread(target=work, daemon=True).start()

    def new_shell(self, _button=None):
        if sum(p.process.poll() is None for p in self.processes.values()) >= 8 or len(self.processes) >= 128:
            self.error("最多同时运行 8 个会话，每次启动 App 最多创建 128 个会话")
            return
        dialog = Gtk.FileChooserDialog(
            title="选择本地工作目录", transient_for=self.window,
            action=Gtk.FileChooserAction.SELECT_FOLDER,
        )
        dialog.add_buttons("取消", Gtk.ResponseType.CANCEL, "打开", Gtk.ResponseType.OK)
        dialog.set_current_folder(str(Path.home()))
        response = dialog.run()
        directory = dialog.get_filename()
        dialog.destroy()
        if response != Gtk.ResponseType.OK or not directory:
            return
        try:
            path = Path(directory).resolve(strict=True)
            if not path.is_dir():
                raise ValueError("工作目录不存在")
            workspace_id = self.workspace_ids.setdefault(str(path), str(uuid.uuid4()))
            session_id = str(uuid.uuid4())
            terminal = Vte.Terminal()
            terminal.set_scrollback_lines(10000)
            terminal.set_mouse_autohide(True)
            terminal.connect("commit", self.local_input, session_id)
            terminal.connect("size-allocate", self.resize, session_id)
            terminal.connect("key-press-event", self.copy_paste)
            self.protocol.add_workspace(workspace_id, path.name[:128] or "Workspace")
            process = TerminalProcess(str(path), lambda event: self.enqueue(("pty", (session_id, event))))
            self.processes[session_id] = process
            self.terminals[session_id] = terminal
            scroll = Gtk.ScrolledWindow()
            scroll.add(terminal)
            scroll.session_id = session_id
            index = self.notebook.append_page(scroll, Gtk.Label(label=path.name[:32] or "Shell"))
            scroll.show_all()
            self.notebook.set_current_page(index)
            terminal.grab_focus()
            self.protocol.start(session_id, workspace_id)
        except (OSError, ValueError, BufferError) as error:
            if isinstance(error, BufferError):
                self.disconnect_server()
            self.error(error)

    def current_session(self):
        page = self.notebook.get_nth_page(self.notebook.get_current_page())
        return page.session_id if page else None

    def local_input(self, _terminal, text, _size, session_id):
        try:
            self.processes[session_id].command("terminal.input", text.encode("utf-8"))
        except (ValueError, OSError) as error:
            self.error(error)

    def copy_paste(self, terminal, event):
        modifiers = event.state & Gtk.accelerator_get_default_mod_mask()
        if modifiers == Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.SHIFT_MASK:
            if event.keyval in (Gdk.KEY_C, Gdk.KEY_c):
                terminal.copy_clipboard_format(Vte.Format.TEXT)
                return True
            if event.keyval in (Gdk.KEY_V, Gdk.KEY_v):
                terminal.paste_clipboard()
                return True
        return False

    def resize(self, terminal, _allocation, session_id):
        if session_id not in self.processes or self.processes[session_id].process.poll() is not None:
            return
        try:
            self.processes[session_id].command("terminal.resize", (
                max(1, min(1000, terminal.get_column_count())),
                max(1, min(1000, terminal.get_row_count())),
            ))
        except (ValueError, OSError) as error:
            self.error(error)

    def interrupt(self, _button=None):
        self.current_command("session.interrupt")

    def stop(self, _button=None):
        self.current_command("session.stop")

    def current_command(self, kind):
        session_id = self.current_session()
        if session_id:
            try:
                self.remote_command(session_id, kind, None)
            except (ValueError, OSError) as error:
                self.error(error)

    def remote_command(self, session_id, kind, value):
        self.processes[session_id].command(kind, value)
        if kind == "terminal.resize":
            self.terminals[session_id].set_size(*value)

    def handle_relay(self, generation, event):
        if generation != self.generation:
            return
        kind, value = event
        if kind == "connected":
            self.connection.main_epoch = value
            self.protocol.connected()
            self.status.set_text("正在注册 Linux 设备…")
        elif kind == "disconnected":
            epoch, reason = value
            if epoch != self.connection.main_epoch:
                return
            self.protocol.disconnected()
            self.status.set_text(f"连接中断（{reason}），正在重试；本地会话继续运行")
        elif kind == "message":
            epoch, packet = value
            if epoch != self.connection.main_epoch:
                return
            interval = self.protocol.receive(packet)
            if interval is not None:
                self.heartbeat_interval = interval / 1000
                self.protocol.heartbeat()
                self.status.set_text(f"在线 · Linux · {self.protocol.device_id}")
        elif kind == "unauthorized":
            self.disconnect_server()
            self.credential.set_text("")
            self.error("设备凭据无效或已过期，请重新配对")

    def handle_pty(self, session_id, event):
        kind, value = event
        if kind == "output":
            self.terminals[session_id].feed(value)
            if self.protocol.sessions[session_id].ended:
                return
            try:
                self.protocol.output(session_id, value)
            except BufferError as error:
                self.processes[session_id].command("session.stop")
                self.protocol.end(session_id, failed=True)
                self.error(error)
        elif kind == "exit":
            code, error = value
            already_failed = self.protocol.sessions[session_id].ended is not None
            self.protocol.end(session_id, failed=already_failed or (code != 0 and not self.processes[session_id].stopping))
            self.terminals[session_id].set_input_enabled(False)
            if error:
                self.error(error)
            elif code != 0 and not self.processes[session_id].stopping:
                self.error(f"Shell 异常退出，状态码 {code}")
        elif kind == "error":
            self.error(value)

    def tick(self):
        if self.closing:
            return False
        for _ in range(64):
            try:
                kind, value = self.events.get_nowait()
            except queue.Empty:
                break
            try:
                if kind == "relay":
                    self.handle_relay(*value)
                elif kind == "pty":
                    self.handle_pty(*value)
                elif kind == "pair-created":
                    cancel, session = value
                    if not cancel.is_set():
                        self.status.set_text(f'在浏览器授权，配对码：{session["userCode"]}')
                        Gtk.show_uri_on_window(self.window, session["verificationURL"], Gdk.CURRENT_TIME)
                elif kind == "pair-issued":
                    cancel, url, credential = value
                    if not cancel.is_set() and self.url.get_text().strip() == url:
                        self.credential.set_text(credential)
                        self.status.set_text("配对成功，凭据仅保存在内存中；点击连接")
                elif kind == "error":
                    self.error(value)
            except (ValueError, OSError, BufferError, GLib.Error) as error:
                self.disconnect_server()
                self.error(error)
        try:
            self.protocol.flush()
            if time.monotonic() - self.last_heartbeat >= self.heartbeat_interval:
                self.protocol.heartbeat()
                self.last_heartbeat = time.monotonic()
        except (ValueError, BufferError) as error:
            self.disconnect_server()
            self.error(error)
        return True

    def on_close(self, _window, _event):
        if (any(p.process.poll() is None for p in self.processes.values())
                or any(s.bytes for s in self.protocol.sessions.values())):
            dialog = Gtk.MessageDialog(
                transient_for=self.window, modal=True,
                message_type=Gtk.MessageType.WARNING, buttons=Gtk.ButtonsType.OK_CANCEL,
                text="退出将停止全部本地会话及其子进程，尚未同步的输出不会保留。确定退出？",
            )
            response = dialog.run()
            dialog.destroy()
            if response != Gtk.ResponseType.OK:
                return True
        self.closing = True
        self.pair_cancel.set()
        self.disconnect_server()
        for process in self.processes.values():
            if process.process.poll() is None:
                try:
                    process.close()
                except (OSError, subprocess.TimeoutExpired, queue.Full) as error:
                    print(f"PTY cleanup failed: {error}", file=sys.stderr)
        return False


def main():
    if sys.platform != "linux":
        raise SystemExit("TermRelay Linux 需要 Ubuntu / Xubuntu；macOS 请使用 apps/mac")
    try:
        app = Application()
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(f"无法读取 TermRelay 配置：{error}") from error
    return app.run(None)

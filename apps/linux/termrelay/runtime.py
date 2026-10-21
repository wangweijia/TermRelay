import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path


class TerminalProcess:
    def __init__(self, directory, events):
        self.events = events
        self.controls = queue.Queue(maxsize=128)
        env = os.environ.copy()
        env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent) + os.pathsep + env.get("PYTHONPATH", "")
        self.process = subprocess.Popen(
            [sys.executable, "-m", "termrelay.supervisor"],
            cwd=directory, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env,
        )
        self.stopping = False
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._write, daemon=True).start()

    def _read(self):
        while True:
            data = self.process.stdout.read1(32768)
            if not data:
                break
            self.events(("output", data))
        code = self.process.wait()
        error = self.process.stderr.read(4096).decode("utf-8", errors="replace")
        self.events(("exit", (code, error)))
        self.controls.put(None)

    def _write(self):
        try:
            while True:
                item = self.controls.get()
                if item is None:
                    break
                self.process.stdin.write(json.dumps(item).encode("ascii") + b"\n")
                self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            if self.process.poll() is None:
                self.events(("error", str(error)))
        finally:
            self.process.stdin.close()

    def command(self, kind, value=None):
        if self.process.poll() is not None:
            raise ValueError("PTY 进程已结束")
        if kind == "terminal.input":
            if not 1 <= len(value) <= 65536:
                raise ValueError("单次输入必须为 1–65536 字节")
            item = {"type": "input", "data": value.hex()}
        elif kind == "terminal.resize":
            item = {"type": "resize", "columns": value[0], "rows": value[1]}
        elif kind == "session.interrupt":
            item = {"type": "interrupt"}
        elif kind == "session.stop":
            item = {"type": "stop"}
            self.stopping = True
        else:
            raise ValueError("不支持此 PTY 操作")
        try:
            self.controls.put_nowait(item)
        except queue.Full as error:
            raise ValueError("PTY 输入过快，请稍后重试") from error

    def close(self):
        # EOF is also the crash-cleanup signal understood by the supervisor.
        try:
            self.controls.put_nowait(None)
        except queue.Full:
            self.controls.put(None, timeout=2)
        self.process.wait(timeout=5)

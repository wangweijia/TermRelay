import os
import queue
import shlex
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from termrelay.runtime import TerminalProcess


@unittest.skipUnless(os.name == "posix", "requires a real POSIX PTY")
class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.events = queue.Queue()
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"SHELL": "/bin/sh"})
        self.env.start()
        self.process = TerminalProcess(self.directory.name, self.events.put)
        self.output = bytearray()

    def tearDown(self):
        if self.process.process.poll() is None:
            self.process.close()
        self.process.process.stdout.close()
        self.process.process.stderr.close()
        self.env.stop()
        self.directory.cleanup()

    def until(self, marker, timeout=8):
        if marker in self.output:
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            kind, value = self.events.get(timeout=max(0.01, deadline - time.monotonic()))
            if kind == "output":
                self.output.extend(value)
                if marker in self.output:
                    return
            elif kind == "exit":
                self.fail(f"PTY exited before {marker!r}: {value}, {self.output!r}")
        self.fail(f"Missing {marker!r}: {self.output!r}")

    def test_real_pty_unicode_resize_and_exit(self):
        self.process.command("terminal.resize", (111, 37))
        self.process.command("terminal.input", b"stty size; printf '\\344\\270\\255\\346\\226\\207'; printf '\\n__READY__\\n'\n")
        self.until(b"37 111")
        self.until("中文".encode())
        self.until(b"\r\n__READY__\r\n")
        self.process.command("terminal.input", b"exit 0\n")
        self.assertEqual(self.process.process.wait(timeout=5), 0)

    def test_interrupt_and_stop_terminate_only_owned_processes(self):
        self.process.command("terminal.input", b"sleep 60; printf '\\n__INTERRUPTED__\\n'\n")
        time.sleep(0.2)
        self.process.command("session.interrupt")
        self.process.command("terminal.input", b"printf '\\n__AFTER__\\n'\n")
        self.until(b"\r\n__AFTER__\r\n")
        self.process.command("session.stop")
        self.process.process.wait(timeout=5)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux subreaper and /proc")
    def test_parent_pipe_eof_cleans_descendants(self):
        pidfile = os.path.join(self.directory.name, "child.pid")
        self.process.command("terminal.input", f"sleep 60 & echo $! > '{pidfile}'\n".encode())
        deadline = time.monotonic() + 5
        while (not os.path.exists(pidfile) or not os.path.getsize(pidfile)) and time.monotonic() < deadline:
            time.sleep(0.02)
        with open(pidfile) as stream:
            child_pid = int(stream.read())
        self.assert_child_cleaned(child_pid)

    @unittest.skipUnless(sys.platform == "linux", "requires Linux subreaper and /proc")
    def test_parent_pipe_eof_cleans_detached_orphans(self):
        pidfile = os.path.join(self.directory.name, "detached.pid")
        code = (
            "import subprocess,sys; from pathlib import Path; "
            "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],start_new_session=True); "
            "Path(sys.argv[1]).write_text(str(p.pid))"
        )
        self.process.command("terminal.input", (
            f"{shlex.quote(sys.executable)} -c {shlex.quote(code)} {shlex.quote(pidfile)}\n"
        ).encode())
        deadline = time.monotonic() + 5
        while (not os.path.exists(pidfile) or not os.path.getsize(pidfile)) and time.monotonic() < deadline:
            time.sleep(0.02)
        with open(pidfile) as stream:
            child_pid = int(stream.read())
        self.assert_child_cleaned(child_pid)

    def assert_child_cleaned(self, child_pid):
        self.process.close()
        # A killed orphan may briefly be a zombie until init reaps it.
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.kill(child_pid, 0)
            except ProcessLookupError:
                return
            stat = f"/proc/{child_pid}/stat"
            if os.path.exists(stat):
                with open(stat) as stream:
                    if stream.read().split()[2] == "Z":
                        return
            time.sleep(0.02)
        self.fail("Owned background child survived supervisor EOF")


if __name__ == "__main__":
    unittest.main()

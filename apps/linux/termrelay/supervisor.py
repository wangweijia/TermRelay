"""PTY owner: a closed parent pipe always tears down only our child group."""

import errno
import ctypes
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
from pathlib import Path


def signal_group(pid, sig):
    try:
        os.getpgid(pid)
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass


def owned_pids():
    parents = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            stat = (entry / "stat").read_text()
            parents[int(entry.name)] = int(stat[stat.rfind(")") + 2:].split()[1])
        except (FileNotFoundError, ProcessLookupError):
            continue
    owned = {os.getpid()}
    while True:
        children = {pid for pid, parent in parents.items() if parent in owned}
        if children <= owned:
            return owned - {os.getpid()}
        owned.update(children)


def terminate_owned(pid, sig):
    if sys.platform == "linux":
        for child in owned_pids():
            try:
                os.kill(child, sig)
            except ProcessLookupError:
                pass
    else:
        signal_group(pid, sig)


def run():
    if sys.platform == "linux":
        # Adopt orphaned jobs, including CLI subprocesses that create new sessions.
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(36, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Cannot become PTY child subreaper")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        shell = os.environ.get("SHELL") or "/bin/bash"
        os.execve(shell, [shell, "-l"], {**os.environ, "TERM": "xterm-256color"})
    os.close(slave)
    os.set_blocking(master, False)
    control = bytearray()
    pending = bytearray()
    stopping = None
    status = None
    try:
        while True:
            if status is None:
                reaped, child_status = os.waitpid(pid, os.WNOHANG)
                if reaped:
                    status = os.waitstatus_to_exitcode(child_status)
                    terminate_owned(pid, signal.SIGTERM)
                    stopping = time.monotonic() + 1
            if stopping is not None and time.monotonic() >= stopping:
                terminate_owned(pid, signal.SIGKILL)
            readable, writable, _ = select.select([0, master], [master] if pending else [], [], 0.1)
            if master in readable:
                try:
                    data = os.read(master, 32768)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            if 0 in readable:
                data = os.read(0, 65536)
                if not data:
                    break
                control.extend(data)
                if len(control) > 262144:
                    raise ValueError("PTY control queue exceeded its limit")
                while b"\n" in control:
                    line, _, control = control.partition(b"\n")
                    command = json.loads(line)
                    kind = command["type"]
                    if kind == "input":
                        pending.extend(bytes.fromhex(command["data"]))
                        if len(pending) > 1048576:
                            raise ValueError("PTY input queue exceeded 1 MiB")
                    elif kind == "resize":
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack(
                            "HHHH", command["rows"], command["columns"], 0, 0))
                    elif kind == "interrupt":
                        pending.extend(b"\x03")
                    elif kind == "stop":
                        terminate_owned(pid, signal.SIGTERM)
                        stopping = time.monotonic() + 1
                    else:
                        raise ValueError("Unknown PTY control command")
            if master in writable and pending:
                count = os.write(master, pending)
                del pending[:count]
            if status is not None and master not in readable:
                break
    finally:
        # A descendant may still be holding the slave after the shell exits.
        terminate_owned(pid, signal.SIGTERM)
        time.sleep(0.05)
        terminate_owned(pid, signal.SIGKILL)
        if status is None:
            _, child_status = os.waitpid(pid, 0)
            status = os.waitstatus_to_exitcode(child_status)
        os.close(master)
    return max(0, min(status if status >= 0 else 128 - status, 255))


if __name__ == "__main__":
    sys.exit(run())

import json
import queue
import threading
import time

from .protocol import server_url


class RelayConnection:
    def __init__(self, url, credential, events):
        parsed = server_url(url)
        if parsed.path == "/ws/client-public" and not credential:
            raise ValueError("公网连接需要先配对或输入设备凭据")
        self.url = url
        self.credential = credential
        if len(credential) > 240 or any(c.isspace() for c in credential):
            raise ValueError("设备凭据格式无效")
        try:
            import websocket
        except ImportError as error:
            raise ValueError("缺少 python3-websocket，请按 Linux README 安装系统依赖") from error
        self.websocket = websocket
        self.events = events
        self.outgoing = queue.Queue(maxsize=256)
        self.cancelled = threading.Event()
        self.main_epoch = 0
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def send(self, packet):
        try:
            self.outgoing.put_nowait((self.main_epoch, json.dumps(packet)))
        except queue.Full as error:
            raise BufferError("网络发送队列已满，已断开以便安全补传") from error

    def close(self):
        self.cancelled.set()

    def _run(self):
        websocket = self.websocket
        delay = 1
        epoch = 0
        while not self.cancelled.is_set():
            socket = None
            try:
                headers = [f"Authorization: Bearer {self.credential}"] if self.credential else []
                socket = websocket.create_connection(
                    self.url, header=headers, timeout=10, enable_multithread=True,
                    suppress_origin=True,
                )
                socket.settimeout(0.1)
                delay = 1
                epoch += 1
                self.events(("connected", epoch))
                last_ping = last_pong = time.monotonic()
                while not self.cancelled.is_set():
                    for _ in range(32):
                        try:
                            queued_epoch, packet = self.outgoing.get_nowait()
                            if queued_epoch == epoch:
                                socket.send(packet)
                        except queue.Empty:
                            break
                    current = time.monotonic()
                    if current - last_pong > 45:
                        raise TimeoutError("Server 心跳超时")
                    if current - last_ping > 15:
                        socket.ping()
                        last_ping = current
                    try:
                        opcode, data = socket.recv_data(control_frame=True)
                    except websocket.WebSocketTimeoutException:
                        continue
                    if opcode == websocket.ABNF.OPCODE_PONG:
                        last_pong = time.monotonic()
                        continue
                    if opcode == websocket.ABNF.OPCODE_PING:
                        continue
                    if opcode == websocket.ABNF.OPCODE_CLOSE:
                        raise ConnectionError("连接已关闭")
                    if opcode != websocket.ABNF.OPCODE_TEXT or len(data) > 1048576:
                        raise ValueError("Server 消息超过 1 MiB")
                    self.events(("message", (epoch, json.loads(data))))
            except (OSError, ValueError, websocket.WebSocketException) as error:
                if not self.cancelled.is_set():
                    if (isinstance(error, websocket.WebSocketBadStatusException)
                            and error.status_code in (401, 403)):
                        self.events(("unauthorized", None))
                        return
                    # Do not expose headers, credentials, or handshake bodies in UI/logs.
                    self.events(("disconnected", (epoch, type(error).__name__)))
            finally:
                if socket is not None:
                    socket.close()
                while True:
                    try:
                        self.outgoing.get_nowait()
                    except queue.Empty:
                        break
            if self.cancelled.wait(delay):
                break
            delay = min(delay * 2, 30)

import base64
import binascii
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from urllib.parse import urlsplit


MAX_BUFFER = 16 * 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def server_url(value):
    url = urlsplit(value)
    if (url.scheme not in ("ws", "wss") or not url.hostname
            or url.username or url.password or url.query or url.fragment
            or url.path not in ("/ws/client", "/ws/client-public")):
        raise ValueError("使用 ws(s)://主机/ws/client 或 wss://主机/ws/client-public")
    if url.path == "/ws/client-public" and url.scheme != "wss":
        raise ValueError("公网连接必须使用 wss://")
    return url


class SessionJournal:
    """Keep unacknowledged bytes; never silently truncate a replay gap."""

    def __init__(self, started):
        self.started = started
        self.pending = OrderedDict()
        self.next_seq = 1
        self.bytes = 0
        self.sent = 0
        self.acknowledged = 0
        self.ready = False
        self.ended = None
        self.end_sent = False

    def append(self, data):
        if self.bytes + len(data) > MAX_BUFFER:
            raise BufferError("远程未确认输出达到 16 MiB；已停止会话，防止丢失输出")
        self.pending[self.next_seq] = data
        self.next_seq += 1
        self.bytes += len(data)

    def acknowledge(self, seq):
        if type(seq) is not int or not 0 <= seq < self.next_seq:
            raise ValueError("Server 返回了无效的会话序号")
        if seq < self.acknowledged:
            raise ValueError("Server 缺少已确认的历史；无法安全补传")
        for key in list(self.pending):
            if key > seq:
                break
            self.bytes -= len(self.pending.pop(key))
        self.sent = seq
        self.acknowledged = seq
        self.ready = True

    def reconnect(self):
        self.ready = False
        self.end_sent = False


class Protocol:
    def __init__(self, device_id, name, send, command):
        self.device_id = device_id
        self.name = name
        self.send = send
        self.command = command
        self.registered = False
        self.workspaces = {}
        self.sessions = {}
        self.completed = OrderedDict()

    def envelope(self, kind, payload, session_id=None, **context):
        return {
            "type": kind, "protocolVersion": "2", "messageId": str(uuid.uuid4()),
            "deviceId": self.device_id, "sentAt": now(), "payload": payload,
            **({"sessionId": session_id} if session_id else {}), **context,
        }

    def publish(self, kind, payload, session_id=None, **context):
        self.send({"event": "message", "data": self.envelope(kind, payload, session_id, **context)})

    def connected(self):
        self.registered = False
        for session in self.sessions.values():
            session.reconnect()
        self.publish("device.register", {
            "name": self.name, "appVersion": "0.1.0", "platform": "linux", "tools": ["shell"],
        })

    def disconnected(self):
        self.registered = False

    def add_workspace(self, workspace_id, name):
        self.workspaces[workspace_id] = {
            "workspaceId": workspace_id, "displayName": name,
            "available": True, "remoteStartAllowed": False,
        }
        if self.registered:
            self.publish("workspace.registered", self.workspaces[workspace_id])

    def start(self, session_id, workspace_id):
        journal = SessionJournal({
            "workspaceId": workspace_id, "toolKey": "shell",
            "displayName": self.workspaces[workspace_id]["displayName"],
            "runtimeMode": "pty", "startedAt": now(),
        })
        self.sessions[session_id] = journal
        if self.registered:
            self.publish("session.started", journal.started, session_id, seq=0)

    def output(self, session_id, data):
        if sum(session.bytes for session in self.sessions.values()) + len(data) > MAX_BUFFER:
            raise BufferError("远程未确认输出总量达到 16 MiB；已停止会话，请恢复连接")
        self.sessions[session_id].append(data)

    def end(self, session_id, failed=False):
        self.sessions[session_id].ended = {
            "status": "failed" if failed else "finished", "finishedAt": now(),
        }

    def heartbeat(self):
        if self.registered:
            self.publish("device.heartbeat", {
                "connectionState": "connected",
                "activeSessionCount": sum(s.ended is None for s in self.sessions.values()),
            })

    def flush(self):
        if not self.registered:
            return
        for session_id, session in self.sessions.items():
            if not session.ready:
                continue
            # One window per ACK bounds socket queues and preserves event order.
            batch = [(seq, data) for seq, data in session.pending.items() if seq > session.sent][:32]
            if batch:
                for seq, data in batch:
                    self.publish("terminal.output", {
                        "encoding": "base64", "data": base64.b64encode(data).decode("ascii"),
                    }, session_id, seq=seq)
                    session.sent = seq
                session.ready = False
                self.publish("session.sync", {}, session_id)
            elif session.ended and not session.end_sent:
                self.publish("session.ended", session.ended, session_id)
                session.end_sent = True

    def receive(self, packet):
        if not isinstance(packet, dict) or packet.get("event") != "message":
            raise ValueError("无效的 Server 消息")
        message = packet.get("data")
        if (not isinstance(message, dict) or message.get("protocolVersion") != "2"
                or message.get("deviceId") != self.device_id
                or not isinstance(message.get("payload"), dict)):
            raise ValueError("Server 协议版本或设备身份不匹配")
        kind, payload = message.get("type"), message["payload"]
        if kind == "device.registered":
            interval = payload.get("heartbeatIntervalMs")
            if type(interval) is not int or interval < 1000:
                raise ValueError("无效的心跳间隔")
            self.registered = True
            for workspace in self.workspaces.values():
                self.publish("workspace.registered", workspace)
            for session_id, session in self.sessions.items():
                self.publish("session.started", session.started, session_id, seq=0)
            return interval
        if kind == "protocol.error":
            raise ValueError(f'Server: {payload.get("code")}: {payload.get("message")}')
        if kind == "client.authorization.revoked":
            raise PermissionError("设备授权已撤销，请重新配对")
        if not self.registered:
            raise ValueError("Server 在设备注册完成前发送命令")
        session_id = message.get("sessionId")
        if kind == "session.synced":
            if session_id not in self.sessions:
                raise ValueError("Server 引用了未知会话")
            self.sessions[session_id].acknowledge(payload.get("lastAcceptedSeq"))
        elif kind in ("terminal.input", "terminal.resize", "session.interrupt", "session.stop") or "commandId" in message:
            self.handle_command(message)
        else:
            raise ValueError(f"Linux 客户端不支持 {kind}")
        return None

    def handle_command(self, message):
        command_id = message.get("commandId")
        if not isinstance(command_id, str):
            raise ValueError("命令缺少 commandId")
        uuid.UUID(command_id)
        key = command_id.lower()
        session_id = message.get("sessionId")
        if key in self.completed:
            original_session, result = self.completed[key]
            if original_session != session_id:
                raise ValueError("commandId 被用于不同会话")
        else:
            try:
                if session_id not in self.sessions or self.sessions[session_id].ended:
                    raise ValueError("会话不存在或已结束")
                kind, payload = message["type"], message["payload"]
                if kind == "terminal.input":
                    encoded = payload.get("data")
                    if (payload.get("encoding") != "base64" or not isinstance(encoded, str)
                            or not 4 <= len(encoded) <= 87384):
                        raise ValueError("无效的终端输入")
                    value = base64.b64decode(encoded, validate=True)
                    if len(value) > 65536:
                        raise ValueError("单次输入不能超过 64 KiB")
                elif kind == "terminal.resize":
                    value = (payload.get("columns"), payload.get("rows"))
                    if any(type(n) is not int or not 1 <= n <= 1000 for n in value):
                        raise ValueError("终端尺寸必须在 1–1000 之间")
                elif kind in ("session.interrupt", "session.stop"):
                    value = None
                else:
                    raise ValueError("Linux 首版仅支持 PTY，不支持此命令")
                self.command(session_id, kind, value)
                result = {"commandId": command_id, "status": "completed"}
            except (ValueError, OSError, binascii.Error) as error:
                result = {
                    "commandId": command_id, "status": "rejected",
                    "errorCode": "invalid_command", "message": str(error),
                }
            self.completed[key] = (session_id, result)
            if len(self.completed) > 4096:
                self.completed.popitem(last=False)
        self.publish("command.ack", result, session_id, commandId=command_id)

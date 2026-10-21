import base64
import unittest
import uuid

from termrelay.protocol import MAX_BUFFER, Protocol, SessionJournal, server_url


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.packets = []
        self.commands = []
        self.client = Protocol(
            "linux-device", "Ubuntu", self.packets.append,
            lambda *args: self.commands.append(args),
        )
        self.client.add_workspace("workspace", "Project")
        self.client.start("session", "workspace")

    def message(self, kind, payload, **context):
        return {"event": "message", "data": {
            "type": kind, "protocolVersion": "2", "deviceId": "linux-device",
            "payload": payload, **context,
        }}

    def register(self):
        self.client.connected()
        self.client.receive(self.message("device.registered", {"heartbeatIntervalMs": 15000}))
        self.ack(0)

    def ack(self, seq):
        self.client.receive(self.message("session.synced", {"lastAcceptedSeq": seq}, sessionId="session"))

    def messages(self, kind):
        return [p["data"] for p in self.packets if p["data"]["type"] == kind]

    def test_registers_linux_without_paths_and_orders_replay(self):
        self.client.output("session", "中文 🐧\x1b[31m".encode())
        self.client.connected()
        self.assertEqual(self.messages("device.register")[0]["payload"]["platform"], "linux")
        self.client.flush()
        self.assertFalse(self.messages("terminal.output"))
        self.client.receive(self.message("device.registered", {"heartbeatIntervalMs": 15000}))
        self.assertEqual(
            [p["data"]["type"] for p in self.packets],
            ["device.register", "workspace.registered", "session.started"],
        )
        self.ack(0)
        self.client.flush()
        output = self.messages("terminal.output")[0]
        self.assertEqual(output["seq"], 1)
        self.assertEqual(base64.b64decode(output["payload"]["data"]), "中文 🐧\x1b[31m".encode())
        self.assertNotIn("path", str(self.packets))

    def test_reconnect_replays_only_unacknowledged_bytes(self):
        self.register()
        self.client.output("session", b"one")
        self.client.output("session", b"two")
        self.client.flush()
        self.ack(1)
        self.client.disconnected()
        self.client.connected()
        self.client.receive(self.message("device.registered", {"heartbeatIntervalMs": 15000}))
        self.ack(1)
        self.packets.clear()
        self.client.flush()
        self.assertEqual([p["seq"] for p in self.messages("terminal.output")], [2])
        self.ack(2)
        self.assertEqual(self.client.sessions["session"].bytes, 0)
        with self.assertRaises(ValueError):
            self.ack(0)

    def test_ending_waits_for_final_ack_and_reannounces_after_reconnect(self):
        self.register()
        self.client.output("session", b"last")
        self.client.end("session")
        self.client.flush()
        self.assertFalse(self.messages("session.ended"))
        self.ack(1)
        self.client.flush()
        self.assertEqual(len(self.messages("session.ended")), 1)
        self.client.flush()
        self.assertEqual(len(self.messages("session.ended")), 1)
        self.client.connected()
        self.client.receive(self.message("device.registered", {"heartbeatIntervalMs": 15000}))
        self.ack(1)
        self.client.flush()
        self.assertEqual(len(self.messages("session.ended")), 2)

    def test_output_window_is_bounded_until_ack(self):
        self.register()
        for _ in range(100):
            self.client.output("session", b"x")
        self.client.flush()
        self.client.flush()
        self.assertEqual(len(self.messages("terminal.output")), 32)
        self.ack(32)
        self.client.flush()
        self.assertEqual(len(self.messages("terminal.output")), 64)

    def test_output_memory_limit_is_exact_and_global(self):
        journal = SessionJournal({})
        journal.append(b"x" * MAX_BUFFER)
        self.assertEqual(journal.bytes, MAX_BUFFER)
        with self.assertRaises(BufferError):
            journal.append(b"x")
        self.client.output("session", b"x" * MAX_BUFFER)
        self.client.start("second", "workspace")
        with self.assertRaises(BufferError):
            self.client.output("second", b"x")

    def test_commands_are_deduplicated_and_bound_to_session(self):
        self.register()
        command_id = str(uuid.uuid4())
        packet = self.message("terminal.input", {
            "encoding": "base64", "data": base64.b64encode(b"ls\n").decode(),
        }, sessionId="session", commandId=command_id)
        self.client.receive(packet)
        self.client.receive(packet)
        self.assertEqual(self.commands, [("session", "terminal.input", b"ls\n")])
        self.assertEqual(len(self.messages("command.ack")), 2)
        packet["data"]["sessionId"] = "other"
        with self.assertRaises(ValueError):
            self.client.receive(packet)

    def test_rejects_invalid_input_resize_and_acp(self):
        self.register()
        for kind, payload in (
            ("terminal.input", {"encoding": "base64", "data": "%%%"}),
            ("terminal.resize", {"columns": True, "rows": 24}),
            ("terminal.resize", {"columns": 1001, "rows": 24}),
            ("tool.turn.start", {"text": "hello"}),
        ):
            self.client.receive(self.message(kind, payload, sessionId="session", commandId=str(uuid.uuid4())))
            self.assertEqual(self.messages("command.ack")[-1]["payload"]["status"], "rejected")
        self.assertFalse(self.commands)

    def test_resize_interrupt_stop_and_failed_command(self):
        self.register()
        for kind, payload in (
            ("terminal.resize", {"columns": 120, "rows": 40}),
            ("session.interrupt", {}), ("session.stop", {}),
        ):
            self.client.receive(self.message(kind, payload, sessionId="session", commandId=str(uuid.uuid4())))
        self.assertEqual(self.commands, [
            ("session", "terminal.resize", (120, 40)),
            ("session", "session.interrupt", None),
            ("session", "session.stop", None),
        ])
        self.client.end("session")
        self.client.receive(self.message("session.stop", {}, sessionId="session", commandId=str(uuid.uuid4())))
        self.assertEqual(self.messages("command.ack")[-1]["payload"]["status"], "rejected")

    def test_rejects_version_device_and_revocation(self):
        self.register()
        for key, value in (("deviceId", "other"), ("protocolVersion", "999")):
            packet = self.message("session.synced", {"lastAcceptedSeq": 0}, sessionId="session")
            packet["data"][key] = value
            with self.assertRaises(ValueError):
                self.client.receive(packet)
        with self.assertRaises(PermissionError):
            self.client.receive(self.message("client.authorization.revoked", {}))

    def test_server_urls(self):
        for url in ("ws://localhost:3007/ws/client", "wss://example.com/ws/client-public"):
            server_url(url)
        for url in (
            "https://example.com/ws/client", "ws://host/ws/client-public",
            "wss://user:password@host/ws/client", "wss://host/ws/client?credential=secret",
            "wss://host/other", "wss://host/ws/client#secret",
        ):
            with self.assertRaises(ValueError):
                server_url(url)


if __name__ == "__main__":
    unittest.main()

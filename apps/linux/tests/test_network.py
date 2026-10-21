import json
import types
import unittest
from unittest.mock import MagicMock, patch

from termrelay import pairing
from termrelay.transport import RelayConnection


class SocketError(Exception):
    pass


class SocketTimeout(SocketError):
    pass


class BadStatus(SocketError):
    status_code = 401


class NetworkTests(unittest.TestCase):
    def module(self, socket):
        return types.SimpleNamespace(
            create_connection=MagicMock(return_value=socket),
            WebSocketTimeoutException=SocketTimeout,
            WebSocketException=SocketError,
            WebSocketBadStatusException=BadStatus,
            ABNF=types.SimpleNamespace(OPCODE_TEXT=1, OPCODE_CLOSE=8, OPCODE_PING=9, OPCODE_PONG=10),
        )

    def test_socket_epochs_drop_stale_packets_and_use_header_auth(self):
        socket = MagicMock()
        socket.recv_data.return_value = (1, b'{"event":"message","data":{}}')
        module = self.module(socket)
        events = []

        def receive(event):
            events.append(event)
            if event[0] == "connected":
                connection.main_epoch = event[1]
                connection.send({"type": "device.register"})
            elif event[0] == "message":
                connection.close()

        with patch.dict("sys.modules", {"websocket": module}):
            connection = RelayConnection("wss://example.com/ws/client-public", "secret", receive)
            connection.send({"type": "stale-output"})
            connection._run()
        self.assertEqual(json.loads(socket.send.call_args.args[0]), {"type": "device.register"})
        self.assertEqual(socket.send.call_count, 1)
        self.assertEqual(module.create_connection.call_args.kwargs["header"], ["Authorization: Bearer secret"])
        self.assertEqual(events[1][1][0], 1)
        self.assertTrue(socket.close.called)

    def test_unauthorized_stops_without_exposing_handshake_body(self):
        module = self.module(MagicMock())
        module.create_connection.side_effect = BadStatus("sensitive response")
        events = []
        with patch.dict("sys.modules", {"websocket": module}):
            connection = RelayConnection("wss://example.com/ws/client-public", "secret", events.append)
            connection._run()
        self.assertEqual(events, [("unauthorized", None)])
        self.assertNotIn("secret", str(events))

    def test_send_queue_has_a_hard_bound(self):
        with patch.dict("sys.modules", {"websocket": self.module(MagicMock())}):
            connection = RelayConnection("ws://localhost/ws/client", "", lambda _: None)
            for _ in range(256):
                connection.send({})
            with self.assertRaises(BufferError):
                connection.send({})

    def test_public_connection_requires_credential_and_rejects_header_injection(self):
        for credential in ("", "abc\r\nX-Other: yes", "a" * 241):
            with self.assertRaises(ValueError):
                RelayConnection("wss://example.com/ws/client-public", credential, lambda _: None)

    def test_pairing_request_uses_https_and_validates_exchange(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"status":"issued","credential":"secret"}'
        with patch("termrelay.pairing.urlopen", return_value=response) as open_url:
            result = pairing.exchange("wss://example.com/ws/client-public", {
                "pairingId": "pair", "deviceCode": "code",
            })
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.com/api/client-pairings/token")
        self.assertEqual(json.loads(request.data), {"pairingId": "pair", "deviceCode": "code"})
        self.assertEqual(result["credential"], "secret")
        for result in ({"status": "issued"}, {"status": "unknown"}):
            with patch("termrelay.pairing.request", return_value=result):
                with self.assertRaises(ValueError):
                    pairing.exchange("wss://example.com/ws/client-public", {"pairingId": "p", "deviceCode": "d"})
        with self.assertRaises(ValueError):
            pairing.create("ws://localhost/ws/client", "device", "Linux")


if __name__ == "__main__":
    unittest.main()

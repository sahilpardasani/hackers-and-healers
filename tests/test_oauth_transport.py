import base64
import hashlib
from pathlib import Path
import socket
import ssl
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlparse

from cryptography import x509
from flask import Flask
from werkzeug.serving import make_server

import app as service
from local_server import server_options


class LocalTransportTests(unittest.TestCase):
    def test_https_uses_callback_port_and_reuses_loopback_certificate(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            options = server_options("https://127.0.0.1:3000/callback", directory)
            self.assertEqual((options["host"], options["port"]), ("127.0.0.1", 3000))
            self.assertIsInstance(options["ssl_context"], ssl.SSLContext)
            original = (directory / "localhost.crt").read_bytes()
            cert = x509.load_pem_x509_certificate(original)
            names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            self.assertIn("127.0.0.1", [str(ip) for ip in names.get_values_for_type(x509.IPAddress)])
            self.assertEqual((directory / "localhost.key").stat().st_mode & 0o777, 0o600)
            server_options("https://127.0.0.1:3000/callback", directory)
            self.assertEqual(original, (directory / "localhost.crt").read_bytes())

    def test_idle_tls_client_does_not_block_other_connections(self):
        with tempfile.TemporaryDirectory() as temporary:
            options = server_options("https://127.0.0.1:0/callback", Path(temporary))
            server = make_server("127.0.0.1", 0, Flask(__name__), threaded=True,
                                 ssl_context=options["ssl_context"])
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.shutdown)
            port = server.socket.getsockname()[1]
            # Like a browser preconnect: open TCP, never start the TLS handshake.
            idle = socket.create_connection(("127.0.0.1", port))
            self.addCleanup(idle.close)
            client = ssl.create_default_context()
            client.check_hostname, client.verify_mode = False, ssl.CERT_NONE
            with socket.create_connection(("127.0.0.1", port), timeout=5) as raw, \
                    client.wrap_socket(raw) as tls:
                tls.sendall(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                self.assertTrue(tls.recv(64).startswith(b"HTTP/1.1"))

    def test_http_remains_available_for_http_registrations(self):
        self.assertEqual(server_options("http://127.0.0.1:3000/callback"),
                         {"host": "127.0.0.1", "port": 3000})

    def test_local_server_rejects_an_unserviceable_callback(self):
        for callback in ("https://example.org/callback", "https://127.0.0.1:3000/wrong",
                         "https://user@127.0.0.1:3000/callback"):
            with self.subTest(callback=callback), self.assertRaises(ValueError):
                server_options(callback)


class OAuthTransportTests(unittest.TestCase):
    def setUp(self):
        service.pending_auth.clear()
        self.addCleanup(service.pending_auth.clear)

    def test_authorization_and_token_exchange_use_same_https_callback_with_pkce(self):
        base = "https://ehr.example.test/FHIR/R4"
        callback = "https://127.0.0.1:3000/callback"
        metadata = {"authorization_endpoint": "https://ehr.example.test/authorize",
                    "token_endpoint": "https://ehr.example.test/token"}
        response = Mock()
        response.json.return_value = {"access_token": "test-only", "patient": "synthetic"}
        with patch.object(service, "REDIRECT_URI", callback), \
                patch.object(service, "CLIENT_ID", "test-client"), \
                patch.object(service, "CLIENT_SECRET", "test-secret"), \
                patch.object(service, "_known_endpoints", return_value=[{"name": "Test", "url": base}]), \
                patch.object(service, "_metadata", return_value=metadata), \
                patch.object(service.requests, "post", return_value=response) as exchange, \
                patch.object(service.storage, "save_connection") as save, \
                patch.object(service.threading, "Thread"):
            client = service.app.test_client()
            authorization = client.post("/connect", data={"endpoint": base}, base_url="https://127.0.0.1:3000")
            params = parse_qs(urlparse(authorization.location).query)
            self.assertEqual(params["redirect_uri"], [callback])
            completed = client.get("/callback", query_string={"state": params["state"][0], "code": "test-code"},
                                   base_url="https://127.0.0.1:3000")
            self.assertEqual(completed.status_code, 302)
            self.assertEqual(completed.location, "/")
            data = exchange.call_args.kwargs["data"]
            self.assertEqual(data["redirect_uri"], callback)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(data["code_verifier"].encode()).digest()).rstrip(b"=").decode()
            self.assertEqual(params["code_challenge"], [challenge])
            save.assert_called_once()
            exchange.reset_mock()
            client.get("/callback", query_string={"state": params["state"][0], "code": "test-code"},
                       base_url="https://127.0.0.1:3000")
            exchange.assert_not_called()


if __name__ == "__main__":
    unittest.main()

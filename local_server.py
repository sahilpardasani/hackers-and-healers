"""Loopback server settings and a persistent development TLS certificate."""

from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
from pathlib import Path
import os
import ssl
from urllib.parse import urlparse

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


class _DeferredHandshakeContext(ssl.SSLContext):
    """Run each TLS handshake in its request thread, not the accept loop.

    Werkzeug wraps the listening socket, so by default every handshake runs
    inside accept(). One idle browser connection (e.g. a preconnect) then
    blocks all other clients.
    """

    def wrap_socket(self, sock, *args, **kwargs):
        kwargs["do_handshake_on_connect"] = False
        return super().wrap_socket(sock, *args, **kwargs)


def server_options(redirect_uri: str, cert_dir: Path | None = None, use_ssl: bool = True) -> dict:
    """Serve the same scheme/port as the registered callback, on loopback only.

    The self-signed certificate is for local testing. It is kept across restarts
    so a browser's local certificate exception remains valid. This never changes
    the system trust store or disables certificate validation for Epic requests.
    """
    uri = urlparse(redirect_uri)
    if (uri.scheme not in {"http", "https"}
            or uri.hostname not in {"127.0.0.1", "localhost"}
            or uri.path != "/callback" or uri.query or uri.fragment
            or uri.username is not None or uri.password is not None):
        raise ValueError("This local demo requires REDIRECT_URI=http(s)://127.0.0.1:<port>/callback.")
    options = {"host": "127.0.0.1", "port": uri.port or (443 if uri.scheme == "https" else 80)}
    if uri.scheme == "http" or not use_ssl:
        return options

    directory = cert_dir or Path(__file__).resolve().parent / "data" / "local-tls"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    cert_path, key_path = directory / "localhost.crt", directory / "localhost.key"
    if not cert_path.exists() and not key_path.exists():
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Hackers & Healers local development")])
        now = datetime.now(timezone.utc)
        cert = (
            x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName([
                x509.IPAddress(ip_address("127.0.0.1")), x509.DNSName("localhost")
            ]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([x509.OID_SERVER_AUTH]), critical=False)
            .sign(key, hashes.SHA256())
        )
        with os.fdopen(os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(key.private_bytes(serialization.Encoding.PEM,
                                          serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    if not cert_path.is_file() or not key_path.is_file():
        raise RuntimeError("The local TLS certificate/key pair is incomplete in data/local-tls.")
    context = _DeferredHandshakeContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert_path, key_path)
    options["ssl_context"] = context
    options["ssl_certfile"] = str(cert_path)
    options["ssl_keyfile"] = str(key_path)
    return options


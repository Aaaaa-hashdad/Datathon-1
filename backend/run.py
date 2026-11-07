"""Start RevGym on this PC.

- PC app:          http://127.0.0.1:8000      (only this PC can open it)
- Phone camera:    https://<this PC's Wi-Fi address>:8443/phone   (what the QR code opens)

Phones only allow live camera access on https, so the phone side uses a
self-signed certificate made here on first run (saved in backend/certs/).
The phone will warn about it once; that's expected for a local certificate.

Usage: python run.py
"""

import asyncio
import contextlib
import datetime
import ipaddress
import os
import socket
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
CERT_DIR = BACKEND_DIR / "certs"
PC_PORT = int(os.getenv("PC_PORT", "8000"))
PHONE_PORT = int(os.getenv("PHONE_HTTPS_PORT", "8443"))


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_certificate(ip: str) -> tuple[Path, Path]:
    """A self-signed cert for this PC's Wi-Fi address. Remade if the address changes."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    cert_path, key_path = CERT_DIR / "phone-cert.pem", CERT_DIR / "phone-key.pem"
    if cert_path.exists() and key_path.exists():
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        sans = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        still_valid = cert.not_valid_after_utc > datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7)
        if ipaddress.ip_address(ip) in sans.get_values_for_type(x509.IPAddress) and still_valid:
            return cert_path, key_path

    CERT_DIR.mkdir(exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "RevGym on this PC")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName([
            x509.IPAddress(ipaddress.ip_address(ip)),
            x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
            x509.DNSName("localhost"),
        ]), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


def main() -> None:
    import uvicorn

    ip = lan_ip()
    cert, key = ensure_certificate(ip)
    # Tell the app where the phone page lives before it's imported.
    os.environ["PHONE_HTTPS_PORT"] = str(PHONE_PORT)
    sys.path.insert(0, str(BACKEND_DIR))
    from app.main import app

    class Server(uvicorn.Server):
        # Two servers share one process; let Ctrl+C stop both together.
        @contextlib.contextmanager
        def capture_signals(self):
            yield

    pc = Server(uvicorn.Config(app, host="127.0.0.1", port=PC_PORT, log_level="info"))
    phone = Server(uvicorn.Config(app, host="0.0.0.0", port=PHONE_PORT, log_level="info",
                                  ssl_certfile=str(cert), ssl_keyfile=str(key)))

    print(f"\n  RevGym is running.\n  PC app:       http://127.0.0.1:{PC_PORT}\n"
          f"  Phone camera: https://{ip}:{PHONE_PORT}/phone  (use the QR code in the app)\n")

    async def serve_both():
        await asyncio.gather(pc.serve(), phone.serve())

    try:
        asyncio.run(serve_both())
    except KeyboardInterrupt:
        print("Stopped.")


if __name__ == "__main__":
    main()

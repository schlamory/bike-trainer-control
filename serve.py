#!/usr/bin/env python3
"""Serve the PWA on localhost, which Web Bluetooth accepts as a secure context.

    uv run serve.py            # http://localhost:8756
    uv run serve.py -p 9000

Then open it in Chrome or Edge and press Connect trainer. Nothing else may hold
the trainer's single BLE connection -- quit Zwift, the Saris app, and any Python
script from this repo first.
"""

import argparse
import functools
import http.server
import socketserver
import webbrowser
from pathlib import Path

WEB = Path(__file__).parent / "web"


def lan_ip() -> str:
    """Best-effort local address, found without sending anything."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 1))   # TEST-NET-1, never routed
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # No caching, so an edit shows up on reload during development.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=8756)
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--lan", action="store_true",
                    help="bind all interfaces so a phone on the same network can reach it")
    args = ap.parse_args()

    host = "0.0.0.0" if args.lan else "127.0.0.1"
    url = f"http://localhost:{args.port}"
    handler = functools.partial(Handler, directory=str(WEB))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((host, args.port), handler) as httpd:
        print(f"Serving {WEB} at {url}")
        if args.lan:
            print(f"On the same network:  http://{lan_ip()}:{args.port}")
            print("\nNote: Web Bluetooth normally requires a secure context, which plain\n"
                  "http:// over the LAN is not. The diagnostics page reports isSecureContext,\n"
                  "so load it first and see whether this browser actually enforces it.")
        print("Ctrl-C to stop.")
        if not args.no_open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()

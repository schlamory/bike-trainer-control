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
    args = ap.parse_args()

    url = f"http://localhost:{args.port}"
    handler = functools.partial(Handler, directory=str(WEB))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as httpd:
        print(f"Serving {WEB} at {url}\nCtrl-C to stop.")
        if not args.no_open:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()

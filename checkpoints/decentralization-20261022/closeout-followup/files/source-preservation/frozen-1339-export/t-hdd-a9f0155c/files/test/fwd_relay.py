#!/usr/bin/env python3
"""guestfwd `cmd:` relay (test fixture only). QEMU runs one copy per guest TCP connection, with that connection on
stdin/stdout. It connects to ONE fixed 127.0.0.1 port and copies bytes both ways until either side closes."""
import os
import socket
import sys
import threading

host, port = sys.argv[1], int(sys.argv[2])
if host != "127.0.0.1":
    sys.exit("relay only targets 127.0.0.1")
s = socket.create_connection((host, port), timeout=10)
s.settimeout(None)


def up():
    try:
        while True:
            b = os.read(0, 65536)
            if not b:
                break
            s.sendall(b)
    except OSError:
        pass
    try:
        s.shutdown(socket.SHUT_WR)
    except OSError:
        pass


threading.Thread(target=up, daemon=True).start()
try:
    while True:
        b = s.recv(65536)
        if not b:
            break
        os.write(1, b)
except OSError:
    pass
os._exit(0)

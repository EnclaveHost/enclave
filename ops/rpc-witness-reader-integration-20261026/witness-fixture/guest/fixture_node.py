#!/usr/bin/env python3
"""witness-rpc-live-canary-stage/r2: a DISPOSABLE fixture standing in for a node IPC socket (NOT a node): answers every JSON-RPC request with
{"result": "fixture:<method>"}; the socket is created 0600 by this (rpcbase) process at the given private path."""
import json, os, socket, sys
p = sys.argv[1]; s = socket.socket(socket.AF_UNIX); s.bind(p); os.chmod(p, 0o600); s.listen(4)
while True:
    c, _ = s.accept(); b = b''
    while not b.endswith(b'\n'):
        d = c.recv(65536)
        if not d:
            break
        b += d
    r = json.loads(b); c.sendall(json.dumps({'jsonrpc': '2.0', 'id': r.get('id'), 'result': 'fixture:' + r['method']}).encode()); c.close()

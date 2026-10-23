#!/usr/bin/env python3
"""TEST STAND-IN for the `base` binary (NOT a Base client). The supervisor runs it with the rendered argv and its clean
environment. It records both, serves eth_chainId/eth_blockNumber on the rendered --http.port (127.0.0.1), and follows
a behavior file next to it (<this file>.mode, JSON):
  chain      chain id hex to answer (default 0x2105)
  termDelay  seconds to wait after SIGTERM before exiting 0 (default 0); "ignore" = never exit on SIGTERM
  exitAfter  exit by itself with exitCode after this many seconds
  grandchild spawn a sleeping grandchild in the same process group (records its pid)"""
import json
import os
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

me = os.path.realpath(sys.argv[0])
mode = json.load(open(me + '.mode'))
out = mode['recordDir']
port = int(sys.argv[sys.argv.index('--http.port') + 1])
addr = sys.argv[sys.argv.index('--http.addr') + 1]
with open(os.path.join(out, 'argv.json'), 'w') as f:
    json.dump(sys.argv, f)
with open(os.path.join(out, 'env.json'), 'w') as f:
    json.dump(dict(os.environ), f)


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        res = {'eth_chainId': mode.get('chain', '0x2105'), 'eth_blockNumber': '0x1'}.get(req['method'])
        body = json.dumps({'jsonrpc': '2.0', 'id': req['id'], 'result': res}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = HTTPServer((addr, port), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
if mode.get('grandchild'):
    g = subprocess.Popen(['sleep', '600'])
    open(os.path.join(out, 'grandchild.pid'), 'w').write(str(g.pid))
open(os.path.join(out, 'child.pid'), 'w').write(str(os.getpid()))
stop = threading.Event()


def term(*_):
    if mode.get('termDelay') == 'ignore':
        return
    threading.Timer(float(mode.get('termDelay', 0)), stop.set).start()


signal.signal(signal.SIGTERM, term)
deadline = time.monotonic() + mode['exitAfter'] if 'exitAfter' in mode else None
while not stop.is_set():
    if deadline and time.monotonic() > deadline:
        sys.exit(mode.get('exitCode', 3))
    time.sleep(0.05)
srv.shutdown()
sys.exit(0)

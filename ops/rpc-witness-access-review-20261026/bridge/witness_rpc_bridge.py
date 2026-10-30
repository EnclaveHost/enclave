#!/usr/bin/env python3
"""witness-rpc-access-stage (PREPARED; NOT run): the PRIVATE, loopback-only JSON-RPC bridge that makes witness acquisition possible
without exposing `debug` on any forwarded/public RPC.

Why a bridge: witness_fetch (zk-witness examples/witness_fetch.rs -> base-proof-zk-witness) needs debug_* on the guest's own ELs but
accepts only http://127.0.0.1:<port> endpoints. The ELs' HTTP servers (Base 18545, L1 18645) are forwarded VERBATIM by
systemd-socket-proxyd to host 28545/28645 (provision_vm.py proxy_units), so `debug` must never be added to --http.api. reth's IPC server
serves ALL modules (reth 7134be3 rpc-server-types/src/module.rs default_ipc_modules = all_modules; v2.8.0 the same flag set), so the
wrapper overlay enables IPC on a PRIVATE 0600 socket in the node's own 0750 tmp subtree; this bridge, running as the node's user, relays
ONLY the read-only methods below and refuses everything else (admin_*, txpool_*, debug_clearTxpool, debug_trace*, eth_send*, ...) BEFORE
touching the socket. It is never forwarded, has no [Install] (root starts it for a witness run and stops it after), and is bounded.

  witness_rpc_bridge.py base-el | l1-el
Methods (exactly what witness_fetch's crate + combined-r1/runner/runner.py call; an unlisted call fails closed with -32601 naming it):
  base-el (Base EL IPC):  eth_chainId eth_syncing eth_blockNumber eth_getBlockByNumber eth_getBlockByHash eth_getProof
                          debug_executePayload (Base node.rs:629, in-memory, semaphore 3) debug_getRawHeader debug_dbGet (0x63||codehash only)
  l1-el   (L1 EL IPC):    eth_chainId eth_syncing eth_blockNumber eth_getBlockByNumber eth_getBlockByHash debug_getRawHeader debug_getRawReceipts
optimism_rollupConfig / optimism_outputAtBlock are served by the Base node's own loopback rollup RPC 127.0.0.1:19545 (always on); the
bridge does not relay them."""
import http.server, json, os, pathlib, socket, stat, sys, threading

READ_ETH = ('eth_chainId', 'eth_syncing', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash')
PROFILES = {
    'base-el': {'listen': ('127.0.0.1', 18547), 'ipc': '/srv/enclave-base-holder/tmp/witness-el.ipc',
                'methods': frozenset(READ_ETH + ('eth_getProof', 'debug_executePayload', 'debug_getRawHeader', 'debug_dbGet'))},
    'l1-el': {'listen': ('127.0.0.1', 18647), 'ipc': '/srv/enclave-l1-pair/tmp/witness-el.ipc',
              'methods': frozenset(READ_ETH + ('debug_getRawHeader', 'debug_getRawReceipts'))},
}
MAX_REQUEST = 1 << 20                 # 1 MiB request body
MAX_RESPONSE = 192 << 20              # > reth's default --rpc.max-response-size 160 MB; bounded memory
MAX_BATCH = 32
MAX_INFLIGHT = 4                      # debug_executePayload is CPU-heavy (the node itself allows 3 concurrent)
IPC_TIMEOUT = 600                     # seconds, one call
LOOPBACK = ('127.0.0.1', '::1')


class Refused(Exception):
    pass


def check_socket(path, uid=None):
    """the IPC socket is a real socket owned by this user (or root), with no group/other access"""
    st = os.lstat(path)
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid not in ({os.geteuid(), 0} if uid is None else {uid}) or st.st_mode & 0o077:
        raise Refused(f'{path} is not a private socket of this user (mode {oct(stat.S_IMODE(st.st_mode))}, uid {st.st_uid})')


def ipc_call(path, payload, timeout=IPC_TIMEOUT, max_response=MAX_RESPONSE):
    """one request on a fresh connection; the response is the first complete JSON value the node writes"""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(timeout)
    try:
        s.connect(path); s.sendall(payload + b'\n')
        buf, dec = bytearray(), json.JSONDecoder()
        while True:
            chunk = s.recv(1 << 20)
            if not chunk:
                raise Refused('the node closed the IPC connection before a complete response')
            buf += chunk
            if len(buf) > max_response:
                raise Refused(f'response exceeds {max_response} bytes')
            tail = bytes(buf).rstrip()
            if tail.endswith((b'}', b']')):
                try:
                    v, _end = dec.raw_decode(bytes(buf).decode().lstrip())
                    return json.dumps(v, separators=(',', ':')).encode()
                except ValueError:
                    continue
    finally:
        s.close()


def check_request(body, allowed):
    """-> canonical bytes to forward, or Refused(code, message, id)"""
    try:
        req = json.loads(body)
    except ValueError:
        raise Refused((-32700, 'parse error', None))
    items = req if isinstance(req, list) else [req]
    if isinstance(req, list) and not 0 < len(req) <= MAX_BATCH:
        raise Refused((-32600, f'batch must have 1..{MAX_BATCH} requests', None))
    for r in items:
        if not isinstance(r, dict) or r.get('jsonrpc') != '2.0' or not isinstance(r.get('method'), str):
            raise Refused((-32600, 'invalid request', r.get('id') if isinstance(r, dict) else None))
        if r['method'] not in allowed:
            raise Refused((-32601, f'method {r["method"][:64]!r} is not offered by the private witness bridge', r.get('id')))
    return json.dumps(req, separators=(',', ':')).encode()


def make_server(cfg, ipc=None):
    host, port = cfg['listen']
    if host not in LOOPBACK:
        raise Refused(f'refusing to listen on {host}: loopback only')
    ipc = ipc or cfg['ipc']; allowed = cfg['methods']; gate = threading.BoundedSemaphore(cfg.get('inflight', MAX_INFLIGHT))

    class H(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *a):
            sys.stderr.write('witness-bridge ' + (fmt % a) + '\n')

        def send(self, code, body):
            self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body)))
            self.end_headers(); self.wfile.write(body)

        def err(self, code, rid, http_code=200):
            self.send(http_code, json.dumps({'jsonrpc': '2.0', 'id': rid, 'error': {'code': code[0], 'message': code[1]}}).encode())

        def do_GET(self):
            self.send(405, b'{"error":"POST only"}')

        def do_POST(self):
            n = int(self.headers.get('Content-Length') or -1)
            if n < 0 or n > MAX_REQUEST:
                self.close_connection = True; return self.send(413, b'{"error":"request size"}')
            body = self.rfile.read(n)
            try:
                fwd = check_request(body, allowed)
            except Refused as e:
                c = e.args[0]; return self.err((c[0], c[1]), c[2])
            if not gate.acquire(blocking=False):
                return self.send(503, b'{"error":"busy: bounded concurrency"}')
            try:
                check_socket(ipc)
                out = ipc_call(ipc, fwd)
            except (Refused, OSError) as e:
                return self.err((-32603, f'node IPC unavailable: {str(e)[:200]}'), None, 502)
            finally:
                gate.release()
            self.send(200, out)

    srv = http.server.ThreadingHTTPServer((host, port), H); srv.daemon_threads = True
    return srv


def main(argv):
    if len(argv) != 2 or argv[1] not in PROFILES:
        print(__doc__); return 2
    try:
        srv = make_server(PROFILES[argv[1]])
    except (Refused, OSError) as e:
        print(f'REFUSED: {e}'); return 1
    print(f'witness-bridge {argv[1]} on {srv.server_address} -> {PROFILES[argv[1]]["ipc"]} ({len(PROFILES[argv[1]]["methods"])} methods)', flush=True)
    srv.serve_forever(); return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))

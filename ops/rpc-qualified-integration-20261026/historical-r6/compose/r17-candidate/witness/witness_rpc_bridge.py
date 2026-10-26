#!/usr/bin/env python3
"""witness-rpc-access-stage/r2 (PREPARED; NOT run live): the PRIVATE, loopback-only JSON-RPC bridge that makes witness acquisition possible
without exposing `debug` on any forwarded/public RPC (rationale and source facts: ../README.md, r1).

r2 transport (small, explicit; no http.server): an accept loop that ADMITS at most MAX_CONN connections - an extra connection gets an
immediate 503 and is closed BEFORE any byte of it is read; per admitted connection ONE request under an ABSOLUTE deadline for headers +
body (HEADER_DEADLINE) and an ABSOLUTE deadline for the whole IPC exchange + relay (REQUEST_DEADLINE); strict headers (<= MAX_HEADER,
exactly one decimal Content-Length <= MAX_REQUEST, no Transfer-Encoding); the node's response is STREAMED to the client in CHUNK pieces
(close-delimited HTTP body, Connection: close) while an O(1)-state scanner finds the end of the first JSON value - memory per connection
is O(CHUNK), never O(response); a response beyond MAX_RESPONSE or past the deadline is cut (the connection is closed mid-body, so the
client sees a truncated/invalid response, never a fabricated one). The allowlist is r1's, checked before the socket is touched.
debug_dbGet: the bridge relays the params unchanged; the 33-byte 0x63||code_hash restriction is enforced by the pinned node itself
(reth 7134be3 crates/rpc/rpc/src/debug.rs:1027-1059), not by this bridge.

  witness_rpc_bridge.py base-el | l1-el"""
import json, os, re, socket, stat, sys, threading, time

READ_ETH = ('eth_chainId', 'eth_syncing', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash')
PROFILES = {
    'base-el': {'listen': ('127.0.0.1', 18547), 'ipc': '/srv/enclave-base-holder/tmp/witness-el.ipc',
                'methods': frozenset(READ_ETH + ('eth_getProof', 'debug_executePayload', 'debug_getRawHeader', 'debug_dbGet'))},
    'l1-el': {'listen': ('127.0.0.1', 18647), 'ipc': '/srv/enclave-l1-pair/tmp/witness-el.ipc',
              'methods': frozenset(READ_ETH + ('debug_getRawHeader', 'debug_getRawReceipts'))},
}
LIMITS = {'max_conn': 2,                      # admitted connections (each <= ~2*CHUNK buffers + a thread); node allows 3 executePayload
          'max_header': 8192, 'max_request': 1 << 20, 'max_batch': 32,
          'header_deadline': 15.0,            # absolute: request line + headers + body
          'request_deadline': 900.0,          # absolute: IPC connect + send + the whole streamed response
          'max_response': 256 << 20,          # streamed, so this bounds time/bytes, not memory (> reth 160 MB default)
          'chunk': 64 << 10}
LOOPBACK = ('127.0.0.1', '::1')


class Refused(Exception):
    pass


def check_socket(path, uid=None):
    st = os.lstat(path)
    if not stat.S_ISSOCK(st.st_mode) or st.st_uid not in ({os.geteuid(), 0} if uid is None else {uid}) or st.st_mode & 0o077:
        raise Refused(f'{path} is not a private socket of this user (mode {oct(stat.S_IMODE(st.st_mode))}, uid {st.st_uid})')


_IN_STR, _OUT_STR = re.compile(rb'["\\]'), re.compile(rb'["\[\]{}]')
_WS = b' \t\r\n'


class JsonEnd:
    """end of the FIRST JSON object/array in a byte stream, O(1) state; jumps between significant bytes with C regex (no per-byte loop).
    feed() -> the index just past the value's end in THIS chunk, else -1"""
    def __init__(self):
        self.depth, self.instr, self.esc, self.started = 0, False, False, False

    def feed(self, b):
        i, n = 0, len(b)
        if self.esc:                                       # the previous chunk ended with a backslash inside a string
            self.esc, i = False, 1
        while i < n:
            if not self.started:
                while i < n and b[i] in _WS:
                    i += 1
                if i == n:
                    return -1
                if b[i] not in (0x7b, 0x5b):
                    raise Refused('the node response does not start with a JSON object/array')
                self.started, self.depth, i = True, 1, i + 1
                continue
            m = (_IN_STR if self.instr else _OUT_STR).search(b, i)
            if m is None:
                return -1
            j = m.start(); c = b[j]
            if self.instr:
                if c == 0x5c:
                    if j + 1 >= n:
                        self.esc = True; return -1
                    i = j + 2; continue
                self.instr, i = False, j + 1; continue
            if c == 0x22:
                self.instr = True
            elif c in (0x7b, 0x5b):
                self.depth += 1
            else:
                self.depth -= 1
                if self.depth == 0:
                    return j + 1
            i = j + 1
        return -1


def check_request(body, allowed, max_batch):
    try:
        req = json.loads(body)
    except ValueError:
        raise Refused((-32700, 'parse error', None))
    items = req if isinstance(req, list) else [req]
    if isinstance(req, list) and not 0 < len(req) <= max_batch:
        raise Refused((-32600, f'batch must have 1..{max_batch} requests', None))
    for r in items:
        if not isinstance(r, dict) or r.get('jsonrpc') != '2.0' or not isinstance(r.get('method'), str):
            raise Refused((-32600, 'invalid request', r.get('id') if isinstance(r, dict) else None))
        if r['method'] not in allowed:
            raise Refused((-32601, f'method {r["method"][:64]!r} is not offered by the private witness bridge', r.get('id')))
    return json.dumps(req, separators=(',', ':')).encode()


def reply(c, code, reason, obj):
    b = json.dumps(obj).encode()
    c.sendall(f'HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {len(b)}\r\nConnection: close\r\n\r\n'.encode() + b)


def rpc_error(c, code, msg, rid=None, http=(200, 'OK')):
    reply(c, http[0], http[1], {'jsonrpc': '2.0', 'id': rid, 'error': {'code': code, 'message': msg}})


def read_request(c, lim):
    """-> body bytes; raises Refused((http_code, reason)) on any violation; ONE absolute deadline for headers + body"""
    end = time.monotonic() + lim['header_deadline']; buf = b''

    def recv(n):
        left = end - time.monotonic()
        if left <= 0:
            raise Refused((408, 'Request Timeout'))
        c.settimeout(left)
        try:
            d = c.recv(n)
        except socket.timeout:
            raise Refused((408, 'Request Timeout'))
        if not d:
            raise Refused((400, 'Bad Request'))
        return d
    while b'\r\n\r\n' not in buf:
        if len(buf) > lim['max_header']:
            raise Refused((431, 'Request Header Fields Too Large'))
        buf += recv(4096)
    head, rest = buf.split(b'\r\n\r\n', 1)
    if len(head) > lim['max_header']:
        raise Refused((431, 'Request Header Fields Too Large'))
    lines = head.decode('latin-1').split('\r\n'); parts = lines[0].split(' ')
    if len(parts) != 3 or not parts[2].startswith('HTTP/1.'):
        raise Refused((400, 'Bad Request'))
    if parts[0] != 'POST':
        raise Refused((405, 'Method Not Allowed'))
    hdr = [l.split(':', 1) for l in lines[1:]]
    if any(len(h) != 2 for h in hdr):
        raise Refused((400, 'Bad Request'))
    names = [h[0].strip().lower() for h in hdr]
    if 'transfer-encoding' in names:
        raise Refused((411, 'Length Required'))
    cl = [h[1].strip() for h in hdr if h[0].strip().lower() == 'content-length']
    if len(cl) != 1:
        raise Refused((411, 'Length Required'))
    if not cl[0].isdigit() or not cl[0].isascii() or len(cl[0]) > 9:
        raise Refused((400, 'Bad Request'))
    n = int(cl[0])
    if n > lim['max_request']:
        raise Refused((413, 'Payload Too Large'))
    while len(rest) < n:
        rest += recv(min(65536, n - len(rest)))
    return rest[:n]


def relay(c, ipc, payload, lim):
    """stream the node's FIRST JSON value to the client; absolute deadline; bounded bytes; O(chunk) memory"""
    end = time.monotonic() + lim['request_deadline']
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        s.settimeout(max(0.01, end - time.monotonic())); s.connect(ipc); s.sendall(payload + b'\n')
        scan, sent, head_sent = JsonEnd(), 0, False
        while True:
            left = end - time.monotonic()
            if left <= 0:
                raise Refused('request deadline exceeded')
            s.settimeout(left)
            try:
                d = s.recv(lim['chunk'])
            except socket.timeout:
                raise Refused('request deadline exceeded')
            if not d:
                raise Refused('the node closed the IPC connection before a complete response')
            k = scan.feed(d)
            piece = d if k < 0 else d[:k]
            if sent + len(piece) > lim['max_response']:
                raise Refused(f'response exceeds {lim["max_response"]} bytes')
            if not head_sent:
                c.settimeout(max(0.01, end - time.monotonic()))
                c.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n'); head_sent = True
            c.settimeout(max(0.01, end - time.monotonic())); c.sendall(piece); sent += len(piece)
            if k >= 0:
                return sent
    except Refused as e:
        e.head_sent = locals().get('head_sent', False); raise
    except OSError as e:
        r = Refused(f'node IPC: {type(e).__name__}: {str(e)[:120]}'); r.head_sent = locals().get('head_sent', False); raise r
    finally:
        s.close()


class Bridge:
    def __init__(self, cfg, ipc=None, limits=None):
        host, port = cfg['listen']
        if host not in LOOPBACK:
            raise Refused(f'refusing to listen on {host}: loopback only')
        self.ipc, self.allowed, self.lim = ipc or cfg['ipc'], cfg['methods'], {**LIMITS, **(limits or {})}
        self.ls = socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET, socket.SOCK_STREAM)
        self.ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); self.ls.bind((host, port)); self.ls.listen(16)
        self.address = self.ls.getsockname(); self.active, self.lock, self.stats = 0, threading.Lock(), {'admitted': 0, 'busy': 0, 'served': 0, 'cut': 0}

    def serve_forever(self):
        while True:
            try:
                c, _ = self.ls.accept()
            except OSError:
                return
            with self.lock:
                admit = self.active < self.lim['max_conn']
                if admit:
                    self.active += 1; self.stats['admitted'] += 1
                else:
                    self.stats['busy'] += 1
            if not admit:                                          # refused BEFORE reading a single byte of it
                try:
                    c.settimeout(1.0); reply(c, 503, 'Service Unavailable', {'error': 'busy: bounded connections'})
                except OSError:
                    pass
                c.close(); continue
            threading.Thread(target=self.handle, args=(c,), daemon=True).start()

    def shutdown(self):
        try:
            self.ls.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.ls.close()

    def handle(self, c):
        try:
            try:
                body = read_request(c, self.lim)
            except Refused as e:
                code, reason = e.args[0]; return reply(c, code, reason, {'error': reason})
            try:
                fwd = check_request(body, self.allowed, self.lim['max_batch'])
            except Refused as e:
                code, msg, rid = e.args[0]; return rpc_error(c, code, msg, rid)
            try:
                check_socket(self.ipc)
            except (Refused, OSError) as e:
                return rpc_error(c, -32603, f'node IPC unavailable: {str(e)[:200]}', None, (502, 'Bad Gateway'))
            try:
                relay(c, self.ipc, fwd, self.lim); self.stats['served'] += 1
            except Refused as e:
                self.stats['cut'] += 1
                if not getattr(e, 'head_sent', False):
                    rpc_error(c, -32603, str(e)[:200], None, (502, 'Bad Gateway'))
        except OSError:
            pass
        finally:
            c.close()
            with self.lock:
                self.active -= 1


def main(argv):
    if len(argv) != 2 or argv[1] not in PROFILES:
        print(__doc__); return 2
    try:
        b = Bridge(PROFILES[argv[1]])
    except (Refused, OSError) as e:
        print(f'REFUSED: {e}'); return 1
    print(f'witness-bridge {argv[1]} on {b.address} -> {PROFILES[argv[1]]["ipc"]} ({len(PROFILES[argv[1]]["methods"])} methods, '
          f'{b.lim["max_conn"]} connections)', flush=True)
    b.serve_forever(); return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))

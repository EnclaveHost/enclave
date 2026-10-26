#!/usr/bin/python3.12
"""rpc_log_proxy.py PORT UPSTREAM LOG (guest; PREPARED, NOT run). A transparent 127.0.0.1:PORT -> UPSTREAM (our own EL,
http://127.0.0.1:18645) JSON-RPC relay for Helios's executionRpc, so Helios's ACTUAL EL call flow is observable without changing its
binary or its source. Bytes are relayed unchanged; LOG gets one JSON line per request: start offset, duration, in-flight count,
methods, block parameter, storage-key counts, HTTP status, reply size, error. No bodies are logged. Binds 127.0.0.1 only."""
import http.server, json, sys, threading, time, urllib.error, urllib.request
PORT, UP, LOG = int(sys.argv[1]), sys.argv[2], sys.argv[3]
T0, lock, inflight = time.monotonic(), threading.Lock(), [0]
def summary(b):
    try: j = json.loads(b)
    except ValueError: return {'unparsed': len(b)}
    reqs = j if isinstance(j, list) else [j]; out = []
    for r in reqs[:64]:
        p = r.get('params') or []; m = r.get('method')
        out.append({'m': m, 'blk': json.dumps(p[-1])[:80] if p and m not in ('eth_chainId', 'eth_blockNumber') else None,
                    'keys': len(p[1]) if m == 'eth_getProof' and len(p) > 1 and isinstance(p[1], list) else None})
    return {'batch': len(reqs) if isinstance(j, list) else None, 'reqs': out}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        if n > 1 << 20: self.send_error(413); return
        body = self.rfile.read(n); t = time.monotonic()
        with lock: inflight[0] += 1; fl = inflight[0]
        rec = {'t': round(t - T0, 3), 'inflight': fl, **summary(body)}; status, data = 502, b''
        try:
            with urllib.request.urlopen(urllib.request.Request(UP, body, {'content-type': 'application/json'}), timeout=300) as r:
                status, data = r.status, r.read()
        except urllib.error.HTTPError as e: status, data = e.code, e.read()
        except Exception as e: rec['error'] = f'{type(e).__name__}: {e}'[:200]
        finally:
            with lock: inflight[0] -= 1
        rec.update(ms=round((time.monotonic() - t) * 1000), status=status, bytes=len(data))
        if data[:1] == b'{' and b'"error"' in data[:400]: rec['rpcError'] = data[:300].decode('utf8', 'replace')
        with lock, open(LOG, 'a') as f: f.write(json.dumps(rec) + '\n')
        self.send_response(status); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(data)))
        self.end_headers(); self.wfile.write(data)
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()

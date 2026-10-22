#!/usr/bin/env python3
"""READ-ONLY public fetches through the documented Enclave IPFS gateway (ipfs.enclave.host):
  1. the cron 1.0.3 wasm (catalog CID) -> cron-1.0.3.wasm; its CID is re-derived locally (fetch-verify.mjs)
  2. the deployment's pinned config override (bafkrei..., raw block: its CID IS its sha256, verified here); only the KEY
     STRUCTURE is kept (each value -> "$REF" if a secret reference, else its type/length), never the raw body"""
import hashlib, json, sys, urllib.request, base64
GW = 'https://ipfs.enclave.host/ipfs/'
WASM = 'bafybeihbh44co4nluuraqsnfylfybuw4ybjvzfs6hmtewzlr7dt36f5oty'
CFG = 'bafkreigf7ewh5mzjv6zmgzyhz7kvcrlonvhhmezprjmb3i5xd2vb4seyey'
def get(url, limit):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'cron-diagnosis'}), timeout=60) as r:
        b = r.read(limit + 1); assert len(b) <= limit, 'too large'; return r.status, b
st, w = get(GW + WASM, 64 << 20); open('cron-1.0.3.wasm', 'wb').write(w)
print('wasm', st, len(w), hashlib.sha256(w).hexdigest())
st, c = get(GW + CFG + '?format=raw', 1 << 20)
# bafkrei = CIDv1 raw sha2-256: base32 of 0x01 0x55 0x12 0x20 <digest>
d = base64.b32decode(CFG[1:].upper() + '=' * (-len(CFG[1:]) % 8))
print('config', st, len(c), 'cid-verified', d[4:] == hashlib.sha256(c).digest())
def shape(o, k=''):
    if isinstance(o, dict): return {kk: shape(v, kk) for kk, v in o.items()}
    if isinstance(o, list): return [shape(v, k) for v in o][:5]
    if isinstance(o, str): return o if o.startswith('$') else f'<literal str len {len(o)}>'
    return f'<{type(o).__name__}>' if not isinstance(o, (bool, int, float)) or k in () else o
j = json.loads(c)
json.dump({'cid': CFG, 'bytes': len(c), 'sha256': hashlib.sha256(c).hexdigest(), 'shape': shape(j)}, open('deploy-config-shape.json', 'w'), indent=1)
print(json.dumps(shape(j), indent=1))

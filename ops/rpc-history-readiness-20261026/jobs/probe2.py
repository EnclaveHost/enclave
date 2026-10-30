#!/usr/bin/env python3
"""ONE bounded read-only request to OUR OWN L1 EL: header of the HINT block 26235782 (estimated L1 block at Base block 52866960's
timestamp 1792523267). A pre-fetch HINT only; never the exact l1Origin(N), which must come from block N's L1-attributes deposit."""
import json, time, urllib.request
b = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockByNumber', 'params': [hex(26235782), False]}).encode()
with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:28645', b, {'content-type': 'application/json'}), timeout=20) as r:
    h = json.load(r).get('result') or {}
print(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'hint': 26235782,
                  'number': int(h['number'], 16) if h else None, 'timestamp': int(h['timestamp'], 16) if h else None, 'hash': h.get('hash'),
                  'baseNTimestamp': 1792523267}, indent=1))

#!/usr/bin/env python3
"""historical-blob-readiness probe: EXACTLY 3 bounded read-only requests to OUR OWN L1 (host forwards to the RPC guest), no payloads:
 1 CL GET /lighthouse/database/info (blob/column retention window: oldest_data_slot, prune settings)
 2 EL eth_getBlockByNumber("finalized", false) (number, timestamp)
 3 CL GET /eth/v1/beacon/headers/finalized (finalized slot)"""
import json, sys, time, urllib.request
EL, CL = 'http://127.0.0.1:28645', 'http://127.0.0.1:25052'
out = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
def get(u):
    with urllib.request.urlopen(u, timeout=20) as r:
        return json.load(r)
try:
    d = get(CL + '/lighthouse/database/info')
    out['dbInfo'] = {k: d.get(k) for k in ('schema_version', 'config', 'split', 'anchor', 'blob_info', 'data_column_info')}
except Exception as e:
    out['dbInfo'] = {'error': f'{type(e).__name__}: {e}'[:200]}
try:
    b = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockByNumber', 'params': ['finalized', False]}).encode()
    with urllib.request.urlopen(urllib.request.Request(EL, b, {'content-type': 'application/json'}), timeout=20) as r:
        f = json.load(r)['result']
    out['elFinalized'] = {'number': int(f['number'], 16), 'timestamp': int(f['timestamp'], 16), 'hash': f['hash']}
except Exception as e:
    out['elFinalized'] = {'error': f'{type(e).__name__}: {e}'[:200]}
try:
    h = get(CL + '/eth/v1/beacon/headers/finalized')['data']
    out['clFinalized'] = {'slot': int(h['header']['message']['slot']), 'root': h['root']}
except Exception as e:
    out['clFinalized'] = {'error': f'{type(e).__name__}: {e}'[:200]}
print(json.dumps(out, indent=1))

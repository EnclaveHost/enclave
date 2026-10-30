#!/usr/bin/env python3
"""derivation-witness-stage runner (PREPARED; root runs it under the shared queue once the native binaries are built and our Base is ready).

  runner.py gate      --config run.json     all gates, read-only (refuses: missing/unpinned authenticated inputs, Base not ready)
  runner.py measure   --config run.json     gate, then for each size in config.sizes (1, 30, 1800): acquire witness, replay harness
  runner.py negatives --config run.json     gate, then REAL mutations of the size-1 witness / trusted input; each must refuse

Authority boundary: the witness, the Base node's output roots and the host are UNTRUSTED. The caller-owned inputs are files that root
pins by sha256 in run.json: the authenticated ORIGINAL ASR anchor (in-domain A1 + authenticateAnchor), the authenticated L1-finalized
head (in-domain light client), and the authenticated rollup-config/schedule pins. No public provider: every endpoint is loopback.
NOTE: a run on the host is a MEASUREMENT of the harness, not in-domain authority (that needs the SNP integration).
Exit: 0 every requested step met its expectation; 1 a step failed (a negative that was ACCEPTED is a security failure); 9 gate refusal."""
import hashlib, json, os, pathlib, re, subprocess, sys, time, urllib.request

H32 = re.compile(r'0x[0-9a-f]{64}')
TIMEOUT = {1: 900, 30: 3600, 1800: 14400}
EXPECT_NEG = ('wrong-claimed-root', 'wrong-claimed-number', 'foreign-l1-head', 'missing-preimage', 'hashbad-preimage', 'kzgbad-blob')


class Refused(Exception):
    pass


def sha_file(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


def pinned_json(ent, what):
    """{path, sha256} -> parsed JSON, refused unless the bytes equal root's pin."""
    if not isinstance(ent, dict) or not os.path.isabs(str(ent.get('path'))) or not re.fullmatch(r'[0-9a-f]{64}', str(ent.get('sha256'))):
        raise Refused(f'{what}: an absolute path and its sha256 pin are required (source-authenticated input not supplied)')
    if not os.path.isfile(ent['path']):
        raise Refused(f'{what}: {ent["path"]} missing (source-authenticated input not supplied)')
    if sha_file(ent['path']) != ent['sha256']:
        raise Refused(f'{what}: {ent["path"]} is not the pinned {ent["sha256"][:12]}')
    return json.loads(pathlib.Path(ent['path']).read_text())


def need(d, k, kind, what):
    v = d.get(k)
    ok = {'h32': lambda x: isinstance(x, str) and bool(H32.fullmatch(x)), 'uint': lambda x: type(x) is int and x >= 0,
          'obj': lambda x: isinstance(x, dict)}[kind](v)
    if not ok:
        raise Refused(f'{what}.{k} must be {kind}')
    return v


def load_inputs(cfg):
    a = pinned_json(cfg.get('anchor'), 'anchor')
    base = a.get('base') if isinstance(a.get('base'), dict) else a
    if a.get('finality') not in ('l1-finalized-asr-anchor',) and a.get('tier') not in ('finalized',):
        raise Refused('anchor: not an authenticated ASR anchor record (finality l1-finalized-asr-anchor)')
    anchor = {'number': need(base, 'number', 'uint', 'anchor'), 'outputRoot': need(base, 'outputRoot', 'h32', 'anchor'),
              'hash': base.get('hash'), 'stateRoot': base.get('stateRoot'), 'messagePasserStorageRoot': base.get('messagePasserStorageRoot')}
    l1 = pinned_json(cfg.get('l1Head'), 'l1Head')
    if l1.get('source') != 'in-domain-light-client':
        raise Refused('l1Head: source must be in-domain-light-client (an RPC "finalized" tag is not evidence)')
    l1h = {'number': need(l1, 'number', 'uint', 'l1Head'), 'hash': need(l1, 'hash', 'h32', 'l1Head'), 'timestamp': need(l1, 'timestamp', 'uint', 'l1Head')}
    sc = pinned_json(cfg.get('schedule'), 'schedule')
    sched = {'rollupConfig': need(sc, 'rollupConfig', 'obj', 'schedule'), 'expectedRollupConfigHash': need(sc, 'expectedRollupConfigHash', 'h32', 'schedule'),
             'expectedScheduleId': need(sc, 'expectedScheduleId', 'h32', 'schedule')}
    return anchor, l1h, sched


def loopback(u):
    if not re.fullmatch(r'http://127\.0\.0\.1:[0-9]{2,5}/?', str(u)):
        raise Refused(f'endpoint {u!r}: only http://127.0.0.1:<port> (own nodes; no public providers)')
    return u


def rpc(url, method, params, timeout=20):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, {'content-type': 'application/json'}), timeout=timeout) as r:
        j = json.load(r)
    if 'error' in j or 'result' not in j:
        raise Refused(f'{method}: {str(j.get("error"))[:200]}')
    return j['result']


def gate_nodes(ep, anchor, top):
    """read-only: our Base EL/node and L1 must be ready for anchor..anchor+top (never authority, only readiness)."""
    if rpc(ep['l2Rpc'], 'eth_chainId', []) != '0x2105':
        raise Refused('Base EL is not chain 8453')
    if rpc(ep['l2Rpc'], 'eth_syncing', []) is not False:
        raise Refused('Base not ready: eth_syncing')
    head = int(rpc(ep['l2Rpc'], 'eth_blockNumber', []), 16)
    if head < anchor['number'] + top:
        raise Refused(f'Base not ready: head {head} < anchor {anchor["number"]} + {top}')
    if not rpc(ep['l2Rpc'], 'debug_getRawHeader', [hex(anchor['number'])]):
        raise Refused('Base not ready: no raw header at the anchor (state/history not retained)')
    rpc(ep['l2Node'], 'optimism_rollupConfig', [])
    out = rpc(ep['l2Node'], 'optimism_outputAtBlock', [hex(anchor['number'])])
    if str(out.get('outputRoot', '')).lower() != anchor['outputRoot']:
        raise Refused('our Base node disagrees with the authenticated anchor output root (wrong chain/DB): refused')
    if rpc(ep['l1Rpc'], 'eth_chainId', []) != '0x1':
        raise Refused('L1 EL is not mainnet')
    with urllib.request.urlopen(ep['l1Beacon'].rstrip('/') + '/eth/v1/node/syncing', timeout=20) as r:
        if json.load(r)['data'].get('is_syncing') is not False:
            raise Refused('L1 beacon not ready')
    return head


def binary(cfg, k):
    b = cfg.get(k) or {}
    if not os.path.isfile(str(b.get('path'))) or sha_file(b['path']) != b.get('sha256'):
        raise Refused(f'{k}: binary missing or not its sha256 pin (build it first; never an unpinned binary)')
    return b['path']


def gate(cfg, probe=True):
    anchor, l1h, sched = load_inputs(cfg)
    ep = {k: loopback(cfg.get('endpoints', {}).get(k)) for k in ('l1Rpc', 'l1Beacon', 'l2Rpc', 'l2Node')}
    sizes = cfg.get('sizes', [1, 30, 1800])
    if not sizes or any(s not in TIMEOUT for s in sizes):
        raise Refused('sizes must be a subset of 1, 30, 1800')
    out = pathlib.Path(cfg.get('outDir', ''))
    if not out.is_absolute():
        raise Refused('outDir must be absolute')
    head = gate_nodes(ep, anchor, max(sizes)) if probe else None
    return {'anchor': anchor, 'l1Head': l1h, 'schedule': sched, 'endpoints': ep, 'sizes': sizes, 'out': out, 'baseHead': head,
            'harness': binary(cfg, 'harness') if probe else None, 'fetch': binary(cfg, 'fetch') if probe else None}


def trusted(g, end, claimed_root):
    return {'chainId': 8453, 'l1Head': g['l1Head']['hash'], 'l1HeadNumber': g['l1Head']['number'], 'agreedL2OutputRoot': g['anchor']['outputRoot'],
            'claimedL2OutputRoot': claimed_root, 'claimedL2BlockNumber': end, 'rollupConfig': g['schedule']['rollupConfig'],
            'expectedRollupConfigHash': g['schedule']['expectedRollupConfigHash'], 'expectedScheduleId': g['schedule']['expectedScheduleId']}


def timed(argv, timeout, log):
    t0 = time.monotonic()
    p = subprocess.run(['/usr/bin/time', '-v', *argv], capture_output=True, text=True, timeout=timeout)
    rss = re.search(r'Maximum resident set size \(kbytes\): (\d+)', p.stderr)
    pathlib.Path(log).write_text(p.stdout + '\n--- stderr ---\n' + p.stderr[-20000:])
    return p.returncode, p.stdout, round(time.monotonic() - t0, 1), int(rss.group(1)) // 1024 if rss else None


def measure(g):
    rows = []
    for n in g['sizes']:
        d = g['out'] / f'size-{n}'; d.mkdir(parents=True, exist_ok=False)
        start, end = g['anchor']['number'], g['anchor']['number'] + n
        claimed = str(rpc(g['endpoints']['l2Node'], 'optimism_outputAtBlock', [hex(end)])['outputRoot']).lower()   # untrusted claim
        w = d / 'witness.json'
        rc, _o, sec, rss = timed([g['fetch'], g['endpoints']['l1Rpc'], g['endpoints']['l1Beacon'], g['endpoints']['l2Rpc'], g['endpoints']['l2Node'],
                                  str(start), str(end), g['l1Head']['hash'], str(n), str(w)], TIMEOUT[n], d / 'fetch.log')
        row = {'blocks': n, 'fetch': {'rc': rc, 'sec': sec, 'maxRssMiB': rss, 'witnessBytes': w.stat().st_size if w.exists() else None}}
        if rc == 0:
            t = d / 'trusted.json'; t.write_text(json.dumps(trusted(g, end, claimed)))
            rc2, out, sec2, rss2 = timed([g['harness'], str(t), str(w)], TIMEOUT[n], d / 'harness.log')
            res = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
            row['replay'] = {'rc': rc2, 'sec': sec2, 'maxRssMiB': rss2,
                             'ok': rc2 == 0 and (res.get('base') or {}).get('number') == end and str(res.get('l2OutputRoot', '')).lower() == claimed,
                             'base': res.get('base'), 'refused': res.get('refused')}
        rows.append(row)
        (g['out'] / 'measure.json').write_text(json.dumps(rows, indent=1))
        if not (row.get('replay') or {}).get('ok'):
            break                                                                     # bounded: never go larger after a failure
    return rows


# ---- real negative mutations of the fetched size-1 witness (JSON) or of the trusted input ------------------------------------------
def _bytes_list(v):
    return isinstance(v, list) and all(type(x) is int and 0 <= x < 256 for x in v)


def find_agreed_preimage(w, anchor):
    """the output-root preimage the client reads first (fetch_safe_head_hash): exactly 0^32 || stateRoot || messagePasserRoot || hash"""
    if not all(H32.fullmatch(str(anchor.get(k) or '')) for k in ('stateRoot', 'messagePasserStorageRoot', 'hash')):
        return None
    want = bytes(32) + b''.join(bytes.fromhex(anchor[k][2:]) for k in ('stateRoot', 'messagePasserStorageRoot', 'hash'))
    pm = (w.get('preimageStore') or {}).get('preimage_map')
    for i, pair in enumerate(pm if isinstance(pm, list) else []):
        if isinstance(pair, list) and len(pair) == 2 and _bytes_list(pair[1]) and bytes(pair[1]) == want:
            return i
    return None


def mutate(w, kind, anchor):
    """-> mutated witness JSON, or None with the reason it cannot be applied to THIS witness (then NOT TESTED, never PASS)."""
    w = json.loads(json.dumps(w))
    if kind in ('missing-preimage', 'hashbad-preimage'):
        i = find_agreed_preimage(w, anchor)
        if i is None:
            return None, 'the agreed output-root preimage is not identifiable (anchor stateRoot/messagePasserStorageRoot/hash absent or other encoding)'
        pm = w['preimageStore']['preimage_map']
        if kind == 'missing-preimage':
            del pm[i]
        else:
            pm[i][1][100] ^= 0x01                                                    # inside blockHash: keccak no longer matches the key
        return w, None
    if kind == 'kzgbad-blob':
        blobs = (w.get('blobData') or {}).get('blobs')
        if not blobs:
            return None, 'the witness carries no blob (calldata batches): KZG rejection NOT TESTED'
        b = blobs[0]
        if _bytes_list(b):
            b[1000] ^= 0x01
        elif isinstance(b, str) and re.fullmatch(r'(0x)?[0-9a-fA-F]+', b):
            off = 2 if b.startswith('0x') else 0
            c = b[off + 2001]; blobs[0] = b[:off + 2001] + ('0' if c != '0' else '1') + b[off + 2002:]
        else:
            return None, 'unknown blob encoding: NOT TESTED'
        return w, None
    raise ValueError(kind)


def negatives(g):
    d = g['out'] / 'size-1'
    w, tj = d / 'witness.json', d / 'trusted.json'
    if not (w.exists() and tj.exists()):
        raise Refused('negatives need the size-1 witness and trusted.json from `measure` first')
    base_t, wit = json.loads(tj.read_text()), json.loads(w.read_text())
    n = g['out'] / 'negatives'; n.mkdir(exist_ok=False)
    rows = []
    for kind in EXPECT_NEG:
        t, ww, why = dict(base_t), wit, None
        if kind == 'wrong-claimed-root':
            r = bytearray(bytes.fromhex(t['claimedL2OutputRoot'][2:])); r[0] ^= 1; t['claimedL2OutputRoot'] = '0x' + r.hex()
        elif kind == 'wrong-claimed-number':
            t['claimedL2BlockNumber'] += 1
        elif kind == 'foreign-l1-head':
            r = bytearray(bytes.fromhex(t['l1Head'][2:])); r[0] ^= 1; t['l1Head'] = '0x' + r.hex()
        else:
            ww, why = mutate(wit, kind, g['anchor'])
        if ww is None:
            rows.append({'case': kind, 'status': 'NOT TESTED', 'why': why}); continue
        (n / f'{kind}.trusted.json').write_text(json.dumps(t)); (n / f'{kind}.witness.json').write_text(json.dumps(ww))
        rc, out, sec, rss = timed([g['harness'], str(n / f'{kind}.trusted.json'), str(n / f'{kind}.witness.json')], TIMEOUT[1], n / f'{kind}.log')
        res = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
        rows.append({'case': kind, 'rc': rc, 'sec': sec, 'refused': res.get('refused'),
                     'status': 'PASS (refused)' if rc == 1 and res.get('refused') else 'FAIL (ACCEPTED: security failure)' if rc == 0 else 'FAIL (no clean refusal)'})
        (n / f'{kind}.witness.json').unlink()                                         # keep logs, not GB copies
    (g['out'] / 'negatives.json').write_text(json.dumps(rows, indent=1))
    return rows


def main(argv):
    if len(argv) != 4 or argv[1] not in ('gate', 'measure', 'negatives') or argv[2] != '--config':
        print(__doc__); return 2
    cfg = json.loads(pathlib.Path(argv[3]).read_text())
    try:
        g = gate(cfg)
        if argv[1] == 'gate':
            print(json.dumps({'gate': 'PASS', 'baseHead': g['baseHead'], 'anchor': g['anchor']['number']})); return 0
        g['out'].mkdir(parents=True, exist_ok=True)
        rows = measure(g) if argv[1] == 'measure' else negatives(g)
        print(json.dumps(rows, indent=1))
        bad = [r for r in rows if (r.get('status', '').startswith('FAIL')) or (r.get('replay') and not r['replay'].get('ok')) or (r.get('fetch', {}).get('rc', 0) != 0)]
        return 1 if bad else 0
    except Refused as e:
        print(json.dumps({'gate': 'REFUSED', 'why': str(e)})); return 9


if __name__ == '__main__':
    sys.exit(main(sys.argv))

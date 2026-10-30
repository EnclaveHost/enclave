#!/usr/bin/python3.12
"""canary_driver.py C SETTINGS (guest, root, inside the canary scope): ONE real `capture('initial')` with the REAL patched module
(<C>/opt/a1-capture/a1_capture.py) and its default Pins (guest runtime identities), Sources.from_settings(SETTINGS), then the module's
own verify(). Binds the Helios listener to THIS process tree (before_exec hook). Writes <C>/out/receipt.json (public, bounded)."""
import json, os, pathlib, subprocess, sys, time, urllib.request
C = pathlib.Path(sys.argv[1]); sys.path.insert(0, str(C / 'opt/a1-capture'))
import a1_capture as M
def ancestors(pid):
    out = []
    while pid > 1:
        out.append(pid)
        try: pid = int(pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
        except OSError: break
    return out
owner = {}
def bind_listener(stage):
    ss = subprocess.run(['ss', '-ltnpH', 'sport = :18550'], capture_output=True, text=True, timeout=10).stdout
    pids = sorted({int(x.split('=')[1]) for x in __import__('re').findall(r'pid=\d+', ss)})
    if len(pids) != 1 or os.getpid() not in ancestors(pids[0]):
        raise RuntimeError(f'18550 listener {pids} is not owned by this canary (driver {os.getpid()})')
    owner.update(pid=pids[0], exe=os.path.realpath(f'/proc/{pids[0]}/exe'), ancestry=ancestors(pids[0])[:6])
src = M.Sources.from_settings(sys.argv[2]); pins = M.Pins(); out = C / 'captures/initial'
t0 = time.time()
ok, res = M.capture('initial', out, src=src, pins=pins, hooks={'poll': 3, 'before_exec': bind_listener}, helios_timeout=900, a1_timeout=600)
rec = {'format': 'enclave-guest-capture-canary/v1', 'captureOk': ok, 'result': res, 'heliosListener': owner, 'captureSec': round(time.time() - t0, 1),
       'moduleSha256': M.sha(pathlib.Path(M.__file__).read_bytes()), 'python': sys.executable}
# r2: Helios must have made FORWARD progress from the pinned checkpoint on OUR chain: its finalized block is above the checkpoint
# payload and equals our own EL's block at that number
try:
    cons = json.loads((C / 'out/l1-consistency.json').read_text()); hf = (res.get('heliosStatus') or {}).get('finalized') or {}
    rpc = lambda m, p: json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18645', json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                                         {'content-type': 'application/json'}), timeout=10))['result']
    own = rpc('eth_getBlockByNumber', [hex(int(hf['number'])), False]) if 'number' in hf else None
    fp = {'checkpointPayloadNumber': cons['checkpointPayload']['number'], 'heliosFinalized': hf, 'ownElHashAtHeliosFinalized': (own or {}).get('hash')}
    fp['ok'] = bool(own) and int(hf['number']) > cons['checkpointPayload']['number'] and own['hash'] == hf.get('hash')
except Exception as e:
    fp = {'ok': False, 'error': f'{type(e).__name__}: {e}'[:300]}
rec['forwardProgress'] = fp
if ok and fp.get('ok'):
    try: rec['verify'] = M.verify(out, pins=pins, node=str(src.node), workdir=str(C / 'tmp'))
    except M.Refused as e: rec['verifyRefused'] = str(e)
(C / 'out').mkdir(exist_ok=True); (C / 'out/receipt.json').write_text(json.dumps(rec, indent=1, default=str)[:2_000_000])
print(json.dumps({'captureOk': ok, 'forwardProgress': fp.get('ok'), 'verifyOk': 'verify' in rec, 'error': res.get('error'), 'verifyRefused': rec.get('verifyRefused')}))
sys.exit(0 if ok and fp.get('ok') and 'verify' in rec else 1)

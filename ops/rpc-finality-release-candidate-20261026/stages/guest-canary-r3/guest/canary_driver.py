#!/usr/bin/python3.12
"""canary_driver.py C SETTINGS (guest, root, inside the canary scope; r3). Uses ONLY the r10 bytes under <C>/opt (production layout):
  1 capture('initial') with Sources.from_settings(SETTINGS) + default Pins; the derived inputs/a1-config.json elUrl must be EXACTLY
    http://127.0.0.1:18645 and the module's own verify() must bind THAT file (boundInputs sha); Helios forward progress as in r2.
  2 the CONSUMER (this driver) records its own expected initial capture.json sha256 from the bytes it verified, BEFORE the recheck.
  3 capture('recheck-capture') of that initial; same elUrl assertion and binding; verify(initial_out=..., expected_initial_capture_sha256=
    the consumer's own value), never the recheck record's.
  4 finality core on the guest's node: import/runtime compatibility of the r10 core bytes + pinned @noble/hashes (keccak KAT).
  5 live Base proof: NOT RUN and never simulated. Base is not synced/launched, so no launch record (anchor N block hash) exists; the core
    is never given a fabricated original. The verified recheck's fresh candidate and the :18545 listener state are recorded only.
Writes <C>/out/receipt.json (public, bounded). Exit 0 only if 1-4 hold."""
import hashlib, importlib.util, json, os, pathlib, re, subprocess, sys, time, urllib.request
C = pathlib.Path(sys.argv[1]); SETTINGS = sys.argv[2]; OPT = C / 'opt'; EL = 'http://127.0.0.1:18645'
sys.path.insert(0, str(OPT / 'a1-capture'))
import a1_capture as M
sha = lambda b: hashlib.sha256(b).hexdigest()
rec = {'format': 'enclave-guest-capture-canary/v3', 'moduleSha256': sha(pathlib.Path(M.__file__).read_bytes()), 'python': sys.executable}
def save():
    (C / 'out').mkdir(exist_ok=True); (C / 'out/receipt.json').write_text(json.dumps(rec, indent=1, default=str)[:2_000_000])
def fail(step, why):
    rec['failedAt'] = step; rec['failure'] = str(why)[:600]; save()
    print(json.dumps({'failedAt': step, 'failure': rec['failure']})); sys.exit(1)
def ancestors(pid):
    out = []
    while pid > 1:
        out.append(pid)
        try: pid = int(pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
        except OSError: break
    return out
def binder(slot):
    def bind_listener(stage):
        ss = subprocess.run(['ss', '-ltnpH', 'sport = :18550'], capture_output=True, text=True, timeout=10).stdout
        pids = sorted({int(x.split('=')[1]) for x in re.findall(r'pid=\d+', ss)})
        if len(pids) != 1 or os.getpid() not in ancestors(pids[0]):
            raise RuntimeError(f'18550 listener {pids} is not owned by this canary (driver {os.getpid()})')
        slot.update(pid=pids[0], exe=os.path.realpath(f'/proc/{pids[0]}/exe'), ancestry=ancestors(pids[0])[:6])
    return bind_listener
def rpc(m, p):
    return json.load(urllib.request.urlopen(urllib.request.Request(EL, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                                                    {'content-type': 'application/json'}), timeout=10))['result']
def forward_progress(res):
    try:
        cons = json.loads((C / 'out/l1-consistency.json').read_text()); hf = (res.get('heliosStatus') or {}).get('finalized') or {}
        own = rpc('eth_getBlockByNumber', [hex(int(hf['number'])), False]) if 'number' in hf else None
        fp = {'checkpointPayloadNumber': cons['checkpointPayload']['number'], 'heliosFinalized': hf, 'ownElHashAtHeliosFinalized': (own or {}).get('hash')}
        fp['ok'] = bool(own) and int(hf['number']) > cons['checkpointPayload']['number'] and own['hash'] == hf.get('hash')
    except Exception as e:
        fp = {'ok': False, 'error': f'{type(e).__name__}: {e}'[:300]}
    return fp
def el_binding(out, summary):
    b = (out / 'capture/inputs/a1-config.json').read_bytes(); el = json.loads(b).get('elUrl'); h = sha(b)
    r = {'elUrl': el, 'a1ConfigSha256': h, 'verifyBound': (summary or {}).get('boundInputs', {}).get('inputs/a1-config.json') == h if summary else None}
    r['ok'] = el == EL and r['verifyBound'] is not False
    return r
pins = M.Pins(); src = M.Sources.from_settings(SETTINGS)
if src.el_url != EL:
    fail('sources', f'settings elUrl {src.el_url} != {EL}')
oi, orc, wk = C / 'captures/initial', C / 'captures/recheck', str(C / 'tmp')
# ---- 1 initial ----
li = {}; t0 = time.time()
ok, res = M.capture('initial', oi, src=src, pins=pins, hooks={'poll': 3, 'before_exec': binder(li)}, helios_timeout=900, a1_timeout=600)
rec['initial'] = {'captureOk': ok, 'result': {k: v for k, v in res.items() if k != 'heliosStatus'}, 'heliosListener': li, 'captureSec': round(time.time() - t0, 1),
                  'forwardProgress': forward_progress(res)}
if (oi / 'capture/inputs/a1-config.json').exists():
    rec['initial']['el'] = el_binding(oi, None)                     # asserted BEFORE verify too: a wrong port is visible even if capture failed
if not ok:
    fail('initial-capture', res.get('error'))
if not rec['initial']['forwardProgress'].get('ok'):
    fail('initial-forward-progress', rec['initial']['forwardProgress'])
if not rec['initial']['el']['ok']:
    fail('initial-elUrl', rec['initial']['el'])
try: vi = M.verify(oi, pins=pins, node=str(src.node), workdir=wk)
except M.Refused as e: fail('initial-verify', e)
rec['initial']['verify'] = vi; rec['initial']['el'] = el_binding(oi, vi)
if not rec['initial']['el']['ok']:
    fail('initial-elUrl-binding', rec['initial']['el'])
# ---- 2 consumer-owned expectation, recorded before the recheck exists ----
expected = sha((oi / 'capture/capture.json').read_bytes())
if expected != vi['captureSha256']:
    fail('consumer-expectation', 'verified captureSha256 differs from the consumer-read capture.json')
rec['consumerExpectedInitialCaptureSha256'] = expected; save()
# ---- 3 recheck-capture of that initial ----
lr = {}; t0 = time.time(); src2 = M.Sources.from_settings(SETTINGS, initial_capture=oi)
ok, res = M.capture('recheck-capture', orc, src=src2, pins=pins, hooks={'poll': 3, 'before_exec': binder(lr)}, helios_timeout=900, a1_timeout=600)
rec['recheck'] = {'captureOk': ok, 'result': {k: v for k, v in res.items() if k != 'heliosStatus'}, 'heliosListener': lr, 'captureSec': round(time.time() - t0, 1),
                  'forwardProgress': forward_progress(res)}
if (orc / 'capture/inputs/a1-config.json').exists():
    rec['recheck']['el'] = el_binding(orc, None)
if not ok:
    fail('recheck-capture', res.get('error'))
if not rec['recheck']['el']['ok']:
    fail('recheck-elUrl', rec['recheck']['el'])
try: vr = M.verify(orc, pins=pins, node=str(src.node), workdir=wk, initial_out=oi, expected_initial_capture_sha256=expected)
except M.Refused as e: fail('recheck-verify', e)
rec['recheck']['verify'] = vr; rec['recheck']['el'] = el_binding(orc, vr)
if not rec['recheck']['el']['ok'] or (vr.get('initialCapture') or {}).get('captureSha256') != expected:
    fail('recheck-binding', {'el': rec['recheck']['el'], 'initialCapture': vr.get('initialCapture')})
save()
# ---- 4 finality core: import/runtime compatibility on the guest node (NOT a proof) ----
core = {'kind': 'import-runtime-compatibility'}
try:
    sp = importlib.util.spec_from_file_location('finality_state', OPT / 'finality/src/finality_state.py'); F = importlib.util.module_from_spec(sp)
    sys.path.insert(0, str(OPT / 'finality/src')); sp.loader.exec_module(F)
    core['corePins'] = {rel: sha((OPT / 'finality' / rel).read_bytes()) == want for rel, want in F.CORE_PINS.items()}
    noble = OPT / 'finality/deps/node_modules/@noble/hashes'
    core['nobleTree'] = F.tree_sha256(noble) == F.NOBLE_TREE_SHA256
    script = ("const c=await import(process.env.C);const k=await import(process.env.K);"
              "const h=Buffer.from(k.keccak_256(new Uint8Array(0))).toString('hex');"
              "console.log(JSON.stringify({node:process.version,verdictConst:c.VERDICT,qualify:typeof c.qualify,chainId:c.BASE_CHAIN_ID,keccakEmpty:h}))")
    p = subprocess.run(['/usr/bin/node', '--input-type=module', '-e', script], capture_output=True, text=True, timeout=120,
                       env={'C': (OPT / 'finality/src/finality-core.mjs').as_uri(), 'K': (noble / 'sha3.js').as_uri(), 'PATH': '/usr/bin:/bin'})
    core['node'] = json.loads(p.stdout.strip().splitlines()[-1]) if p.returncode == 0 and p.stdout.strip() else {'rc': p.returncode, 'stderr': p.stderr[-400:]}
    n = core['node']
    core['ok'] = all(core['corePins'].values()) and core['nobleTree'] and n.get('qualify') == 'function' and n.get('chainId') == '0x2105' \
        and n.get('verdictConst') == 'post-anchor-finality-qualified' and n.get('keccakEmpty') == 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
except Exception as e:
    core.update(ok=False, error=f'{type(e).__name__}: {e}'[:400])
rec['finalityCore'] = core
# ---- 5 live Base proof: recorded as NOT RUN (no fabricated launch record, no RPC request to :18545) ----
g = vr.get('gate') or {}
ss = subprocess.run(['ss', '-ltnH', 'sport = :18545'], capture_output=True, text=True, timeout=10).stdout
rec['liveBaseProof'] = {'status': 'not-run', 'verdict': None,
                        'reason': 'Base EL not synced/launched: no launch record (anchor N block hash) exists, so qualify() has no authentic original',
                        'freshCandidate': {k: g.get(k) for k in ('N', 'outputRoot', 'game') if k in g}, 'base18545Listening': bool(ss.strip())}
save()
if not core.get('ok'):
    fail('finality-core-compat', core)
print(json.dumps({'initial': True, 'recheck': True, 'elUrl': EL, 'finalityCoreCompat': True, 'liveBaseProof': 'not-run'}))
sys.exit(0)

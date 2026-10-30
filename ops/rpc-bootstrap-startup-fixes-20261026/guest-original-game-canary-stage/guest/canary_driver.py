#!/usr/bin/python3.12
"""canary_driver.py C SETTINGS (guest, root, inside the r3 canary scope; guest-original-game-canary; PREPARED, NOT run).
Runs ONLY the composed capture module's ORIGINAL-GAME `recheck` mode (pinned initial receipt b9a90847 -> original game/N/root) the way
the first-bootstrap consumer declared in CONSUMER-CONTRACT.json, then the module's own verify(). Never `initial`, never another game.
  1 production Sources: the composed module's own from_settings() over a canary-private settings file whose key set is EXACTLY the
    module's SOURCES_KEYS (values from the r3 canary.sh settings: guest EL 127.0.0.1:18645, the canary Helios config, installed modules);
    the pinned initial receipt is supplied ONLY by the contract's declared mechanism; anything else -> BLOCKED (exit 4), no workaround.
  2 capture('recheck') with the module's default Pins (runtime identities) and the contract's capture kwargs (helios_timeout raised only
    because the canary Helios is cold-started from the pinned checkpoint); a REFUSED recheck (e.g. game retired/blacklisted, not
    finalized, ASR moved, timeout) is reported verbatim as the result: no retry with another game, no substitution (exit 1).
  3 verify(): mode recheck; bound initial == module INITIAL_SHA256 == the pinned b9a90847; gate game/N/root == the module's
    RECHECK_ORIGINAL == this canary's independent EXPECTED; derived a1-config elUrl == http://127.0.0.1:18645 and bound by verify;
    Helios forward progress on our own EL (as r2/r3). No admission ledger, no /etc/enclave-rpc write, nothing outside <C>.
Writes <C>/out/receipt.json. Exit 0 verified, 1 refused/failed, 4 blocked (contract or production-source gap)."""
import hashlib, json, os, pathlib, re, subprocess, sys, time, urllib.request
C = pathlib.Path(sys.argv[1]); SETTINGS = pathlib.Path(sys.argv[2]); OPT = C / 'opt'; U = pathlib.Path('/run/enclave-canary-' + C.name[len('canary-'):])
EL = 'http://127.0.0.1:18645'
EXPECTED = {'initialSha256': 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c', 'game': '0x343b3a99527af07d2cfb2652747b9e37715e21ac',
            'N': '52866960', 'outputRoot': '0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700'}
sha = lambda b: hashlib.sha256(b).hexdigest()
rec = {'format': 'enclave-guest-original-game-canary/v1', 'expected': EXPECTED}
def save():
    (C / 'out').mkdir(exist_ok=True); (C / 'out/receipt.json').write_text(json.dumps(rec, indent=1, default=str)[:2_000_000])
def end(code, status, why=None):
    rec['status'] = status
    if why is not None: rec['why'] = str(why)[:800]
    save(); print(json.dumps({'status': status, 'why': rec.get('why')})); sys.exit(code)
contract = json.loads((U / 'CONSUMER-CONTRACT.json').read_text())
rec['contract'] = contract
sys.path.insert(0, str(OPT / 'a1-capture'))
import a1_capture as M
rec['moduleSha256'] = sha(pathlib.Path(M.__file__).read_bytes())
if (M.INITIAL_SHA256, M.RECHECK_ORIGINAL.get('originalGame'), M.RECHECK_ORIGINAL.get('originalN'), M.RECHECK_ORIGINAL.get('originalOutputRoot')) != \
        (EXPECTED['initialSha256'], EXPECTED['game'], EXPECTED['N'], EXPECTED['outputRoot']):
    end(4, 'blocked', f'the composed module pins another original game/receipt: {M.INITIAL_SHA256[:12]} {M.RECHECK_ORIGINAL}')
# ---- 1 production Sources, exactly the module's key set ----
base = json.loads(SETTINGS.read_text())
ini_path = str(OPT / contract['initialReceiptInstallPath'].removeprefix('/opt/enclave-rpc/'))
if sha(pathlib.Path(ini_path).read_bytes()) != EXPECTED['initialSha256']:
    end(4, 'blocked', 'the installed initial receipt is not b9a90847')
keys = set(M.SOURCES_KEYS); unknown = keys - set(base) - {'initialReceipt'}
if unknown:
    end(4, 'blocked', f'the composed SOURCES_KEYS has keys this canary has no reviewed value for: {sorted(unknown)} (update the contract)')
settings = {k: base[k] for k in keys if k in base}
if 'initialReceipt' in keys:
    settings['initialReceipt'] = ini_path
sp = C / 'etc/a1-capture-sources-original.json'
fd = os.open(sp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(settings, f)
try:
    src = M.Sources.from_settings(str(sp))
except M.Refused as x:
    end(4, 'blocked', f'production from_settings refused the canary settings: {x}')
mech = contract['initialReceiptSupply']
if mech == 'sources-key':
    if 'initialReceipt' not in keys:
        end(4, 'blocked', 'contract says sources-key but the composed SOURCES_KEYS has no initialReceipt')
elif mech == 'replace-after-from_settings':
    import dataclasses
    src = dataclasses.replace(src, initial_receipt=pathlib.Path(ini_path))
else:
    end(4, 'blocked', f'unknown initialReceiptSupply {mech!r}')
if str(getattr(src, 'initial_receipt', None)) != ini_path:
    end(4, 'blocked', f'production Sources do not supply the pinned initial receipt (initial_receipt={getattr(src, "initial_receipt", None)!r}): '
        'the original-game recheck mode is unreachable on the production path')
if src.el_url != EL:
    end(4, 'blocked', f'Sources elUrl {src.el_url} != {EL}')
rec['sources'] = {'keys': sorted(keys), 'supply': mech, 'initialReceipt': ini_path, 'elUrl': src.el_url}
save()
# ---- 2 the original-game recheck capture ----
owner = {}
def ancestors(pid):
    out = []
    while pid > 1:
        out.append(pid)
        try: pid = int(pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
        except OSError: break
    return out
def bind_listener(stage):
    ss = subprocess.run(['ss', '-ltnpH', 'sport = :18550'], capture_output=True, text=True, timeout=10).stdout
    pids = sorted({int(x.split('=')[1]) for x in re.findall(r'pid=\d+', ss)})
    if len(pids) != 1 or os.getpid() not in ancestors(pids[0]):
        raise RuntimeError(f'18550 listener {pids} is not owned by this canary (driver {os.getpid()})')
    owner.update(pid=pids[0], exe=os.path.realpath(f'/proc/{pids[0]}/exe'))
pins = M.Pins(); out = C / 'captures/original'; kw = dict(contract.get('captureKwargs') or {})
kw['helios_timeout'] = max(int(kw.get('helios_timeout', 90)), 900)      # canary-only: Helios cold-starts from the pinned checkpoint
t0 = time.time()
try:
    ok, res = M.capture('recheck', out, src=src, pins=pins, hooks={'poll': 3, 'before_exec': bind_listener}, **kw)
except M.Refused as x:
    rec['capture'] = {'ok': False, 'refused': str(x)[:600]}; end(1, 'failed', f'capture refused before/while running: {x}')
rec['capture'] = {'ok': ok, 'result': {k: v for k, v in res.items() if k != 'heliosStatus'}, 'heliosListener': owner,
                  'sec': round(time.time() - t0, 1), 'kwargs': kw}
evp = out / 'capture/evidence.json'
if evp.exists():
    try:
        e = json.loads(evp.read_text())
        rec['evidence'] = {k: e.get(k) for k in ('verdict', 'code', 'message', 'game', 'N', 'outputRoot', 'at', 'l1')}
    except ValueError:
        rec['evidence'] = {'unparsable': True}
cfgp = out / 'capture/inputs/a1-config.json'
if cfgp.exists():
    rec['a1Config'] = {'elUrl': json.loads(cfgp.read_text()).get('elUrl'), 'sha256': sha(cfgp.read_bytes())}
try:
    cons = json.loads((C / 'out/l1-consistency.json').read_text()); hf = (res.get('heliosStatus') or {}).get('finalized') or {}
    rpc = lambda m, p: json.load(urllib.request.urlopen(urllib.request.Request(EL, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': m, 'params': p}).encode(),
                                                                                {'content-type': 'application/json'}), timeout=10))['result']
    own = rpc('eth_getBlockByNumber', [hex(int(hf['number'])), False]) if 'number' in hf else None
    rec['forwardProgress'] = {'ok': bool(own) and int(hf['number']) > cons['checkpointPayload']['number'] and own['hash'] == hf.get('hash'), 'heliosFinalized': hf}
except Exception as x:
    rec['forwardProgress'] = {'ok': False, 'error': f'{type(x).__name__}: {x}'[:300]}
if not ok:
    ev = rec.get('evidence') or {}
    end(1, 'refused' if ev.get('verdict') == 'refused' else 'failed',
        f"original-game recheck did not pass: {ev.get('code') or res.get('error')}: {ev.get('message') or res.get('a1Exit')} "
        '(reported as is; no other game is tried)')
# ---- 3 verify + bindings ----
try:
    s = M.verify(out, pins=pins, node=str(src.node), workdir=str(C / 'tmp'))
except M.Refused as x:
    end(1, 'failed', f'verify refused: {x}')
g = s.get('gate') or {}
rec['verify'] = {k: s.get(k) for k in ('captureId', 'captureSha256', 'mode', 'evidenceSha256', 'startedAt', 'finishedAt', 'runtimePolicy', 'boundInputs')}
rec['gate'] = {k: g.get(k) for k in ('game', 'N', 'outputRoot', 'asr', 'at', 'l1', 'initialSha256')}
checks = {'mode': s.get('mode') == 'recheck',
          'initialBound': (s.get('boundInputs') or {}).get('inputs/initial-a1-evidence.json') == EXPECTED['initialSha256'],
          'original': (str(g.get('game', '')).lower(), str(g.get('N', '')), str(g.get('outputRoot', '')).lower()) == (EXPECTED['game'], EXPECTED['N'], EXPECTED['outputRoot']),
          'elUrl': (rec.get('a1Config') or {}).get('elUrl') == EL,
          'elUrlBound': (s.get('boundInputs') or {}).get('inputs/a1-config.json') == (rec.get('a1Config') or {}).get('sha256'),
          'forwardProgress': rec['forwardProgress'].get('ok') is True}
rec['checks'] = checks
if not all(checks.values()):
    end(1, 'failed', f'binding checks failed: {[k for k, v in checks.items() if not v]}')
end(0, 'verified', 'the original game b9a90847 -> 0x343b3a99/52866960 rechecked and verified on the composed bytes (no admission, no production write)')

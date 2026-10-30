#!/usr/bin/env python3
"""ROOT live runner (read-only on chain; NOT run by this stage). Pattern of root's executed l1-anchor-a1/live-1958/run.py:
start the pinned own-L1 Helios (l1-authority launcher, existing config), wait for a fresh-finalized status, run the
original-game recheck once, stop Helios. Writes only into a NEW output dir (exclusive creates).
  python3 -I run-recheck.py OUT_DIR        (e.g. .../outputs/rpc-production-final-20261025/l1-a1-recheck-HHMM)
Under the shared queue: python3 work/claude-test-queue.py --mib 256 --log OUT_DIR.guard -- python3 -I run-recheck.py OUT_DIR"""
import datetime, hashlib, json, os, pathlib, signal, subprocess, sys, time
W = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo'); P = W / 'work/rpc-production-final-20261025'
O = W / 'outputs/rpc-production-final-20261025'; HERE = pathlib.Path(__file__).resolve().parent
OUT = pathlib.Path(sys.argv[1]); OUT.mkdir(mode=0o755)                      # must not exist: never overwrite evidence
sys.path.insert(0, str(P / 'finality-stage/l1-authority')); import l1_authority as L
HCFG = O / 'l1-authority-live-1941/config.json'; c = L.load_config(str(HCFG))  # pinned Helios cc962e2b, own Lighthouse + reth
INITIAL = P / 'source/ops/rpc-backend-bootstrap/2026-10-25/l1-anchor-a1/live-1958/a1-evidence.json'
INITIAL_SHA = 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'
assert hashlib.sha256(INITIAL.read_bytes()).hexdigest() == INITIAL_SHA, 'initial A1 receipt changed'
cfg = {'heliosUrl': 'http://127.0.0.1:28550', 'elUrl': 'http://127.0.0.1:28645', 'expectedChainId': 1, 'pinBy': 'hash',
       'portal': '0x49048044d57e1c92a77f79988d21fa8faf74e97e', 'asr': '0x909f6cf47ed12f010a796527f562bfc26c7f4e72',
       'portalAsrGetter': 'anchorStateRegistry()', 'maxFinalizedAgeSec': 1800, 'initialEvidenceSha256': INITIAL_SHA,
       'originalGame': '0x343b3a99527af07d2cfb2652747b9e37715e21ac', 'originalN': '52866960',
       'originalOutputRoot': '0xa996c517b0e797b56426059d57c93ac8352b21b61e04b2fc66866dd61d056700'}
(OUT / 'recheck-config.json').open('x').write(json.dumps(cfg, indent=2))
pins = {f: hashlib.sha256((HERE / f).read_bytes()).hexdigest() for f in ['a1-recheck.mjs', 'a1-recheck-read.mjs', 'a1-anchor.mjs', 'a1-read.mjs', 'vendor/anchor-bootstrap.mjs']}
r = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'productionActivated': False, 'inputPins': pins, 'initialSha256': INITIAL_SHA}
p = None
try:
    with (OUT / 'helios.out').open('x') as log:
        p = subprocess.Popen([sys.executable, str(P / 'finality-stage/l1-authority/l1_authority.py'), 'run', str(HCFG)], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        end = time.monotonic() + 90
        while True:
            time.sleep(3)
            try: r['heliosStatus'] = L.status(c); break
            except Exception:
                if time.monotonic() > end or p.poll() is not None: raise
        env = dict(os.environ, ANCHOR_DEPS_ROOT=str(P / 'source'))
        with (OUT / 'recheck.json').open('x') as out, (OUT / 'recheck.stderr').open('x') as err:
            x = subprocess.run(['node', str(HERE / 'a1-recheck-read.mjs'), str(OUT / 'recheck-config.json'), str(INITIAL)], env=env, stdout=out, stderr=err, timeout=240)
        r['recheckExit'] = x.returncode
except Exception as e: r['error'] = type(e).__name__ + ': ' + str(e)[:300]
finally:
    if p is not None and p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        try: p.wait(timeout=10)
        except subprocess.TimeoutExpired: os.killpg(p.pid, signal.SIGKILL); p.wait(timeout=5)
    r['processStopped'] = p is not None and p.poll() is not None
    r['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (OUT / 'run-result.json').open('x').write(json.dumps(r, indent=2))
print(json.dumps({k: v for k, v in r.items() if k != 'heliosStatus'}))
sys.exit(0 if r.get('recheckExit') == 0 and r['processStopped'] else 1)

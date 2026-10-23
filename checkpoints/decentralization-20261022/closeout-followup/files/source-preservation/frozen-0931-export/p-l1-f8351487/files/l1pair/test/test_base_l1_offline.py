"""The OFFICIAL base v1.5.1 binary (S's staged 9c44836d, read-only) under S's COMMITTED launcher (vendor/holder/holder.py,
6b9dae92), with l1.executionRpc = the REAL reth v2.8.0 of this package (mainnet, empty datadir, run-el) and l1.beacon = a
LABELLED STAND-IN (not lighthouse) that answers only /eth/v1/config/spec and /eth/v1/beacon/genesis with mainnet values
and 404 for everything else. Network-denied namespace (loopback only).

Reference (S, logs/bp-off1.out): the same binary with L1 unreachable exits 1 after 5.8 s (unsafe-signer lookup retries
exhausted). This test shows the startup L1 dependency is met by the self-hosted execution side: Base stays up, answers
0x2105, and logs no exhausted L1 retries.
Does NOT prove: derivation, blobs, safe/finalized progress, or anything about a synced L1 (reth is at genesis, so
SystemConfig storage reads zero and Base falls back to its built-in signer)."""
import copy, json, os, re, shutil, signal, subprocess, sys, tempfile, threading, time, unittest
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import realrig as R  # noqa: E402
L, H = R.L, R.L.H
EXAMPLE = json.loads((R.PKG / 'vendor/holder/holder.example.json').read_text())
OBSERVE_SEC = 120


class BeaconStandIn:
    """STAND-IN, not a beacon node: records every path Base requests."""
    def __init__(self):
        self.paths = []
        me = self

        class Hd(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_GET(self):
                me.paths.append(self.path)
                p = self.path.split('?')[0]
                body = {'/eth/v1/config/spec': {'data': {'SECONDS_PER_SLOT': '12', 'DEPOSIT_CHAIN_ID': '1'}},
                        '/eth/v1/beacon/genesis': {'data': {'genesis_time': str(L.MAIN['clGenesisTime']),
                                                            'genesis_validators_root': L.MAIN['clGenesisValidatorsRoot']}}}.get(p)
                b = json.dumps(body if body else {'code': 404, 'message': 'stand-in: not served'}).encode()
                self.send_response(200 if body else 404); self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), Hd)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]

    def close(self):
        self.srv.shutdown(); self.srv.server_close()


class BaseOnRealL1Execution(unittest.TestCase):
    def test_official_base_starts_against_the_real_self_hosted_execution_side(self):
        rb, bb = Path(os.environ.get('RETH_BIN', '')), Path(os.environ.get('BASE_BIN', ''))
        if not rb.is_file() or not bb.is_file():
            self.skipTest('RETH_BIN/BASE_BIN not set')
        self.assertEqual(H.sha256_file(bb), H.BINARY['binary']['sha256'])
        rig = R.RethRig(rb, os.environ['SCRATCH'])
        bcn = BeaconStandIn()
        # short path: base binds <datadir>/engine.ipc and AF_UNIX paths are capped at 107 bytes (sun_path); the
        # production datadir /srv/enclave-base-holder/data is short. Allocated size here is ~1.5 MB (sparse MDBX).
        tmp = Path(tempfile.mkdtemp(prefix='bh-', dir='/tmp'))
        report = {}
        p = None
        try:
            self.assertIsNotNone(rig.wait_ready(), rig.text()[-2000:])
            (tmp / 'mnt' / 'data').mkdir(parents=True); (tmp / 'mnt' / 'tmp').mkdir(); (tmp / 'run').mkdir()
            os.chmod(tmp / 'mnt' / 'data', 0o700)
            c = copy.deepcopy(EXAMPLE)
            c['binary']['path'] = str(bb)
            c['l1'] = {'executionRpc': f"http://127.0.0.1:{rig.c['execution']['httpPort']}/",
                       'beacon': f'http://127.0.0.1:{bcn.port}/', 'trustRpc': False}
            c['datadir'] = str(tmp / 'mnt' / 'data')
            c['storage'].update(mountPoint=str(tmp / 'mnt'), cache={'mechanism': 'none'})
            c['storage'].pop('nvmeBudget', None)            # S 959e56f: a ledger reservation applies only to a cache
            c['rpc']['port'] = R.free_port(); c['consensusRpc']['port'] = R.free_port()
            for k in ('executionPort', 'discoveryV5Port', 'consensusTcpPort', 'consensusUdpPort'):
                c['p2p'][k] = R.free_port()
            c['limits'].update(readyTimeoutSec=OBSERVE_SEC + 60, stopTimeoutSec=60)
            v = H.validate(c)
            self.assertTrue(v['l1']['selfHosted'])
            cfg = tmp / 'holder.json'; cfg.write_text(json.dumps(c))
            logf = open(tmp / 'base.log', 'w')
            t0 = time.monotonic()
            p = subprocess.Popen([sys.executable, '-I', str(R.PKG / 'vendor/holder/holder.py'), 'run', str(cfg)],
                                 env={'PATH': '/usr/bin:/bin', 'RUNTIME_DIRECTORY': str(tmp / 'run')}, cwd=str(tmp),
                                 stdout=logf, stderr=subprocess.STDOUT)
            chain, answered = None, None
            while p.poll() is None and time.monotonic() - t0 < OBSERVE_SEC:
                if answered is None:
                    try:
                        chain = H.rpc_call(v['rpc']['port'], 'eth_chainId', timeout=1)
                        answered = round(time.monotonic() - t0, 1) if chain else None
                    except Exception:
                        pass
                time.sleep(0.5)
            alive = p.poll() is None
            ran = round(time.monotonic() - t0, 1)
            if alive:
                p.send_signal(signal.SIGTERM)
            rc = p.wait(120)
            logf.close()
            log = re.sub(r'\x1b\[[0-9;]*m', '', (tmp / 'base.log').read_text(errors='replace'))
            l1 = [l[:260] for l in log.splitlines() if re.search(r'(?i)signer|l1 |l1_|upgrade signal|beacon|derivation|retrying', l)]
            report = {'baseBinary': H.BINARY['binary']['sha256'], 'aliveAfterSec': ran if alive else None, 'exitedAfterSec': None if alive else ran,
                      'exitCode': rc, 'chainId': chain, 'chainIdAfterSec': answered, 'beaconPathsRequested': sorted(set(x.split('?')[0] for x in bcn.paths)),
                      'retryExhausted': bool(re.search(r'(?i)retries exhausted|failed to resolve unsafe block signer|Failed to start', log)),
                      'signerLines': [l for l in l1 if re.search(r'(?i)signer', l)][:8], 'l1Lines': l1[:30],
                      'reference': 'S logs/bp-off1.out: same binary, L1 unreachable -> exit 1 after 5.8 s'}
            self.assertTrue(alive, f'base exited early (rc={rc}); log tail: {log[-2500:]}')
            self.assertEqual(chain, '0x2105')
            self.assertFalse(report['retryExhausted'])
            self.assertFalse(any('Retrying L1 latest block number lookup' in l for l in l1), 'the L1 head lookup must succeed against reth')
        finally:
            if p and p.poll() is None:
                p.kill()
            bcn.close()
            rc_el, took = rig.stop()
            report.update(rethExit=rc_el, rethStopSec=took, rethDatadir=rig.du())
            print(json.dumps(report, indent=1, default=str))
            shutil.rmtree(rig.tmp, ignore_errors=True)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)

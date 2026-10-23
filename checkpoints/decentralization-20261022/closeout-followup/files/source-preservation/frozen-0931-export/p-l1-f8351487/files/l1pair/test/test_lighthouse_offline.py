"""The VERIFIED official lighthouse v8.3.2 (binary 11b7bca8, signature by 15E66D94…) under `l1pair.py run-cl`, paired
over the engine API with the REAL reth v2.8.0 under `run-el`. Ethereum MAINNET config, empty datadirs, network-denied
namespace (loopback only).

1. Refusal: the production argv in `resume` mode on an EMPTY database must NOT start (no silent genesis sync, no hidden
   checkpoint URL); the supervisor propagates the failure and never reports READY.
2. Process/loopback/engine pairing: the beacon node starts from Lighthouse's EMBEDDED mainnet genesis state via the
   TEST-ONLY flags --allow-insecure-genesis-sync --ignore-ws-check, appended by the test driver (lh-1 showed the binary
   refuses the 2020 genesis head as outside the weak-subjectivity period without the second). Production never renders
   either flag. This is mainnet slot 0 offline, NOT a synced node: no peers, no blocks, no blobs.
3. Counter-control: the same start with a WRONG engine JWT must leave the EL offline.

Does NOT prove: sync, finality, blob serving (/eth/v1/beacon/blobs with real data), peer behaviour or HDD throughput."""
import json, os, secrets, shutil, sys, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import realrig as R  # noqa: E402
L = R.L
TEST_ONLY = ['--allow-insecure-genesis-sync', '--ignore-ws-check']   # mainnet genesis (2020) is far outside the WS period


def poll_syncing(port, want_el_offline, secs):
    last = None
    t = time.monotonic()
    while time.monotonic() - t < secs:
        try:
            st, d = L.beacon(port, '/eth/v1/node/syncing')
            last = d['data'] if st == 200 else {'status': st}
            if st == 200 and last.get('el_offline') is want_el_offline:
                return True, last, round(time.monotonic() - t, 1)
        except Exception as e:
            last = repr(e)
        time.sleep(1)
    return False, last, round(time.monotonic() - t, 1)


class LighthouseOffline(unittest.TestCase):
    def test_real_lighthouse_refusal_pairing_and_counter_control(self):
        rb, lb = Path(os.environ.get('RETH_BIN', '')), Path(os.environ.get('LH_BIN', ''))
        if not rb.is_file() or not lb.is_file():
            self.skipTest('RETH_BIN/LH_BIN not set')
        self.assertEqual(L.H.sha256_file(lb), L.PINS['consensus']['binarySha256'])
        el = R.RethRig(rb, os.environ['SCRATCH'])
        report = {'label': 'mainnet config, offline, empty datadirs; pairing run starts from the EMBEDDED genesis via TEST-ONLY --allow-insecure-genesis-sync --ignore-ws-check'}
        try:
            self.assertIsNotNone(el.wait_ready(), el.text()[-2000:])
            # 1. refusal through the launcher (exact production argv, resume mode, empty DB)
            cl = R.ClRig(el, lb, 'cl-refuse')
            ready = cl.wait_ready(timeout=90)
            rc, _ = cl.stop()
            lines = [l[:220] for l in cl.text().splitlines() if any(k in l.lower() for k in ('checkpoint', 'genesis', 'insecure', 'error', 'crit', '"event"'))]
            report['refusal'] = {'ready': ready, 'exitCode': rc, 'after': round(time.monotonic() - cl.t0, 1), 'lines': lines[:12]}
            self.assertIsNone(ready, 'an empty DB without an anchor must never become ready')
            self.assertNotEqual(rc, 0)
            # 3. counter-control: wrong engine secret
            bad = el.tmp / 'wrong-jwt.hex'; bad.write_text(secrets.token_hex(32) + '\n'); os.chmod(bad, 0o600)
            cl = R.ClRig(el, lb, 'cl-badjwt', extra=TEST_ONLY, jwt=bad)
            ready = cl.wait_ready(timeout=180)
            self.assertIsNotNone(ready, cl.text()[-3000:])
            stays_offline, last, _ = poll_syncing(cl.c['consensus']['httpPort'], False, 60)
            rc, took = cl.stop()
            report['wrongJwt'] = {'readyAfterSec': ready, 'elOfflineBecameFalse': stays_offline, 'lastSyncing': last, 'exitCode': rc, 'stopSec': took,
                                  'engineLines': [l[:200] for l in cl.text().splitlines() if 'xecution' in l or 'engine' in l.lower()][:6]}
            self.assertFalse(stays_offline, 'with a wrong JWT the execution engine must not come online')
            # 2. pairing with the right secret
            cl = R.ClRig(el, lb, 'cl-pair', extra=TEST_ONLY)
            ready = cl.wait_ready(timeout=180)
            self.assertIsNotNone(ready, cl.text()[-3000:])
            k = cl.c['consensus']['httpPort']
            online, sync, after = poll_syncing(k, False, 90)
            ver = L.beacon(k, '/eth/v1/node/version')[1]['data']['version']
            ident = L.beacon(k, '/eth/v1/node/identity')[1]['data']
            spec = L.beacon(k, '/eth/v1/config/spec')[1]['data']
            gen = L.beacon(k, '/eth/v1/beacon/genesis')[1]['data']
            bst, bbody = L.beacon(k, '/eth/v1/beacon/blobs/0')
            hst, hbody = L.beacon(k, '/eth/v1/beacon/headers/head')
            seen = R.listeners() - cl.before
            gate = L.ready(cl.c)
            report['pairing'] = {
                'readyAfterSec': ready, 'elOnline': online, 'elOnlineAfterSec': after, 'syncing': sync, 'version': ver,
                'custodyGroupCount': (ident.get('metadata') or {}).get('custody_group_count'),
                'spec': {x: spec.get(x) for x in ('DEPOSIT_CHAIN_ID', 'SECONDS_PER_SLOT', 'FULU_FORK_EPOCH', 'GLOAS_FORK_EPOCH', 'MIN_EPOCHS_FOR_DATA_COLUMN_SIDECARS_REQUESTS')},
                'genesis': gen, 'headSlot': (hbody or {}).get('data', {}).get('header', {}).get('message', {}).get('slot') if hst == 200 else hst,
                'blobsSlot0': {'status': bst, 'body': str(bbody)[:160]},
                'listeners': sorted(f'{i}:{p}' for i, p in seen),
                'gate': {x['check']: (x['ok'], str(x['detail'])[:80]) for x in gate['checks']}}
            self.assertTrue(online, f'the paired CL must see the EL online: {sync}')
            self.assertTrue(ver.startswith('Lighthouse/v8.3.2'))
            self.assertEqual(int((ident.get('metadata') or {}).get('custody_group_count')), 64, 'semi-supernode custody')
            self.assertEqual(gen['genesis_validators_root'], L.MAIN['clGenesisValidatorsRoot'])
            self.assertEqual(str(spec['DEPOSIT_CHAIN_ID']), '1')
            self.assertIn(('127.0.0.1', k), seen)
            for ip, p in seen:
                if p == k:
                    self.assertEqual(ip, '127.0.0.1', 'beacon API must be loopback-only')
                elif ip != '127.0.0.1':
                    self.assertEqual(p, cl.c['p2p']['consensusPort'], f'unexpected non-loopback listener {ip}:{p}')
            ok = {x['check'] for x in gate['checks'] if x['ok']}
            self.assertFalse(gate['ready'])
            self.assertTrue({'cl.genesis', 'cl.spec', 'cl.version', 'cl.custody'} <= ok, gate)
            self.assertFalse({'cl.syncing', 'pair.head', 'cl.blobs', 'el.head', 'el.finalized'} & ok, gate)
            rc, took = cl.stop()
            report['pairing'].update(exitCode=rc, stopSec=took, leftover=sorted(f'{i}:{p}' for i, p in (R.listeners() - cl.before)),
                                     noUrlLines=[l[:160] for l in cl.text().splitlines() if 'http' in l.lower() and 'url' in l.lower()][:5])
            self.assertEqual(rc, 0)
            self.assertEqual(report['pairing']['leftover'], [])
        finally:
            rc_el, _ = el.stop()
            report['reth'] = {'exitCode': rc_el, 'datadir': el.du()}
            print(json.dumps(report, indent=1, default=str))
            shutil.rmtree(el.tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)

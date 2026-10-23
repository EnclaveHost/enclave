"""REAL official reth v2.8.0 (binary 8cdd1f35) under `l1pair.py run-el`, Ethereum mainnet chain, EMPTY datadir,
network-denied namespace (loopback only).

Proves: the rendered argv runs on the real binary; the supervisor's readiness; loopback-only HTTP and engine listeners;
every L1 execution method Base v1.5.1 calls is served on the `eth,net,web3` API (answered at genesis); other namespaces
are refused; the engine API demands the JWT; the persisted prune config is the rendered one (full + receipts 140,000);
the DATA gate stays closed (no CL, head at genesis) even though eth_chainId answers; clean SIGTERM stop.
Does NOT prove: sync, peers, a live head, receipts/state retention over time, or any Lighthouse behaviour."""
import json, os, re, shutil, sys, time, tomllib, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import realrig as R  # noqa: E402
L = R.L
SYSCFG = '0x73a79fab69143498ed3712e519a88a918e1f4072'    # Base mainnet SystemConfig (base v1.5.1 chains/config.rs)
SIGNER_SLOT = '0x65a7ed542fb37fe237fdfbdd70b31598523fe5b32879e307bae27a0bd9581c08'   # keccak("systemconfig.unsafeblocksigner")


class RethOffline(unittest.TestCase):
    def test_real_reth_under_the_launcher(self):
        rb = Path(os.environ.get('RETH_BIN', ''))
        if not rb.is_file():
            self.skipTest('RETH_BIN not set')
        rig = R.RethRig(rb, os.environ['SCRATCH'])
        report = {}
        try:
            ready_at = rig.wait_ready()
            report['readyAfterSec'] = ready_at
            self.assertIsNotNone(ready_at, rig.text()[-3000:])
            e, a = rig.c['execution']['httpPort'], rig.c['execution']['authPort']
            g = L.rpc(e, 'eth_getBlockByNumber', ['0x0', False])
            report['genesisHash'] = g['hash']
            self.assertEqual(g['hash'], L.MAIN['elGenesisHash'])
            self.assertEqual(L.rpc(e, 'eth_chainId'), '0x1')
            self.assertEqual(L.rpc(e, 'net_version'), '1')
            # the exact L1 execution calls of base v1.5.1 (providers/chain_provider.rs, l1_watcher, p2p.rs, upgrade-signal)
            calls = {
                'eth_blockNumber': [],
                'eth_chainId': [],
                'eth_getBlockByNumber(latest)': ('eth_getBlockByNumber', ['latest', False]),
                'eth_getBlockByNumber(finalized)': ('eth_getBlockByNumber', ['finalized', False]),
                'eth_getBlockByNumber(0x0)': ('eth_getBlockByNumber', ['0x0', False]),
                'eth_getBlockByHash': ('eth_getBlockByHash', [g['hash'], False]),
                'eth_getBlockByHash(full)': ('eth_getBlockByHash', [g['hash'], True]),
                'eth_getBlockReceipts(hash)': ('eth_getBlockReceipts', [g['hash']]),
                'eth_getLogs(blockHash,address)': ('eth_getLogs', [{'blockHash': g['hash'], 'address': SYSCFG}]),
                'eth_getStorageAt(blockHash)': ('eth_getStorageAt', [SYSCFG, SIGNER_SLOT, {'blockHash': g['hash']}]),
                'eth_call(latest)': ('eth_call', [{'to': SYSCFG, 'data': '0x'}, 'latest']),
            }
            served = {}
            for name, spec in calls.items():
                m, p = (name, spec) if isinstance(spec, list) else spec
                r = R.rpc_raw(e, m, p)
                served[name] = r.get('result', {'error': r.get('error')})
                self.assertNotIn('error', r, (name, r))
            report['baseMethods'] = served
            self.assertIsNone(served['eth_getBlockByNumber(finalized)'], 'no CL: no finalized block yet (Base skips null)')
            self.assertEqual(served['eth_getBlockReceipts(hash)'], [])
            self.assertEqual(int(served['eth_getStorageAt(blockHash)'], 16), 0, 'genesis: SystemConfig not deployed yet')
            refused = {}
            for m, p in (('admin_nodeInfo', []), ('debug_getRawBlock', ['0x0']), ('txpool_status', []), ('trace_block', ['0x0']),
                         ('miner_setExtra', ['0x']), ('engine_exchangeCapabilities', [[]])):
                r = R.rpc_raw(e, m, p)
                refused[m] = r.get('error', {}).get('code')
                self.assertIn('error', r, (m, r))
            report['refusedOnHttp'] = refused
            # engine API: JWT required on the auth port
            st_ok, body = R.engine_call(a, R.jwt_token(rig.secret))
            st_none, _ = R.engine_call(a, None)
            st_bad, _ = R.engine_call(a, R.jwt_token('00' * 32))
            st_old, _ = R.engine_call(a, R.jwt_token(rig.secret, iat=time.time() - 3600))
            report['engine'] = {'validJwt': st_ok, 'noJwt': st_none, 'wrongKey': st_bad, 'staleIat': st_old, 'caps': json.loads(body).get('result', [])[:6]}
            self.assertEqual(st_ok, 200); self.assertIn('result', json.loads(body))
            for s in (st_none, st_bad, st_old):
                self.assertEqual(s, 401)
            seen = R.listeners() - rig.before
            report['listeners'] = sorted(f'{ip}:{port}' for ip, port in seen)
            for port in (e, a):
                self.assertIn(('127.0.0.1', port), seen)
                self.assertFalse(any(p == port and ip != '127.0.0.1' for ip, p in seen), f'port {port} not loopback-only')
            for ip, p in seen:
                if ip != '127.0.0.1':
                    self.assertEqual(p, rig.c['p2p']['executionPort'], f'unexpected non-loopback listener {ip}:{p}')
            # the prune configuration the node persisted is the rendered one
            toml = Path(rig.c['execution']['datadir']) / 'reth.toml'
            seg = tomllib.loads(toml.read_text())['prune']['segments']
            report['persistedPrune'] = seg
            self.assertEqual(seg['receipts'], {'distance': 140000})
            self.assertEqual(seg['sender_recovery'], 'full')
            self.assertEqual(seg['account_history'], {'distance': 10064})
            self.assertEqual(seg['storage_history'], {'distance': 10064})
            self.assertNotIn('transaction_lookup', seg)
            # the DATA gate: process-ready with chain id 0x1, but NOT a usable Base L1 source
            r = L.ready(rig.c)
            report['gate'] = {x['check']: (x['ok'], str(x['detail'])[:90]) for x in r['checks']}
            self.assertFalse(r['ready'])
            ok = {x['check'] for x in r['checks'] if x['ok']}
            self.assertTrue({'el.chainId', 'el.genesis'} <= ok)
            self.assertFalse({'el.head', 'el.finalized', 'cl.genesis', 'cl.syncing', 'cl.blobs', 'pair.head'} & ok)
            report['ipcSocket'] = any(f.suffix == '.ipc' for f in Path(rig.c['execution']['datadir']).rglob('*'))
            self.assertFalse(report['ipcSocket'])
        finally:
            rc, took = rig.stop()
            report.update(exitCode=rc, stopSec=took, leftoverListeners=sorted(f'{i}:{p}' for i, p in (R.listeners() - rig.before)),
                          datadir=rig.du(), supervisorLog=[l for l in rig.text().splitlines() if l.startswith('{"event"')])
            print(json.dumps(report, indent=1, default=str))
            shutil.rmtree(rig.tmp, ignore_errors=True)
        self.assertEqual(rc, 0)
        self.assertEqual(report['leftoverListeners'], [])


if __name__ == '__main__':
    unittest.main(verbosity=2)

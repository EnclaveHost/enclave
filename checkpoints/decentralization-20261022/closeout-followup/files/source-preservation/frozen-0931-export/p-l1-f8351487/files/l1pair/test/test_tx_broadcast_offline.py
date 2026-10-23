"""execution.txBroadcast on the REAL reth v2.8.0, two peers, OFFLINE (network-denied namespace, loopback only).

TEST NETWORK, not mainnet: both nodes run a throwaway genesis (chainId 1337, every fork at 0, the format of the existing
rpc-priority/fixture-tools reth genesis) that funds ONE public Hardhat test address. A synthetic EIP-1559 transfer is
signed offline with that publicly known test key (viem, already installed in the workspace) - no real key, no funds.

Node A runs the launcher's rendered argv in the mode under test, with only --chain replaced (test seam). Node B is a
normal reth peer (standard gossip) connected to A by --trusted-peers. Both get engine_forkchoiceUpdatedV3(genesis)
over JWT so neither is "initially syncing". Then A receives eth_sendRawTransaction and we observe:
  admission  = A returns the hash AND A's own eth_getTransactionByHash finds it (local pool)
  propagation = B's eth_getTransactionByHash finds it (it crossed the P2P link)
One empty test block is built with reth's own payload builder over the engine API (as a CL would) BEFORE the send, so
the receiving peer leaves its initial-sync state; nothing is built after the send. A returned hash or B's pool entry
is NOT inclusion."""
import json, os, re, shutil, subprocess, sys, time, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import realrig as R  # noqa: E402
L = R.L
CHAIN = 1337
HARDHAT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'   # public test address (Hardhat/Anvil account 0)
VIEM_FROM = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/native-front-abort/repo/package.json'
SIGN = r"""
const { createRequire } = require('module');
const req = createRequire(process.argv[1]);
const { privateKeyToAccount } = req('viem/accounts');
// Hardhat/Anvil default account 0: a PUBLIC test key printed by every Hardhat install; funded only on this test genesis
const acct = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const to = '0x000000000000000000000000000000000000dEaD';   // deliberately NOT the Base portal: the API has no allowlist
Promise.all([
  acct.signTransaction({ chainId: 1337, type: 'eip1559', nonce: 0, to, value: 1n, gas: 21000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n }),
  acct.signTransaction({ chainId: 1, type: 'eip1559', nonce: 1, to, value: 1n, gas: 21000n, maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n }),
  acct.signTransaction({ type: 'legacy', nonce: 2, to, value: 1n, gas: 21000n, gasPrice: 3000000000n }),
  acct.signTransaction({ chainId: 1337, type: 'eip1559', nonce: 3, to, value: 1n, gas: 21000n, maxFeePerGas: 100000000000000n, maxPriorityFeePerGas: 1000000000n }),
]).then(([raw, wrongChain, unprotected, overFeeCap]) => {
  process.stdout.write(JSON.stringify({ from: acct.address, raw, wrongChain, unprotected, overFeeCap }));
});
"""


def genesis(path):
    g = {'config': {'chainId': CHAIN, 'homesteadBlock': 0, 'eip150Block': 0, 'eip155Block': 0, 'eip158Block': 0, 'byzantiumBlock': 0,
                    'constantinopleBlock': 0, 'petersburgBlock': 0, 'istanbulBlock': 0, 'berlinBlock': 0, 'londonBlock': 0,
                    'mergeNetsplitBlock': 0, 'terminalTotalDifficulty': 0, 'terminalTotalDifficultyPassed': True, 'shanghaiTime': 0,
                    'cancunTime': 0, 'pragueTime': 0, 'depositContractAddress': '0x' + '00' * 20,
                    'blobSchedule': {'cancun': {'target': 3, 'max': 6, 'baseFeeUpdateFraction': 3338477},
                                     'prague': {'target': 6, 'max': 9, 'baseFeeUpdateFraction': 5007716}}},
         'nonce': '0x0', 'timestamp': hex(int(time.time()) - 60), 'extraData': '0x', 'gasLimit': '0x1c9c380', 'difficulty': '0x0',
         'baseFeePerGas': '0x3b9aca00', 'mixHash': '0x' + '00' * 32, 'coinbase': '0x' + '00' * 20, 'number': '0x0', 'parentHash': '0x' + '00' * 32,
         'alloc': {HARDHAT0[2:].lower(): {'balance': hex(10 ** 21)}}}
    Path(path).write_text(json.dumps(g))


def wait(pred, secs, step=0.5):
    t = time.monotonic()
    while time.monotonic() - t < secs:
        try:
            v = pred()
            if v:
                return v, round(time.monotonic() - t, 1)
        except Exception:
            pass
        time.sleep(step)
    return None, round(time.monotonic() - t, 1)


def fcu_genesis(node):
    g = L.rpc(node.c['execution']['httpPort'], 'eth_getBlockByNumber', ['0x0', False])['hash']
    st, body = R.engine_call(node.c['execution']['authPort'], R.jwt_token(node.secret), 'engine_forkchoiceUpdatedV3',
                             [{'headBlockHash': g, 'safeBlockHash': g, 'finalizedBlockHash': g}, None])
    return st, json.loads(body).get('result', {}).get('payloadStatus', {}).get('status')


def engine(node, method, params):
    st, body = R.engine_call(node.c['execution']['authPort'], R.jwt_token(node.secret), method, params)
    j = json.loads(body)
    assert st == 200 and 'result' in j, (method, st, body[:300])
    return j['result']


def advance_one_block(a, b):
    """TEST NETWORK block production exactly as a CL drives it: reth's OWN payload builder on A (forkchoiceUpdatedV3 with
    attributes, getPayloadV4), then newPayloadV4 + forkchoiceUpdatedV3 on A and B. Needed because reth ignores peers'
    transaction announcements until a live canonical head arrives (launch/engine.rs:389, transactions/mod.rs:662)."""
    g = L.rpc(a.c['execution']['httpPort'], 'eth_getBlockByNumber', ['0x0', False])
    zero = '0x' + '00' * 32
    fc = {'headBlockHash': g['hash'], 'safeBlockHash': g['hash'], 'finalizedBlockHash': g['hash']}
    attrs = {'timestamp': hex(int(g['timestamp'], 16) + 12), 'prevRandao': zero, 'suggestedFeeRecipient': '0x' + '00' * 20,
             'withdrawals': [], 'parentBeaconBlockRoot': zero}
    pid = engine(a, 'engine_forkchoiceUpdatedV3', [fc, attrs])['payloadId']
    time.sleep(1)
    got = engine(a, 'engine_getPayloadV4', [pid])
    pl = got['executionPayload']
    out = {}
    for n, node in (('A', a), ('B', b)):
        st = engine(node, 'engine_newPayloadV4', [pl, [], zero, got.get('executionRequests', [])])['status']
        h = engine(node, 'engine_forkchoiceUpdatedV3', [{'headBlockHash': pl['blockHash'], 'safeBlockHash': pl['blockHash'],
                                                         'finalizedBlockHash': pl['blockHash']}, None])['payloadStatus']['status']
        out[n] = (st, h)
    return {'block': pl['blockNumber'], 'hash': pl['blockHash'], 'txs': len(pl['transactions']), 'status': out}


def run_pair(scratch, reth, gfile, mode):
    out = {'modeUnderTestOnA': mode}
    seam = {'set': {'--chain': str(gfile)}, 'chainIdHex': hex(CHAIN)}

    def mode_a(c):
        c['execution']['txBroadcast'] = mode
    a = R.RethRig(reth, scratch, mutate=mode_a, seam=seam)
    b = None
    try:
        assert a.wait_ready(), a.text()[-2000:]
        plain = lambda: re.sub(r'\x1b\[[0-9;]*m', '', a.text())      # reth colours its log
        enode, _ = wait(lambda: (re.search(r'enode=(enode://[0-9a-f]{128}@[0-9.]+:[0-9]+)', plain()) or [None, None])[1], 30)
        assert enode, a.text()[-2000:]
        enode = re.sub(r'@0\.0\.0\.0:', '@127.0.0.1:', enode)

        def mode_b(c):
            c['execution']['txBroadcast'] = 'local-raw-propagate'   # B = a normal reth peer
        b = R.RethRig(reth, scratch, mutate=mode_b, seam=dict(seam, append=['--trusted-peers', enode]))
        assert b.wait_ready(), b.text()[-2000:]
        ea, eb = a.c['execution']['httpPort'], b.c['execution']['httpPort']
        out['argvA_txFlags'] = [x for x in L.el_argv(a.c) if 'tx' in x or 'gossip' in x]
        peers, t_peer = wait(lambda: int(L.rpc(ea, 'net_peerCount'), 16) >= 1 and int(L.rpc(eb, 'net_peerCount'), 16) >= 1, 60)
        out['peersConnected'], out['peerAfterSec'] = bool(peers), t_peer
        assert peers, 'the two test peers never connected: absence of propagation would prove nothing'
        out['fcu'] = {'A': fcu_genesis(a), 'B': fcu_genesis(b)}
        out['advance'] = advance_one_block(a, b)
        heads, _ = wait(lambda: L.rpc(ea, 'eth_blockNumber') == '0x1' and L.rpc(eb, 'eth_blockNumber') == '0x1', 20)
        out['bothAtBlock1'] = bool(heads)
        assert heads, out['advance']
        signed = json.loads(subprocess.run(['node', '-e', SIGN, VIEM_FROM], capture_output=True, text=True, timeout=60, check=True).stdout)
        assert signed['from'] == HARDHAT0
        sent = R.rpc_raw(ea, 'eth_sendRawTransaction', [signed['raw']])
        out['sendRawTransactionOnA'] = sent.get('result', sent.get('error'))
        h = sent.get('result')
        out['admittedOnA'] = bool(h and L.rpc(ea, 'eth_getTransactionByHash', [h]))
        seen, t_seen = wait(lambda: h and L.rpc(eb, 'eth_getTransactionByHash', [h]), 30)
        out['seenOnB'], out['seenOnBAfterSec'] = bool(seen), t_seen
        out['peersAfter'] = {'A': int(L.rpc(ea, 'net_peerCount'), 16), 'B': int(L.rpc(eb, 'net_peerCount'), 16)}
        # node-side gates of eth_sendRawTransaction (what reth enforces itself; anything else is the caller's job)
        out['probes'] = {name: (lambda r: {'accepted': 'result' in r, 'answer': str(r.get('result', r.get('error')))[:160]})(
            R.rpc_raw(ea, 'eth_sendRawTransaction', [signed[name]])) for name in ('wrongChain', 'unprotected', 'overFeeCap')}
        out['receiptOnA'] = L.rpc(ea, 'eth_getTransactionReceipt', [h]) if h else None
        out['headAfter'] = {'A': L.rpc(ea, 'eth_blockNumber'), 'B': L.rpc(eb, 'eth_blockNumber')}
    finally:
        for n, node in (('B', b), ('A', a)):
            if node:
                rc, took = node.stop()
                out[f'stop{n}'] = {'exitCode': rc, 'sec': took}
                shutil.rmtree(node.tmp, ignore_errors=True)
    return out


class TxBroadcastOffline(unittest.TestCase):
    def test_default_admits_locally_but_never_propagates_and_opt_in_propagates(self):
        reth = Path(os.environ.get('RETH_BIN', ''))
        if not reth.is_file():
            self.skipTest('RETH_BIN not set')
        scratch = os.environ['SCRATCH']
        gfile = Path(scratch) / 'test-genesis-1337.json'
        genesis(gfile)
        report = {'label': 'TEST NETWORK chainId 1337 (throwaway genesis), offline, synthetic tx signed with a PUBLIC test key; not mainnet, no inclusion'}
        try:
            report['disabled'] = off = run_pair(scratch, reth, gfile, 'disabled')
            report['localRawPropagate'] = on = run_pair(scratch, reth, gfile, 'local-raw-propagate')
        finally:
            print(json.dumps(report, indent=1, default=str))
            gfile.unlink(missing_ok=True)
        for r in (off, on):
            self.assertTrue(r['peersConnected'])
            self.assertTrue(r['admittedOnA'], 'eth_sendRawTransaction admits a pre-signed tx into the LOCAL pool in both modes')
            self.assertIsNone(r['receiptOnA'], 'nothing includes it: no block is built after the send')
            self.assertEqual(r['headAfter'], {'A': '0x1', 'B': '0x1'})
        self.assertIn('--disable-tx-gossip', off['argvA_txFlags'])
        self.assertFalse(off['seenOnB'], 'default mode: the transaction must not leave node A')
        self.assertEqual(off['peersAfter'], {'A': 1, 'B': 1}, 'the peer link stayed up during the default-mode window')
        self.assertTrue(on['seenOnB'], 'opt-in mode: standard reth gossip carries the transaction to the peer')
        for r in (off, on):
            self.assertFalse(r['probes']['wrongChain']['accepted'], 'reth refuses a transaction signed for another chain id')
            self.assertFalse(r['probes']['overFeeCap']['accepted'], 'reth refuses fees above --rpc.txfeecap (default 1 ETH)')
        # unprotected legacy: recorded, not asserted (documented as measured)


if __name__ == '__main__':
    unittest.main(verbosity=2)

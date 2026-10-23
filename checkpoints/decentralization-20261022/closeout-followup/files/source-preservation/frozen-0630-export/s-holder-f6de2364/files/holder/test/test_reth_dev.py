"""Maintained-client lifecycle check: holder.Supervisor (the same class `holder.py run` uses) supervising the REAL
upstream reth v2.8.0 binary in --dev mode (an Ethereum dev chain, chain id 1337). This is a STAND-IN for `base rpc`:
it proves the supervision against a real reth process (startup, loopback JSON-RPC readiness, SIGTERM shutdown, port
release, no leftover process). It proves nothing about Base flags or Base sync. Run inside `unshare -rn`."""
import hashlib, importlib.util, json, os, shutil, signal, socket, tempfile, threading, time, unittest
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('holder', HERE.parent / 'holder.py')
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
RETH = Path(os.environ.get('RETH_BIN', ''))


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


class RethDev(unittest.TestCase):
    def test_supervised_reth_dev_start_ready_stop(self):
        if not RETH.is_file():
            self.skipTest('RETH_BIN not set')
        tmp = Path(tempfile.mkdtemp(prefix='hrd-'))
        try:
            http, p2p, auth = free_port(), free_port(), free_port()
            argv = [str(RETH), 'node', '--dev', '--datadir', str(tmp / 'data'), '--http', '--http.addr', '127.0.0.1',
                    '--http.port', str(http), '--http.api', 'eth,net,web3', '--ipcdisable', '--disable-discovery',
                    '--port', str(p2p), '--authrpc.addr', '127.0.0.1', '--authrpc.port', str(auth)]
            env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(tmp)}
            events = []
            sup = H.Supervisor(argv, env, http, '0x539', stop_timeout=60, ready_timeout=120, nofile=65536, log=events.append)
            box = {}
            t = threading.Thread(target=lambda: box.setdefault('rc', sup.run())); t.start()
            end = time.monotonic() + 120
            while time.monotonic() < end and not sup.ready and t.is_alive():
                time.sleep(0.2)
            self.assertTrue(sup.ready, events)
            pid = sup.proc.pid
            self.assertEqual(H.rpc_call(http, 'eth_chainId'), '0x539')
            self.assertTrue(H.port_in_use(http, 'tcp'))
            t0 = time.monotonic(); sup.stop(); t.join(90)
            took = round(time.monotonic() - t0, 2)
            self.assertFalse(t.is_alive())
            self.assertEqual(box['rc'], 0, events)
            self.assertFalse(H.port_in_use(http, 'tcp'), 'RPC port released')
            self.assertFalse(os.path.exists(f'/proc/{pid}'), 'no leftover reth process')
            print(json.dumps({'rethSha256': hashlib.sha256(RETH.read_bytes()).hexdigest(), 'stopSeconds': took,
                              'events': [json.loads(e)['event'] for e in events]}))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)

"""The OFFICIAL base v1.5.1 binary (BINARY.json pin) under the REAL launcher (`holder.py run`), in a network-denied
namespace (loopback only), with an EMPTY temporary datadir and L1 URLs pointing at closed loopback ports.

What it proves: the actual binary accepts the rendered argv and environment; which sockets it opens and on which
addresses; whether the execution RPC answers chain 0x2105 before L1 is needed; and how startup behaves when L1 is
unreachable (exit code and log lines), as seen through the supervisor.
What it does NOT prove: sync, state, proofs, P2P or L1-up behaviour (there is no network and no snapshot). The datadir
only receives what the binary itself initializes (genesis/config) and is removed afterwards.
Requires $BASE_BIN (the staged official binary)."""
import hashlib, importlib.util, json, os, re, shutil, signal, socket, subprocess, sys, tempfile, time, unittest
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('holder', HERE.parent / 'holder.py')
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
BIN = Path(os.environ.get('BASE_BIN', ''))
EXAMPLE = json.loads((HERE.parent / 'holder.example.json').read_text())


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def listeners():
    out = set()
    for f, fam in (('/proc/net/tcp', 4), ('/proc/net/tcp6', 6)):
        try:
            with open(f) as fh:
                rows = fh.read().splitlines()[1:]
        except OSError:
            continue
        for r in rows:
            p = r.split()
            if p[3] != '0A':
                continue
            a, port = p[1].rsplit(':', 1)
            if fam == 4:
                ip = '.'.join(str(int(a[i:i + 2], 16)) for i in (6, 4, 2, 0))
            else:
                ip = 'v6:' + a
            out.add((ip, int(port, 16)))
    return out


class OfficialBinaryOffline(unittest.TestCase):
    def test_rendered_argv_on_the_official_binary_without_l1(self):
        if not BIN.is_file():
            self.skipTest('BASE_BIN not set')
        self.assertEqual(hashlib.sha256(BIN.read_bytes()).hexdigest(), H.BINARY['binary']['sha256'])
        tmp = Path(tempfile.mkdtemp(prefix='hbo-'))
        try:
            (tmp / 'mnt' / 'data').mkdir(parents=True); (tmp / 'mnt' / 'tmp').mkdir()
            os.chmod(tmp / 'mnt' / 'data', 0o700)
            (tmp / 'run').mkdir()
            c = json.loads(json.dumps(EXAMPLE))
            c['binary']['path'] = str(BIN)
            dead1, dead2 = free_port(), free_port()
            c['l1'] = {'executionRpc': f'http://127.0.0.1:{dead1}/', 'beacon': f'http://127.0.0.1:{dead2}/', 'trustRpc': False}
            c['datadir'] = str(tmp / 'mnt' / 'data')
            c['storage'].update(mountPoint=str(tmp / 'mnt'), cache={'mechanism': 'none'})
            c['storage'].pop('nvmeBudget', None)
            c['rpc']['port'] = free_port(); c['consensusRpc']['port'] = free_port()
            for k in ('executionPort', 'discoveryV5Port', 'consensusTcpPort', 'consensusUdpPort'):
                c['p2p'][k] = free_port()
            c['limits'].update(readyTimeoutSec=120, stopTimeoutSec=60)
            v = H.validate(c)
            self.assertTrue(v['l1']['selfHosted'])
            cfg = tmp / 'holder.json'; cfg.write_text(json.dumps(c))
            before = listeners()
            t0 = time.monotonic()
            logf = open(tmp / 'out.log', 'w')
            p = subprocess.Popen([sys.executable, '-I', str(HERE.parent / 'holder.py'), 'run', str(cfg)],
                                 env={'PATH': '/usr/bin:/bin', 'RUNTIME_DIRECTORY': str(tmp / 'run')},
                                 stdout=logf, stderr=subprocess.STDOUT)
            seen, ready_at, chain = set(), None, None
            while p.poll() is None and time.monotonic() - t0 < 240:
                seen |= listeners() - before
                if ready_at is None:
                    try:
                        chain = H.rpc_call(v['rpc']['port'], 'eth_chainId', timeout=1)
                        if chain:
                            ready_at = round(time.monotonic() - t0, 1)
                    except (OSError, ValueError, Exception):
                        pass
                time.sleep(0.25)
            still_running = p.poll() is None
            if still_running:
                p.send_signal(signal.SIGTERM)
            rc = p.wait(120)
            logf.close()
            took = round(time.monotonic() - t0, 1)
            log = (tmp / 'out.log').read_text(errors='replace')
            l1_lines = [l[:300] for l in log.splitlines() if re.search(r'l1|L1|signer|upgrade', l)][:25]
            rpc, crpc = v['rpc']['port'], v['consensusRpc']['port']
            p2p_tcp = {v['p2p']['executionPort'], v['p2p']['consensusTcpPort']}
            report = {'binarySha256': H.BINARY['binary']['sha256'], 'exitCode': rc, 'ranSeconds': took,
                      'stoppedByTestAfter240s': still_running, 'executionRpcChainId': chain, 'executionRpcAnsweredAfterSec': ready_at,
                      'listeners': sorted(f'{ip}:{port}' for ip, port in seen), 'l1LogLines': l1_lines,
                      'datadirApparentBytes': sum(f.stat().st_size for f in (tmp / 'mnt').rglob('*') if f.is_file()),
                      'datadirAllocatedBytes': sum(f.stat().st_blocks * 512 for f in (tmp / 'mnt').rglob('*') if f.is_file()),
                      'datadirFiles': sorted(str(f.relative_to(tmp / 'mnt')) for f in (tmp / 'mnt').rglob('*') if f.is_file())[:40],
                      'wildcardPorts': {k: v['p2p'][k] for k in ('executionPort', 'consensusTcpPort') if ('0.0.0.0', v['p2p'][k]) in seen},
                      'publicIpcSocket': os.path.exists('/tmp/reth.ipc')}
            # the reth.toml the binary itself wrote into the empty datadir must NOT pass the download-profile preflight
            toml = tmp / 'mnt' / 'data' / 'reth.toml'
            report['nodeWroteRethToml'] = toml.is_file()
            report['l2JwtInDatadir'] = (tmp / 'mnt' / 'data' / 'l2_jwt.hex').is_file()
            if toml.is_file():
                try:
                    H.check_reth_toml(v)
                    report['defaultRethTomlRefused'] = False
                except H.Refused as e:
                    report['defaultRethTomlRefused'] = str(e)
                txt = toml.read_text()
                report['rethTomlPrune'] = txt[txt.find('[prune'):][:400] if '[prune' in txt else None
                report['rethTomlStaticFiles'] = txt[txt.find('[static_files'):][:300] if '[static_files' in txt else None
            print(json.dumps(report, indent=1))
            (HERE.parent.parent / 'evidence').mkdir(exist_ok=True)
            # every listener on a wildcard address must be a configured P2P port; the RPCs only on 127.0.0.1
            for ip, port in seen:
                if ip in ('0.0.0.0', 'v6:' + '0' * 32):
                    self.assertIn(port, p2p_tcp, f'wildcard listener {ip}:{port} is not a configured P2P port')
            self.assertNotIn(('0.0.0.0', rpc), seen)
            self.assertNotIn(('0.0.0.0', crpc), seen)
            if ready_at is not None:
                self.assertEqual(chain, '0x2105')
                self.assertIn(('127.0.0.1', rpc), seen)
            self.assertFalse(report['publicIpcSocket'], '--ipcdisable: no public IPC socket')
            self.assertFalse((HERE.parent / 'l2_jwt.hex').exists() or (HERE.parent.parent / 'l2_jwt.hex').exists(), 'no engine secret outside the datadir')
            self.assertTrue(report['l2JwtInDatadir'], 'the consensus engine secret is written inside the datadir (child cwd)')
            self.assertNotEqual(rc, 0, 'without L1 the node must not report a clean run')
            if report['nodeWroteRethToml']:
                self.assertTrue(report['defaultRethTomlRefused'], 'a node-written default reth.toml is not a snapshot profile')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)

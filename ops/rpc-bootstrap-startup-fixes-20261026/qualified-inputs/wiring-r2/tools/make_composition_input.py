#!/usr/bin/env python3
"""production-bootstrap-wiring-stage/r2: writes COMPOSITION-INPUT.json (format enclave-r13-wiring-input/v1, r13-compose v3 load_wiring) from
the overlay BYTES. It holds NO qualification, receipt hash or SHA256SUMS of this stage: root's qualification is EXTERNAL
(--wiring-qualification, enclave-r13-input-qualification/v1), produced after the freeze. Run before writing SHA256SUMS."""
import hashlib, json, pathlib, sys

S = pathlib.Path(__file__).resolve().parents[1]; P = S.parents[1]; R12F = P / 'base-finality-proof-stage/r12-final'
R12F_SUMS = '9de0d8d7664516fac691f6cd8dc1d984c00e79ba175c406b6cda9ec97037bd7e'
O = P.parents[1] / 'outputs/rpc-production-final-20261025'
h = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
REPLACE = ['harness-first/a2a4.py', 'producer/base_launch.py', 'src/reproof.py', 'units/enclave-base-finality-reproof.service',
           'install/install_verified.py', 'tests/r7-ported/test_r3_launcher.py']
ADD = ['bootstrap/holder_gate.py', 'bootstrap/release_install.py', 'bootstrap/a1_capture_original.py',
       'units/enclave-base-holder.service.d/60-release-mode.conf', 'tests/r7-ported/test_bootstrap_wiring.py']
CHANGING = ['capture/a1_capture.py', 'harness/a2a4.py', 'harness-first/a2a4.py', 'src/finality_state.py', 'producer/base_launch.py',
            'recovery/forward_sync.py', 'src/reproof.py', 'wrapper/chain_service.py']
READERS = {'READER:a1-read.mjs': 'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8',
           'READER:a1-recheck-read.mjs': '41b83975e96fc816bd5743e56626dd309aa7f0ee03c6efb9912788eb184a7715'}
BUNDLE = {'bundle/bootstrap/a1-initial-evidence.json': (O / 'l1-a1-live-1958/a1-evidence.json', 'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c', '0644'),
          'bundle/bootstrap/base-bytecode-check': (P / 'finality-stage/bytecode-v2-recovery/build/target/release/base-bytecode-check',
                                                   'b55e6b78c6ac8e0a672f69e238135eca7466d1081479cd0868204cee9a1654d7', '0755')}


def main():
    sums = (R12F / 'SHA256SUMS').read_bytes()
    assert hashlib.sha256(sums).hexdigest() == R12F_SUMS, 'r12-final changed'
    node_sha = {n: (h(S / 'overlay' / n) if n in REPLACE else h(R12F / n)) for n in CHANGING}
    node_sha.update(READERS)
    files, edges = [], {}
    for rel in REPLACE + ADD:
        src = S / 'overlay' / rel; b = src.read_bytes(); e = {'path': rel, 'src': f'overlay/{rel}', 'sha256': h(src)}
        if rel in REPLACE:
            e.update(action='replace', baseSha256=h(R12F / rel))
        else:
            assert not (R12F / rel).exists(), rel; e['action'] = 'add'
        files.append(e)
        edges[rel] = {n: b.count(s.encode()) for n, s in node_sha.items() if n != rel and b.count(s.encode())}
        for r in REPLACE:                                       # composer rule: no shipped file names a replaced file's BASE sha
            assert h(R12F / r).encode() not in b, f'stale pin: {rel} names the r12-final sha of {r}'
    bo = json.loads((R12F / 'bundle-origin.json').read_text())['entries']
    add_bo = {}
    for k, (origin, want, _m) in BUNDLE.items():
        assert h(origin) == want, k
        add_bo[k] = {'origin': str(origin), 'sha256': want}
    assert all(k not in bo for k in add_bo)
    man = [{'dest': f'/opt/enclave-rpc/{r}', 'src': r, 'mode': '0755', 'sha256': h(S / 'overlay' / r)}
           for r in ('bootstrap/holder_gate.py', 'bootstrap/release_install.py', 'bootstrap/a1_capture_original.py')]
    man.append({'dest': '/etc/systemd/system/enclave-base-holder.service.d/60-release-mode.conf', 'src': 'units/enclave-base-holder.service.d/60-release-mode.conf',
                'mode': '0644', 'unit': True, 'sha256': h(S / 'overlay/units/enclave-base-holder.service.d/60-release-mode.conf')})
    man += [{'dest': '/opt/enclave-rpc/bootstrap/' + k.rsplit('/', 1)[1], 'src': k, 'mode': m, 'sha256': s} for k, (_o, s, m) in BUNDLE.items()]
    env = {'PINNED_FAKE_BASE': '{FAKE}', 'PRODUCER_WORK': '{WK}', 'CAPTURE_MODULE': '{SC}/capture/a1_capture.py', 'FINALITY_NODE': '{NODE}',
           'WIRING_OVERLAY': '{SC}', 'R12_UNITS': '{SC}/units'}
    suites = [{'name': 'bootstrap-wiring', 'where': 'recovery', 'kind': 'unittest', 'ran': 22, 'timeout': 3600, 'env': env,
               'argv': ['/usr/bin/python3', '-E', '-s', '-B', '-u', 'tests/test_bootstrap_wiring.py']},
              {'name': 'r3-regression', 'where': 'recovery', 'kind': 'unittest', 'ran': 28, 'timeout': 3600,
               'env': {k: env[k] for k in ('PINNED_FAKE_BASE', 'PRODUCER_WORK', 'CAPTURE_MODULE')},
               'argv': ['/usr/bin/python3', '-E', '-s', '-B', '-u', 'tests/test_r3_launcher.py']}]
    doc = {'format': 'enclave-r13-wiring-input/v1', 'base': {'stage': 'base-finality-proof-stage/r12-final', 'sha256sums': R12F_SUMS},
           'files': files, 'pinEdges': edges, 'manifest': {'add': man}, 'bundleOrigin': {'add': add_bo}, 'suites': suites,
           'notes': {'installerFlag': {'A1_FIRST_CAPTURE_REVIEWED': '/opt/enclave-rpc/a2a4/a2a4.py'},
                     'notInManifest': {'release 4a7c013a': '/srv/m10-guest-validation/release/run-1/out/base (guest-built; release_install.py places it)',
                                       'harness/downloader 9c44836d': '/opt/enclave-rpc/bin/base (already installed; never written)'},
                     'wrapper': 'NOT in this input: wrapper-pruned-identity-stage 6a4d7aa5 is its own root-qualified composer input (--wrapper); '
                                'producer/base_launch.py here keeps the r12-final wrapper pin 4fc3b970 for the composer to re-pin',
                     'qualification': 'EXTERNAL only (--wiring-qualification after the freeze); nothing here is self-derived'}}
    (S / 'COMPOSITION-INPUT.json').write_text(json.dumps(doc, indent=1, sort_keys=True) + '\n')
    print(json.dumps({'files': len(files), 'pinEdges': {k: v for k, v in edges.items() if v}}, indent=1))


if __name__ == '__main__':
    sys.exit(main())

"""Prepared only. Requires a separately reviewed frozen-input.json and lane grant."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import sys
import time

P = Path(__file__).resolve().parent
SOLC = Path('/home/steven/.local/share/svm/0.8.35/solc-0.8.35')
FORGE = '/home/steven/.foundry/bin/forge'
EXPECTED_ROW = [
    ('endpoint', 'string'), ('repo', 'string'), ('measurement', 'bytes32'),
    ('operator', 'address'), ('registeredAt', 'uint64'), ('lastSeen', 'uint64'),
    ('active', 'bool'), ('cpuPricePerSec6', 'uint64'), ('gpuPricePerSec6', 'uint64'),
    ('proofKey', 'address'), ('payoutWallet', 'address'), ('caps', 'uint64'),
    ('region', 'string'),
]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    if sys.argv[1:] != ['--validate']:
        raise SystemExit('Only --validate is supported; separate lane grant required')
    os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})
    frozen = json.loads((P / 'frozen-input.json').read_text())
    if frozen.get('qualification') != 'reviewed-source-only-host-registry-r1':
        raise SystemExit('Reviewed frozen source manifest required')
    inputs = frozen['sourceHashes']
    if str(SOLC) not in inputs or str(P / 'validate.py') not in inputs:
        raise SystemExit('Compiler and runner must be pinned')
    if any(digest(path) != expected for path, expected in inputs.items()):
        raise SystemExit('Reviewed input drift; nothing compiled')
    delivered = {str(f.resolve()) for f in (P / 'candidate').rglob('*.sol')}
    if not delivered or not delivered.issubset(inputs):
        raise SystemExit('Unmanifested source; nothing compiled')
    config = P / 'validation' / 'foundry.toml'
    if str(config) not in inputs:
        raise SystemExit('Sanitised validation config must be pinned')
    out = P / 'validation-result'
    out.mkdir(exist_ok=False)
    report = {
        'qualification': 'local actual contract build/tests only; not deployed or production integrated',
        'sourceHashes': inputs, 'startedAt': time.time(), 'commands': [],
        'compileExitCode': None, 'testExitCode': None, 'sizes': [],
    }
    env = {k: os.environ[k] for k in ['PATH', 'HOME', 'USER', 'LANG', 'TZ', 'TMPDIR'] if k in os.environ}
    env.update(FOUNDRY_FFI='false', FOUNDRY_OFFLINE='true', FOUNDRY_PROFILE='default',
               FOUNDRY_OUT=str(out / 'artifacts'), FOUNDRY_CACHE_PATH=str(out / 'cache'))
    base = ['--root', str(P / 'validation'), '--use', str(SOLC), '--offline', '--threads', '1']

    def run(command, log, timeout):
        report['commands'].append(command)
        with (out / log).open('w') as stream:
            return subprocess.run(command, cwd=P / 'validation', env=env,
                                  stdout=stream, stderr=subprocess.STDOUT, timeout=timeout).returncode

    try:
        report['compileExitCode'] = run([FORGE, 'build', *base, '--skip', 'test', '--sizes'], 'compile.log', 300)
        if report['compileExitCode']:
            raise RuntimeError('Compile failed; tests not started')
        primary = None
        for artifact in sorted((out / 'artifacts').rglob('*.json')):
            a = json.loads(artifact.read_text())
            if 'deployedBytecode' not in a:
                continue
            runtime = a['deployedBytecode'].get('object', '').removeprefix('0x')
            init = a.get('bytecode', {}).get('object', '').removeprefix('0x')
            if len(runtime) % 2 or len(init) % 2:
                raise RuntimeError('Unexpected bytecode length')
            unresolved = bool(a['deployedBytecode'].get('linkReferences') or a.get('bytecode', {}).get('linkReferences'))
            item = {'artifact': str(artifact), 'runtimeBytes': len(runtime) // 2,
                    'initBytes': len(init) // 2, 'unresolvedLinks': unresolved}
            report['sizes'].append(item)
            if item['runtimeBytes'] > 24576 or item['initBytes'] > 49152:
                raise RuntimeError('Normal EIP170/EIP3860 limit exceeded; tests not started')
            if artifact.name == 'EnclaveHostLifecycleRegistry.json':
                primary = a
        if primary is None:
            raise RuntimeError('Registry compiler artifact missing')
        for name, output_type in [('get', 'tuple'), ('getPage', 'tuple[]')]:
            entries = [a for a in primary['abi'] if a.get('type') == 'function' and a.get('name') == name]
            if len(entries) != 1 or len(entries[0]['outputs']) != 1:
                raise RuntimeError('Missing or ambiguous registry getter: ' + name)
            output = entries[0]['outputs'][0]
            if output['type'] != output_type or [(x['name'], x['type']) for x in output['components']] != EXPECTED_ROW:
                raise RuntimeError('Legacy registry row ABI mismatch: ' + name)
        report['rowAbiMatches'] = True
        (out / 'registry-abi.json').write_text(json.dumps(primary['abi'], indent=2) + '\n')
        (out / 'registry-storage.json').write_text(json.dumps(primary.get('storageLayout'), indent=2) + '\n')
        report['testExitCode'] = run([FORGE, 'test', *base, '-vv'], 'tests.log', 480)
        if report['testExitCode']:
            raise RuntimeError('Actual contract tests failed')
        log = (out / 'tests.log').read_text()
        suites = re.findall(r'Suite result:.*?([0-9]+) passed; ([0-9]+) failed; ([0-9]+) skipped', log)
        if not suites:
            raise RuntimeError('No completed actual test suites found')
        totals = [sum(int(s[i]) for s in suites) for i in range(3)]
        report['tests'] = dict(zip(['passed', 'failed', 'skipped'], totals))
        if totals[0] == 0 or totals[1] or totals[2]:
            raise RuntimeError('No tests, failed tests or skipped tests; qualification incomplete')
        report['exitCode'] = 0
    except Exception as error:
        report['exitCode'] = 1
        report['error'] = str(error)
    finally:
        report['finishedAt'] = time.time()
        report['sourcesUnchanged'] = all(Path(path).exists() and digest(path) == expected for path, expected in inputs.items())
        if not report['sourcesUnchanged']:
            report['exitCode'] = 1
        (out / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({k: report.get(k) for k in ['exitCode', 'error', 'compileExitCode', 'testExitCode', 'tests', 'sourcesUnchanged']}), flush=True)
    return report['exitCode']


if __name__ == '__main__':
    raise SystemExit(main())

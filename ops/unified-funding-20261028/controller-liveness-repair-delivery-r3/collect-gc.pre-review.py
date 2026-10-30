"""Root-owned read-only terminal collection; no signal, test or activation."""
import difflib, json, os, re, subprocess
from pathlib import Path
from common import P, read, write, require, sha, verify_rows, inventory, process

def unit(name):
    properties = ['Id', 'LoadState', 'ActiveState', 'SubState', 'Result', 'MainPID',
                  'InvocationID', 'ExecMainCode', 'ExecMainStatus', 'ControlGroup']
    r = subprocess.run(['/usr/bin/systemctl', '--user', 'show', name,
                        *['--property=' + k for k in properties]],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    require(r.returncode in (0, 4), 'unit-collection-failed')
    result = dict(line.split('=', 1) for line in r.stdout.splitlines() if '=' in line)
    require(result.get('LoadState') is not None, 'unit-metadata-missing')
    return result

def main():
    os.umask(0o077)
    plan = read('PLAN.json'); result = read('RESULT.json'); attempt = read('ATTEMPT.json')
    verify_rows('SOURCE-PINS.json'); verify_rows('TOOL-PINS.json')
    for name, h in read('DELIVERY-PINS.json').items():
        require(sha(P / name) == h, 'prepared-input-drift')
    name = attempt['scope']
    require(re.fullmatch(r'0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-[A-Za-z0-9-]+\.scope', name),
            'unexpected-recorded-scope')
    outer = unit(plan['unit']); inner = unit(name.rsplit('/', 1)[-1])
    identities = read('ROOT-IDENTITIES.json')
    terminal_evidence = 'live-unit-invocation'
    if outer.get('LoadState') == 'not-found':
        require(outer.get('ActiveState') == 'inactive' and outer.get('SubState') == 'dead'
                and outer.get('MainPID') == '0', 'collected-outer-not-terminal')
        # Collected successful transient units lose InvocationID. Verify exact journal invocation + original queue PID.
        jr = subprocess.run(['/usr/bin/journalctl', '--user', '_SYSTEMD_INVOCATION_ID=' + identities['invocation'],
                             '-n', '20', '--no-pager', '-o', 'json'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        require(jr.returncode == 0 and len(jr.stdout) <= 1048576, 'terminal-journal-read')
        entries = [json.loads(line) for line in jr.stdout.splitlines() if line]
        done = [e for e in entries if e.get('_SYSTEMD_INVOCATION_ID') == identities['invocation']
                and str(e.get('_PID')) == str(identities['processes'][0]['pid'])
                and e.get('MESSAGE') == '[queue] EXIT 0']
        require(len(done) == 1, 'exact-invocation-terminal-missing')
        require(result.get('rc') == 0 and result.get('cleanupComplete') is True
                and result.get('inputsUnchanged') is True and result.get('noOom') is True,
                'collected-runner-not-successful')
        for log in ('inner.guard.log', 'outer.guard.log'):
            require(re.fullmatch(r'\[memory-guard\] exit=0 peakTreeRssMiB=\d+ minHostAvailableMiB=\d+\n?',
                                 (P / log).read_text()) is not None, 'guard-not-successful')
        terminal_evidence = {'kind': 'systemd-collected-exact-invocation-journal',
                             'invocation': identities['invocation'], 'queuePid': identities['processes'][0]['pid'],
                             'cursor': done[0].get('__CURSOR'), 'message': done[0]['MESSAGE']}
    else:
        require(outer.get('InvocationID') == identities['invocation'], 'outer-invocation-drift')
    for old in identities['processes']:
        current = process(old['pid'])
        require(current is None or current['startTime'] != old['startTime'], 'recorded-process-still-alive')
    require(outer.get('ActiveState') in ('inactive', 'failed') and outer.get('MainPID') == '0', 'outer-not-terminal')
    require(inner.get('ActiveState') in ('inactive', 'failed'), 'inner-not-terminal')
    cg = Path('/sys/fs/cgroup' + name[3:])
    remaining = []
    if cg.exists():
        for f in [cg / 'cgroup.procs', *cg.rglob('*/cgroup.procs')]:
            if f.exists():
                remaining += [int(x) for x in f.read_text().split()]
    require(not remaining, 'scope-has-leftovers')
    if (P / 'PROCESS.json').exists():
        old = read('PROCESS.json'); current = process(old['pid'])
        require(current is None or current['startTime'] != old['startTime'], 'author-process-still-alive')
    final = inventory(P / 'candidate'); baseline = read('SEED-PINS.json')
    require(inventory(P / 'baseline') == baseline, 'baseline-drift')
    require(final == read('CANDIDATE-PINS.json'), 'candidate-after-delivery-drift')
    changed = [n for n in sorted(set(baseline) | set(final)) if baseline.get(n) != final.get(n)]
    patch = []
    for n in changed:
        a = (P / 'baseline' / n).read_text().splitlines(keepends=True) if n in baseline else []
        b = (P / 'candidate' / n).read_text().splitlines(keepends=True) if n in final else []
        patch.extend(difflib.unified_diff(a, b, fromfile='a/' + n, tofile='b/' + n))
    with (P / 'SOURCE.patch').open('x') as f:
        os.fchmod(f.fileno(), 0o600); f.writelines(patch)
    collected = {'status': 'COLLECTED-SOURCE-ONLY', 'outerUnit': outer, 'innerScope': inner,
                 'remainingPids': remaining, 'terminalEvidence': terminal_evidence, 'runnerStatus': result['status'], 'changedFiles': changed,
                 'sourcePatchSha256': sha(P / 'SOURCE.patch'), 'candidatePinsSha256': sha(P / 'CANDIDATE-PINS.json'),
                 'testsRun': False, 'coldControllerRecoveryQualified': False, 'productionReady': False,
                 'eligibleForRootSourceReview': result['status'] == 'SOURCE-DELIVERED-UNQUALIFIED'
                     and outer.get('Result') == 'success' and outer.get('ExecMainStatus') == '0'}
    write('COLLECTED.json', collected); print(json.dumps(collected, sort_keys=True))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'status': 'COLLECTION-INCOMPLETE', 'reason': str(e) if type(e) is RuntimeError else type(e).__name__}))
        raise SystemExit(2)

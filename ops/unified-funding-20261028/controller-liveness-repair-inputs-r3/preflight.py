"""ROOT-OWNED account/source preflight only. Prepared, not executed."""
import json, os, subprocess, time
from common import P, read, require, sha, verify_initial, account_check, write, tmp_parent

def main():
    os.umask(0o077)
    require(os.geteuid() == 1000 and os.sched_getaffinity(0) == {1}, 'uid-affinity')
    verify_initial()
    plan = read('PLAN.json')
    tmp_parent(plan)
    require(not (P / 'ATTEMPT.json').exists(), 'attempt-already-exists')
    u = subprocess.run(['/usr/bin/systemctl', '--user', 'show', plan['unit'], '--property=LoadState', '--value'],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
    require(u.stdout.strip() == 'not-found', 'author-unit-already-exists')
    account = account_check(plan)
    result = {'status': 'PREFLIGHT-ONLY', 'at': time.time(), 'account': account,
              'deliverySha256': sha(P / 'DELIVERY-PINS.json'), 'authorStarted': False}
    write('ROOT-PREFLIGHT.json', result)
    print(json.dumps(result, sort_keys=True))

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(json.dumps({'status': 'REFUSED', 'reason': str(e) if type(e) is RuntimeError else type(e).__name__}))
        raise SystemExit(2)

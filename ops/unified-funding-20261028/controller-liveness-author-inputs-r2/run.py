"""One root-admitted SOURCEONLY Claude author. Prepared, not executed."""
import json, os, resource, selectors, signal, subprocess, time
from pathlib import Path
from common import (P, read, write, require, sha, verify_initial, verify_rows, account_check,
                    author_env, process, available, scope, members, tmp_parent, inventory)

def main():
    os.umask(0o077)
    require(os.geteuid() == 1000 and os.sched_getaffinity(0) == {1}, 'uid-affinity')
    verify_initial()
    plan = read('PLAN.json')
    pre = read('ROOT-PREFLIGHT.json'); admission = read('ROOT-ADMISSION.json')
    now = time.time()
    require(pre['status'] == 'PREFLIGHT-ONLY' and pre['account'] == plan['requiredAccount'] and
            pre['deliverySha256'] == sha(P / 'DELIVERY-PINS.json') and
            0 <= now - pre['at'] <= plan['rootAdmissionMaxAgeSeconds'], 'stale-root-preflight')
    require(admission == {'authorized': True, 'scope': 'source-only-controller-liveness-author',
                         'deliverySha256': sha(P / 'DELIVERY-PINS.json'),
                         'rootPreflightSha256': sha(P / 'ROOT-PREFLIGHT.json')}, 'root-admission')
    cg_name, cg = scope()
    require((cg / 'memory.max').read_text().strip() == str(plan['memoryMiB'] << 20), 'scope-memory-cap')
    require((cg / 'memory.swap.max').read_text().strip() == '0', 'scope-swap-cap')
    require(available() >= ((plan['floorMiB'] + plan['memoryMiB']) << 20), 'initial-host-floor')
    baseline = members(cg)
    before_events = (cg / 'memory.events').read_text()
    parent = tmp_parent(plan); tmp = parent / plan['tmpDirectory']
    require(not tmp.exists(), 'tmp-already-exists')
    write('ATTEMPT.json', {'at': now, 'scope': cg_name, 'baselinePids': sorted(baseline),
                          'unit': plan['unit'], 'deliverySha256': sha(P / 'DELIVERY-PINS.json')})
    tmp.mkdir(mode=0o700)
    write('TEMP.json', {'path': str(tmp), 'device': tmp.stat().st_dev, 'inode': tmp.stat().st_ino})
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 << 20, 32 << 20))
    owned = {}; child = None; rc = None; error = None; cleanup = False
    auth = None; output_size = 0; begin = time.monotonic(); peak_work = 0
    sel = selectors.DefaultSelector()
    out = None

    def discover():
        for pid in members(cg) - baseline:
            a = process(pid)
            if a is None:
                continue
            require(a['cgroup'] == cg_name, 'child-scope')
            require(os.sched_getaffinity(pid) == {1}, 'child-affinity')
            if pid in owned:
                require(owned[pid][0] == a['startTime'], 'child-pid-reuse')
                continue
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            b = process(pid)
            if b is None or b['startTime'] != a['startTime'] or b['cgroup'] != cg_name:
                os.close(fd); raise RuntimeError('child-identity-race')
            owned[pid] = (a['startTime'], fd)

    def terminate(sig):
        discover()
        for _, fd in owned.values():
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass

    def interrupted(_sig, _frame):
        raise RuntimeError('interrupted')

    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    try:
        auth = account_check(plan)  # independent of root's earlier invocation
        write('ACCOUNT-VERIFICATION.json', {'at': time.time(), 'account': auth})
        verify_initial()
        prompt = (P / 'TASK.txt').read_text()
        args = [plan['claudeExecutable'], '-p', prompt, '--safe-mode', '--strict-mcp-config',
                '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk',
                '--allowedTools', 'Read,Grep,Glob,Edit,Write', '--tools', 'Read,Grep,Glob,Edit,Write',
                '--max-turns', str(plan['maxTurns']), '--output-format', 'json']
        out = (P / 'claude.out').open('xb', buffering=0)
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, cwd=P, env=author_env(tmp), start_new_session=True)
        a = process(child.pid)
        require(a is not None, 'author-exited-before-identification')
        write('PROCESS.json', {**a, 'scope': cg_name, 'at': time.time(), 'sourceOnly': True})
        os.set_blocking(child.stdout.fileno(), False)
        sel.register(child.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + plan['childTimeoutSeconds']
        last_size = 0.0
        while True:
            discover()
            require(time.monotonic() <= deadline, 'author-deadline')
            require(available() >= (plan['floorMiB'] << 20), 'host-floor')
            if time.monotonic() - last_size >= 1:
                used = 0; count = 0
                for root in (P / 'candidate', tmp):
                    for here, dirs, files in os.walk(root, followlinks=False):
                        for name in dirs + files:
                            f = Path(here) / name
                            require(not f.is_symlink(), 'work-symlink')
                        for name in files:
                            try:
                                s = (Path(here) / name).stat()
                            except FileNotFoundError:
                                continue
                            count += 1; used += max(s.st_size, s.st_blocks * 512)
                peak_work = max(peak_work, used)
                require(count <= 2000 and used <= plan['maxWorkBytes'], 'work-cap')
                require(os.statvfs(parent).f_bavail * os.statvfs(parent).f_frsize >= (300 << 30), 'storage-floor')
                last_size = time.monotonic()
            for key, _ in sel.select(timeout=0.2):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    sel.unregister(key.fileobj); key.fileobj.close(); continue
                output_size += len(data)
                require(output_size <= plan['maxOutputBytes'], 'output-cap')
                out.write(data)
            rc = child.poll()
            if rc is not None and not sel.get_map():
                break
        require(rc == 0, 'author-exit')
    except Exception as e:
        error = str(e) if type(e) is RuntimeError else type(e).__name__
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.signal(signal.SIGINT, signal.SIG_IGN)
        try:
            terminate(signal.SIGTERM)
            end = time.monotonic() + 5
            while members(cg) - baseline and time.monotonic() < end:
                if child:
                    child.poll()
                discover(); time.sleep(0.1)
            if members(cg) - baseline:
                terminate(signal.SIGKILL)
            if child:
                child.wait(timeout=5)
            end = time.monotonic() + 5
            while members(cg) - baseline and time.monotonic() < end:
                time.sleep(0.1)
            cleanup = not (members(cg) - baseline)
        except Exception:
            error = error or 'cleanup-failed'
        sel.close()
        if out:
            out.close()
        for _, fd in owned.values():
            os.close(fd)
    inputs_unchanged = False; changes = []; candidate_ok = False; author_ok = False
    try:
        verify_rows('SOURCE-PINS.json'); verify_rows('TOOL-PINS.json')
        for name, h in read('DELIVERY-PINS.json').items():
            require(sha(P / name) == h, 'prepared-input-mutated')
        inputs_unchanged = True
        initial = read('SEED-PINS.json'); final = inventory(P / 'candidate')
        require(set(initial) <= set(final), 'seed-file-removed')
        changes = [n for n in final if final[n] != initial.get(n)]
        require('supervisor.js' in changes and any(n.startswith('test/') for n in changes), 'missing-fix-or-regressions')
        require(all(n == 'supervisor.js' or n == 'AUTHOR-NOTES.md' or
                    n.startswith('test/') and n.endswith('.mjs') for n in changes), 'out-of-scope-author-edit')
        candidate_ok = True
        write('CANDIDATE-PINS.json', final)
        response = json.loads((P / 'claude.out').read_text())
        author_ok = isinstance(response, dict) and response.get('type') == 'result' and response.get('is_error') is False
    except Exception as e:
        error = error or (str(e) if type(e) is RuntimeError else type(e).__name__)
    def event_counts(text):
        return {k: int(v) for k, v in (line.split() for line in text.splitlines())}
    before = event_counts(before_events); after = event_counts((cg / 'memory.events').read_text())
    no_oom = all(before.get(k, 0) == after.get(k, 0) for k in ('oom', 'oom_kill', 'oom_group_kill'))
    ok = rc == 0 and error is None and cleanup and inputs_unchanged and candidate_ok and author_ok and no_oom
    result = {'status': 'SOURCE-DELIVERED-UNQUALIFIED' if ok else 'FAILED', 'rc': rc, 'error': error,
              'cleanupComplete': cleanup, 'inputsUnchanged': inputs_unchanged, 'candidateScopeValid': candidate_ok,
              'authorResultValid': author_ok, 'noOom': no_oom, 'changedFiles': changes,
              'peakWorkBytesObserved': peak_work, 'outputBytes': output_size, 'seconds': time.monotonic()-begin,
              'testsRun': False, 'buildRun': False, 'productionActivationPerformedByRunner': False,
              'coldControllerRecoveryQualified': False, 'rootMustCollectSameScopeTerminal': True}
    write('RESULT.json', result); print(json.dumps(result, sort_keys=True))
    return 0 if ok else 2

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as e:
        print(json.dumps({'status': 'REFUSED', 'reason': str(e) if type(e) is RuntimeError else type(e).__name__}))
        raise SystemExit(2)

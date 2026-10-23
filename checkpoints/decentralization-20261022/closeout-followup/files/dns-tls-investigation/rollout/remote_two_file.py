"""remote_two_file.py - the program deploy-two-file.py sends to the control VM (sudo python3 -, stdin; stdlib only).

The bounded, CAS-protected pattern of relay-release-live/deploy-reviewed.py, for TWO relay files swapped together.
  preflight  read-only. Checks:
             - service identity: the unit is active and its MainPID == the pinned PID;
             - both targets at their exact OLD sha256;
             - `node --check` accepts both INSTALLED files (otherwise the check judges nothing);
             - no backup or temp is left from an earlier attempt;
             - the relay answers the EXPECTED probes: GET /v1/certs/issue -> 405 method_not_allowed, and the release-status
               row -> 200 {id, listed: true}.
  apply      the same checks, then:
             - write both new files as temps beside their targets (owner and mode copied; sha256 and `node --check`
               verified). A refusal removes them and leaves no backup;
             - back up both old files (re-read and verified);
             - RE-CHECK the identity and both old hashes immediately before the first swap;
             - replace both and verify both at their NEW sha256;
             - restart ONCE, and wait for a new MainPID answering the expected probes.
             After any replace, a failure restores EVERY target that is not at its old sha256 (verified). If a restart was
             ATTEMPTED (recorded before the call, so a timed-out restart counts), it restarts once more and verifies that
             a new process answers the expected probes. Otherwise it verifies that the original process still runs and
             answers.
  rollback   root's explicit return. Both backups must be at their old sha256, and each target at its old or new sha256
             (anything else refuses). Restores both, verifies, restarts ONCE and waits for the expected probes.
  status     read-only. Reports the current hashes, MainPID, probes and the last result.json in the backup directory (for
             an outcome the caller could not read).
Every path and bound comes from the caller's config (production values are pinned in deploy-two-file.py; the offline
tests use a fake root). Nothing else is read, written or restarted: no config, environment, key or log. Bounds: each
systemctl read 5 s, a restart cfg restartSec, node --check 15 s, each probe 5 s, readiness cfg readySec plus at most one
iteration. SIGHUP is ignored, so a dropped SSH session cannot cut a swap in half. The result is also kept as
<backup>/result.json when a backup exists.
Prints ONE JSON line {"status": ...}. Statuses:
  PREFLIGHT_OK | STATUS | REFUSED (nothing replaced) | ERROR (an unexpected failure before any replace)
  DEPLOYED_READY (functional proof still pending, see `pending`)
  ROLLED_BACK (apply failed after a replace; both old files verified and the old code verified answering)
  ROLLBACK_NOT_READY (both old files verified, but the old code was NOT verified answering: a failure, root acts)
  RESTORE_UNVERIFIED (a file could not be proven back: inspect; nothing more is done)
  ROLLED_BACK_READY | ROLLBACK_NOT_READY | NOTHING_TO_ROLL_BACK (rollback mode)
"""
import base64, hashlib, json, os, pathlib, signal, subprocess, time, urllib.error, urllib.request


def sha(b):
    return hashlib.sha256(b).hexdigest()


class Refused(Exception):
    pass


def main(P, C, mode):
    try:
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
    except (ValueError, OSError):
        pass   # not the main thread (tests)
    t0 = time.monotonic()
    d = pathlib.Path(C['dir']); backup = pathlib.Path(C['backup']); svc = C['service']
    files = P['files']
    out = {'mode': mode, 'service': svc, 'files': [{'name': f['name'], 'old': f['old'], 'new': f['new']} for f in files]}
    EXPECTED = {'certs': [405, 'method_not_allowed'], 'release': [200, {'id': C['probeId'], 'listed': True}]}
    restarts = []   # every ATTEMPT, appended BEFORE the call: [kind, returncode | 'timeout' | 'pending']

    def ctl(*a, timeout=5):
        return subprocess.run([C['systemctl'], *a], capture_output=True, text=True, timeout=timeout)

    def mainpid():
        try:
            return ctl('show', svc, '-p', 'MainPID', '--value').stdout.strip()
        except subprocess.TimeoutExpired:
            return ''

    def is_active():
        try:
            return ctl('is-active', svc).stdout.strip() == 'active'
        except subprocess.TimeoutExpired:
            return False

    def restart(kind):
        """one restart ATTEMPT, recorded before it is made; -> True only on a confirmed success"""
        rec = [kind, 'pending']; restarts.append(rec)
        try:
            r = ctl('restart', svc, timeout=C['restartSec'])
            rec[1] = r.returncode
            return r.returncode == 0
        except subprocess.TimeoutExpired:
            rec[1] = 'timeout'   # it may have started (or still be starting) the service: never treated as nothing done
            return False

    def target(f):
        return d / f['name']

    def temp(f):
        stem, _dot, ext = f['name'].rpartition('.')
        return d / f'{stem}.dns-tls-candidate.{ext}'

    def probe():
        """the relay's own answers on loopback, reduced to stable fields (status + error code / the release row)"""
        res = {}
        for key, path in (('certs', '/v1/certs/issue'), ('release', '/v1/secrets/release-status?id=' + C['probeId'])):
            try:
                with urllib.request.urlopen(C['probeBase'] + path, timeout=5) as r:
                    status, body = r.status, r.read()
            except urllib.error.HTTPError as e:
                status, body = e.code, e.read(); e.close()
            except Exception as e:
                res[key] = ['unreachable', type(e).__name__]; continue
            try:
                doc = json.loads(body or b'{}')
            except ValueError:
                doc = {}
            res[key] = [status, doc.get('error') if key == 'certs' else {k: doc.get(k) for k in ('id', 'listed')}]
        return res

    def ready(not_pid):
        """a MainPID other than not_pid, active, answering EXACTLY the expected probes, within readySec (+1 iteration)"""
        deadline = time.monotonic() + C['readySec']; pid, last = '', None
        while time.monotonic() < deadline:
            pid = mainpid()
            if pid not in ('', '0', not_pid) and is_active():
                last = probe()
                if last == EXPECTED:
                    return True, pid, last
            time.sleep(1)
        return False, pid, last

    def node_check(p):
        try:
            return subprocess.run([C['node'], '--check', str(p)], capture_output=True, text=True, timeout=15).returncode == 0
        except subprocess.TimeoutExpired:
            return False

    def write_like(path, data, like):
        path.write_bytes(data); os.chmod(path, like.st_mode & 0o777); os.chown(path, like.st_uid, like.st_gid)

    def identity(pinned):
        if not is_active():
            raise Refused(f'{svc} is not active')
        pid = mainpid()
        if pid != str(pinned):
            raise Refused(f'{svc} MainPID is {pid or "unreadable"}, not the pinned {pinned}')
        return pid

    def at_old():
        for f in files:
            got = sha(target(f).read_bytes())
            if got != f['old']:
                raise Refused(f'{f["name"]} is {got[:16]}..., not the pinned old {f["old"][:16]}...')

    def restore(olds):
        """every target not at its old sha256 gets its old bytes back (temp + replace); -> all verified old"""
        for f in files:
            if sha(target(f).read_bytes()) != f['old']:
                st = target(f).stat(); write_like(temp(f), olds[f['name']], st); os.replace(temp(f), target(f))
        for f in files:
            temp(f).unlink(missing_ok=True)
        return all(sha(target(f).read_bytes()) == f['old'] for f in files)

    def finish(result):
        result['restarts'] = restarts; result['sec'] = round(time.monotonic() - t0, 1)
        if backup.is_dir() and mode in ('apply', 'rollback'):
            try:
                (backup / 'result.json').write_text(json.dumps(result)); os.chmod(backup / 'result.json', 0o600)
            except OSError:
                pass
        return result

    try:
        if mode == 'status':
            out['shas'] = {f['name']: sha(target(f).read_bytes()) for f in files}
            out['pid'] = mainpid(); out['active'] = is_active(); out['probes'] = probe()
            try:
                out['last'] = json.loads((backup / 'result.json').read_text())
            except (OSError, ValueError):
                out['last'] = None
            out['status'] = 'STATUS'; return finish(out)

        if mode in ('preflight', 'apply'):
            pid = identity(C['expectedPid']); out['oldPid'] = pid
            at_old()
            for f in files:
                if temp(f).exists():
                    raise Refused(f'{temp(f).name} is left from an earlier attempt: inspect it')
                if not node_check(target(f)):
                    raise Refused(f'node --check cannot parse the installed {f["name"]}: the check method is not valid here')
            if backup.exists():
                raise Refused(f'{backup} exists: an earlier attempt ran; inspect it (status / rollback) instead')
            base = probe(); out['baseline'] = base
            if base != EXPECTED:
                raise Refused('the relay does not answer the expected baseline (405 method_not_allowed, 200 listed)')
            if mode == 'preflight':
                out['status'] = 'PREFLIGHT_OK'; return finish(out)

            # ---- temps first (a refusal here leaves nothing behind), then verified backups
            written, olds = [], {}
            try:
                for f in files:
                    src = base64.b64decode(f['source'])
                    if sha(src) != f['new']:
                        raise Refused(f'the payload for {f["name"]} is not its pinned new sha256')
                    st = target(f).stat(); write_like(temp(f), src, st); written.append(temp(f))
                    if sha(temp(f).read_bytes()) != f['new']:
                        raise Refused(f'the temp of {f["name"]} does not verify')
                    if not node_check(temp(f)):
                        raise Refused(f'node --check refused the new {f["name"]}')
                backup.mkdir(mode=0o700); out['backup'] = str(backup)
                for f in files:
                    b = target(f).read_bytes()
                    (backup / f['name']).write_bytes(b); os.chmod(backup / f['name'], 0o600)
                    if sha(b) != f['old'] or sha((backup / f['name']).read_bytes()) != f['old']:
                        raise Refused(f'the backup of {f["name"]} does not verify')
                    olds[f['name']] = b
                (backup / 'manifest.json').write_text(json.dumps({'oldPid': pid, 'files': out['files'], 'service': svc}))
                # ---- CAS, again, immediately before the first swap: the same process, both files still the old bytes
                identity(pid); at_old()
            except Exception:
                for p in written: p.unlink(missing_ok=True)
                raise

            # ---- the swap: both, then ONE restart
            try:
                for f in files:
                    os.replace(temp(f), target(f))
                for f in files:
                    if sha(target(f).read_bytes()) != f['new']:
                        raise RuntimeError(f'{f["name"]} is not the new sha256 after the replace')
                if not restart('apply'):
                    raise RuntimeError(f'the restart did not confirm ({restarts[-1][1]})')
                ok, newpid, last = ready(pid)
                out['newPid'] = newpid; out['probes'] = last
                if not ok:
                    raise RuntimeError('the restarted relay did not answer the expected probes within the readiness window')
                out.update(status='DEPLOYED_READY', backup=str(backup),
                           pending='functional proof: the next Shield certificate request is answered (200 or 202) within '
                                   '40 s, and the node log shows no new 60-s abort for that name')
                return finish(out)
            except Exception as e:
                out['error'] = f'{type(e).__name__}: {e}'
                if not restore(olds):
                    out['status'] = 'RESTORE_UNVERIFIED'; return finish(out)
                if restarts:   # a restart was ATTEMPTED (even one that timed out): the new code may be loaded or loading
                    cur = mainpid()
                    if not restart('rollback'):
                        out.update(status='ROLLBACK_NOT_READY', why=f'the rollback restart did not confirm ({restarts[-1][1]})')
                        return finish(out)
                    ok, rpid, last = ready(cur)
                else:          # never restarted: the original process must still run the old code and answer
                    rpid = mainpid(); last = probe()
                    ok = rpid == pid and is_active() and last == EXPECTED
                out.update(rollbackPid=rpid, rollbackProbes=last,
                           status='ROLLED_BACK' if ok else 'ROLLBACK_NOT_READY')
                return finish(out)

        if mode == 'rollback':
            if not backup.is_dir():
                raise Refused(f'no backup at {backup}')
            olds = {}
            for f in files:
                b = (backup / f['name']).read_bytes()
                if sha(b) != f['old']:
                    raise Refused(f'the backup of {f["name"]} is not its old sha256')
                olds[f['name']] = b
            state = {}
            for f in files:
                got = sha(target(f).read_bytes())
                if got not in (f['old'], f['new']):
                    raise Refused(f'{f["name"]} is {got[:16]}..., neither the old nor the new pinned bytes')
                if temp(f).exists():
                    raise Refused(f'{temp(f).name} is left over: inspect it')
                state[f['name']] = 'old' if got == f['old'] else 'new'
            out['before'] = state
            if all(v == 'old' for v in state.values()):
                out['status'] = 'NOTHING_TO_ROLL_BACK'; return finish(out)
            for f in files:
                if state[f['name']] == 'new':
                    st = target(f).stat(); write_like(temp(f), olds[f['name']], st)
                    if not node_check(temp(f)):
                        temp(f).unlink(missing_ok=True); raise Refused(f'node --check refused the backed-up {f["name"]}')
            if not restore(olds):
                out['status'] = 'RESTORE_UNVERIFIED'; return finish(out)
            cur = mainpid(); out['oldPid'] = cur
            if not restart('rollback'):
                out.update(status='ROLLBACK_NOT_READY', why=f'the restart did not confirm ({restarts[-1][1]})')
                return finish(out)
            ok, newpid, last = ready(cur)
            out.update(newPid=newpid, probes=last, status='ROLLED_BACK_READY' if ok else 'ROLLBACK_NOT_READY')
            return finish(out)
        raise Refused(f'unknown mode {mode}')
    except Refused as e:
        out.update(status='REFUSED', reason=str(e)); return finish(out)
    except Exception as e:   # before any replace (the swap has its own restore path): nothing replaced
        out.update(status='ERROR', error=f'{type(e).__name__}: {e}'); return finish(out)

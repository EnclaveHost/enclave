#!/usr/bin/env python3
"""install_verified.py (base-finality-proof-stage/r6-ops-fixes; PREPARED; NOT run by Claude): ROOT-ONLY, guarded install of EXACTLY the
qualified bytes named in MANIFEST.json. Default: a dry run (the plan is printed; nothing is written). --commit installs.
PREFLIGHT (no mutation at all) refuses unless:
  - this stage's files equal its SHA256SUMS and MANIFEST.json is the one SHA256SUMS lists;
  - root's qualification run of THIS stage passed: --qualification <out> has '## finality-r10 rc=0' and '## r10 SHA256SUMS <sha>' with
    this stage's SHA256SUMS sha, and --rc <file> holds 0;
  - every source equals its manifest sha and still carries its review flags = False (trees: exactly the listed files, each sha);
  - every destination parent is a real root-owned directory, not group/other writable, no symlink (absent ones are created 0755);
  - every existing destination is a regular file that is identical (skipped) or --replace is given; a tree destination holds no
    file outside the qualified tree; the wrapper only with --include-wrapper while no process runs it;
  - no earlier install journal is left open (run `recover` first).
COMMIT is journaled (/var/lib/enclave-rpc/install-journal/<stamp>.json, root 0600, written before the first mutation): each replaced
file is first COPIED (a new inode, 0600; the live file's bytes and mode are untouched) to the transaction's backup directory
<journal-dir>/<stamp>.backup/<dest path> (root 0700, OUTSIDE every installed module tree, so a tree's exact digest and file set are
never disturbed; its original mode/uid/gid are in the journal), then the new bytes
are written to a sibling temp, fsynced, given owner/mode, renamed into place, the directory fsynced and the result re-verified.
Any failure rolls every step back exactly (bytes, mode, owner; created files and directories removed) and the journal records it.
An interrupted commit (crash, kill) leaves the journal `open`: `install_verified.py recover` restores the same way; installs and
activation refuse while a journal is open."""
import datetime, hashlib, json, os, pathlib, stat, sys

HERE = pathlib.Path(__file__).resolve().parent; STAGE = HERE.parent
ROOT = pathlib.Path('/')                      # tests point this at a private tree
UID = 0                                       # the owner every installed file and parent must have
PROC = pathlib.Path('/proc')
JOURNAL_DIR = '/var/lib/enclave-rpc/install-journal'
sha = lambda b: hashlib.sha256(b).hexdigest()


class Refused(Exception):
    pass


def refuse(why):
    raise Refused(why)


def R(p):
    return ROOT / str(p).lstrip('/')


def stage_sums():
    sums = (STAGE / 'SHA256SUMS').read_bytes()
    for line in sums.decode().splitlines():
        want, rel = line.split(None, 1); rel = rel.lstrip('*')
        if sha((STAGE / rel).read_bytes()) != want:
            refuse(f'stage file {rel} differs from SHA256SUMS')
    if not any(l.endswith(' ./install/MANIFEST.json') for l in sums.decode().splitlines()):
        refuse('MANIFEST.json is not listed in SHA256SUMS')
    return sha(sums)


def qualified(out, rc, sums_sha):
    o = pathlib.Path(out).read_text(errors='replace').splitlines()
    if pathlib.Path(rc).read_text().strip() != '0' or '## finality-r10 rc=0' not in o or f'## r10 SHA256SUMS {sums_sha}' not in o:   # r10: only an r10 run qualifies r10
        refuse('no passing root qualification of THIS stage (rc 0, "## finality-r10 rc=0", "## r10 SHA256SUMS <this sha>")')


def tree_sha256(root):
    rows = []
    for dp, dns, fns in os.walk(root):
        for n in dns + fns:
            p = pathlib.Path(dp, n); st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                refuse(f'{p} is a symlink or not a regular file')
            if stat.S_ISREG(st.st_mode):
                rows.append(f'{p.relative_to(root).as_posix()}\0{sha(p.read_bytes())}')
    return sha('\n'.join(sorted(rows)).encode())


def wrapper_running(dest):
    for pd in PROC.iterdir():
        if pd.name.isdigit():
            try:
                if str(dest).encode() in (pd / 'cmdline').read_bytes():
                    return int(pd.name)
            except OSError:
                pass
    return None


# ---- PREFLIGHT: reads only -------------------------------------------------------------------------------------------------
def parents_to_create(dest):
    """the absent parent directories of dest (outermost first); refuses an existing component that is not a safe root dir"""
    cur, missing = pathlib.Path('/'), []
    for part in pathlib.Path(dest).parent.parts[1:]:
        cur = cur / part
        try:
            st = os.lstat(R(cur))
        except FileNotFoundError:
            missing.append(str(cur)); continue
        if missing:
            refuse(f'{cur} exists below the absent {missing[0]}')
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != UID or st.st_mode & 0o022:
            refuse(f'{cur} is not a real root-owned directory without group/other write')
    return missing


def dest_action(b, dest, mode, replace):
    p = R(dest)
    if not os.path.lexists(p):
        return {'action': 'create'}
    st = os.lstat(p)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        refuse(f'{dest} exists and is not a regular file')
    old = p.read_bytes()
    if sha(old) == sha(b) and st.st_uid == UID and stat.S_IMODE(st.st_mode) == mode:
        return {'action': 'identical'}
    if not replace:
        refuse(f'{dest} exists with other bytes or mode (use --replace after review)')
    return {'action': 'replace', 'prevSha256': sha(old), 'prevMode': stat.S_IMODE(st.st_mode), 'prevUid': st.st_uid, 'prevGid': st.st_gid}


def open_journals():
    d = R(JOURNAL_DIR)
    if not d.is_dir():
        return []
    return sorted(p for p in d.glob('*.json') if json.loads(p.read_bytes()).get('state') == 'open')


def preflight(m, *, replace, include_wrapper, include_units, include_configs=False, stage=STAGE):
    """every check, no write; -> the ordered operations (each with its bytes) and the plan"""
    if m.get('format') != 'enclave-finality-install-manifest/v1':
        refuse('not the finality install manifest (enclave-finality-install-manifest/v1)')
    if open_journals():
        refuse(f'an install journal is still open ({open_journals()[0].name}): run `install_verified.py recover` first')
    ops, plan, seen = [], [], set()
    def add(b, dest, mode):
        if dest in seen:
            refuse(f'{dest} is named twice')
        seen.add(dest)
        op = {'dest': dest, 'mode': mode, 'sha256': sha(b), 'parents': parents_to_create(dest), **dest_action(b, dest, mode, replace)}
        ops.append((op, b)); plan.append({'dest': dest, 'result': op['action']})
    for e in m['files']:
        if e.get('wrapper') and not include_wrapper:
            plan.append({'dest': e['dest'], 'result': 'skipped (wrapper: needs --include-wrapper)'}); continue
        if e.get('unit') and not include_units:
            plan.append({'dest': e['dest'], 'result': 'skipped (systemd unit: needs --include-units; then daemon-reload by root)'}); continue
        if e.get('config') and not include_configs:                 # r9: templates; never replace a root-filled config
            plan.append({'dest': e['dest'], 'result': 'skipped (config template: needs --include-configs)'}); continue
        if e.get('wrapper') and wrapper_running(e['dest']):
            refuse(f'{e["dest"]} is in use by a running process: stop the units first (root)')
        src = (stage / e['src']) if not e['src'].startswith('/') else pathlib.Path(e['src'])
        b = src.read_bytes()
        if sha(b) != e['sha256']:
            refuse(f'{e["src"]} differs from its manifest sha')
        for line in e.get('flagsFalse', []):
            if f'\n{line} = False' not in '\n' + b.decode():
                refuse(f'{e["src"]}: {line} is not False in the source: nothing is installed')
        add(b, e['dest'], int(e['mode'], 8))
    for t in m.get('trees', []):
        src = pathlib.Path(t['src']) if t['src'].startswith('/') else stage / t['src']      # r9: stage-relative bundle trees
        files = {p.relative_to(src).as_posix(): p for p in src.rglob('*') if p.is_file() or p.is_symlink()}
        if tree_sha256(src) != t['treeSha256'] or set(files) != set(t['files']) or any(sha(files[r].read_bytes()) != s for r, s in t['files'].items()):
            refuse(f'{src} differs from its manifest tree')
        d = R(t['dest'])
        if d.exists():
            extra = sorted(p.relative_to(d).as_posix() for p in d.rglob('*') if not p.is_dir() and p.relative_to(d).as_posix() not in t['files'])
            if extra:
                refuse(f'{t["dest"]} holds files outside the qualified tree: {extra[:5]}')
        for r in sorted(t['files']):
            add(files[r].read_bytes(), f'{t["dest"]}/{r}', 0o644)
    return ops, plan


# ---- COMMIT: journaled, rolled back on any failure ----------------------------------------------------------------------------
def _write_file(path, b, mode, uid, gid):
    tmp = path.with_name(f'.{path.name}.install-{os.getpid()}')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        v = memoryview(b)
        while v:
            v = v[os.write(fd, v):]
        os.fsync(fd)
        if os.geteuid() == 0:
            os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    _fsync_dir(path.parent)


def _fsync_dir(d):
    dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)


def _save(jpath, j):
    _write_file(jpath, json.dumps(j, indent=1, sort_keys=True).encode(), 0o600, UID, UID)


def commit(ops, stamp, fail_at=None, crash_at=None):
    """fail_at / crash_at (tests only): raise inside step i (rolled back) / stop dead after step i (journal left open)"""
    jd = R(JOURNAL_DIR); jd.mkdir(mode=0o700, parents=True, exist_ok=True)
    jpath = jd / f'{stamp}.json'
    if os.path.lexists(jpath):
        refuse(f'journal {jpath.name} exists')
    work = [(op, b) for op, b in ops if op['action'] != 'identical']
    j = {'format': 'enclave-finality-install-journal/v1', 'stamp': stamp, 'state': 'open',
         'ops': [{k: v for k, v in op.items()} | {'step': 'planned'} for op, _ in work]}
    _save(jpath, j)
    try:
        for i, (op, b) in enumerate(work):
            jo = j['ops'][i]
            for d in jo['parents']:
                if not os.path.lexists(R(d)):
                    jo.setdefault('createdDirs', []).append(d); _save(jpath, j)
                    os.mkdir(R(d), 0o755)
                    if os.geteuid() == 0:
                        os.chown(R(d), UID, UID)
            p = R(op['dest'])
            if op['action'] == 'replace':
                keep = _backup_path(stamp, op['dest'])                      # r2: never beside the live file (module trees stay exact)
                _write_file(keep, p.read_bytes(), 0o600, UID, UID)          # a COPY: the live inode keeps its mode
                if sha(keep.read_bytes()) != op['prevSha256']:
                    refuse(f'{op["dest"]} changed during the install')
                jo['backup'] = str(keep); jo['step'] = 'backed-up'; _save(jpath, j)
            jo['step'] = 'writing'; _save(jpath, j)
            if fail_at == i:
                raise OSError(f'injected failure at step {i}')
            _write_file(p, b, op['mode'], UID, UID)
            if sha(p.read_bytes()) != op['sha256']:
                refuse(f'{op["dest"]} did not land as verified')
            jo['step'] = 'done'; _save(jpath, j)
            if crash_at == i:
                return 'crashed (test)'
        j['state'] = 'committed'; _save(jpath, j)
        return 'committed'
    except (Refused, OSError) as e:
        rollback(jpath)
        refuse(f'install failed at {e}; every step was rolled back (journal {jpath.name})')


def _backup_path(stamp, dest):
    """<journal-dir>/<stamp>.backup/<dest without leading />; every directory root 0700, none a symlink"""
    rel = pathlib.PurePosixPath(dest.lstrip('/'))
    base = R(JOURNAL_DIR) / f'{stamp}.backup'
    for d in [base] + [base.joinpath(*rel.parent.parts[:i + 1]) for i in range(len(rel.parent.parts))]:
        if not os.path.lexists(d):
            os.mkdir(d, 0o700)
            if os.geteuid() == 0:
                os.chown(d, UID, UID)
        st = os.lstat(d)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
            refuse(f'{d} is not a real directory')
    return base.joinpath(*rel.parts)


def rollback(jpath):
    j = json.loads(jpath.read_bytes())
    for jo in reversed(j['ops']):
        p = R(jo['dest'])
        if p.parent.is_dir():                                    # temps of ANY interrupted writer (a crash leaves another pid's)
            for tmp in p.parent.glob(f'.{p.name}.install-*'):
                os.unlink(tmp)
        if jo['step'] in ('writing', 'done'):
            if jo['action'] == 'replace':
                b = pathlib.Path(jo['backup']).read_bytes()
                if sha(b) != jo['prevSha256']:
                    refuse(f'backup of {jo["dest"]} is not the original bytes: restore by hand from {jo["backup"]}')
                _write_file(p, b, jo['prevMode'], jo['prevUid'], jo['prevGid'])
            elif os.path.lexists(p):
                os.unlink(p); _fsync_dir(p.parent)
        for d in reversed(jo.get('createdDirs', [])):
            try:
                os.rmdir(R(d))
            except OSError:
                pass
        jo['step'] = 'rolled-back'
    j['state'] = 'rolled-back'; _save(jpath, j)
    return 'rolled-back'


def recover():
    return [{'journal': p.name, 'result': rollback(p)} for p in open_journals()]


# ---- ACTIVATION -------------------------------------------------------------------------------------------------------------
ACTIVATION_FILE = '/etc/enclave-rpc/finality-activation.json'
FLAG_MODULE = {'A1_CAPTURE_REVIEWED': '/opt/enclave-rpc/a2a4-recovery/a2a4.py', 'FINALITY_PROTOTYPE_REVIEWED': '/opt/enclave-rpc/finality/src/finality_state.py',
               'FINALITY_PROOF_REVIEWED': '/opt/enclave-rpc/base-launch/base_launch.py', 'LAUNCH_PRODUCER_REVIEWED': '/opt/enclave-rpc/chain_service.py'}


def installed_exactly(m):
    """refuses unless no journal is open, every non-unit manifest file is installed byte-exact and root-owned, and (r2) every
    manifest TREE is installed exactly: the same file set (no extra file, no symlink), each file's sha, root-owned and not
    group/other writable, and the tree digest finality_state checks"""
    if open_journals():
        refuse('an install journal is still open (a partial install): run recover, then install again')
    for e in m['files']:
        if e.get('unit') or e.get('config'):          # r9: configs are root-filled after install (their unknowns), never byte-pinned
            continue
        d = R(e['dest'])
        if not d.is_file() or d.is_symlink() or sha(d.read_bytes()) != e['sha256'] or os.lstat(d).st_uid != UID:
            refuse(f'{e["dest"]} is not installed as the qualified bytes: install first')
    for t in m.get('trees', []):
        d = R(t['dest'])
        if not d.is_dir() or d.is_symlink():
            refuse(f'{t["dest"]} is not an installed tree')
        found = {}
        for p in d.rglob('*'):
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):
                refuse(f'{p} in {t["dest"]} is a symlink or not a regular file')
            if st.st_uid != UID or st.st_mode & 0o022:
                refuse(f'{p} in {t["dest"]} is not root-owned or is group/other writable')
            if stat.S_ISREG(st.st_mode):
                found[p.relative_to(d).as_posix()] = sha(p.read_bytes())
        if set(found) != set(t['files']):
            refuse(f'{t["dest"]} holds another file set than the qualified tree (extra {sorted(set(found) - set(t["files"]))[:5]}, '
                   f'missing {sorted(set(t["files"]) - set(found))[:5]})')
        bad = sorted(r for r, s in t['files'].items() if found[r] != s)
        if bad or tree_sha256(d) != t['treeSha256']:
            refuse(f'{t["dest"]} is not the qualified tree (changed: {bad[:5]})')


def activate(argv):
    """r6: the DELIBERATE activation step (root, after qualification and a byte-exact install): writes the root-owned activation
    artifact naming, per flag, the sha of the INSTALLED module that reads it (each module's reviewed() accepts only its own bytes).
    Requires --confirm <sha256 of the qualification output> and --commit; refuses on an open install journal or any file not
    installed exactly. Source flags stay False; nothing is edited, so every byte pin stays valid. Undo: remove the artifact."""
    import argparse
    ap = argparse.ArgumentParser(prog='install_verified.py activate'); ap.add_argument('--qualification', required=True); ap.add_argument('--rc', required=True)
    ap.add_argument('--confirm', required=True); ap.add_argument('--flags', required=True); ap.add_argument('--commit', action='store_true')
    a = ap.parse_args(argv)
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    try:
        sums_sha = stage_sums(); qualified(a.qualification, a.rc, sums_sha); q_sha = sha(pathlib.Path(a.qualification).read_bytes())
        if a.confirm != q_sha:
            refuse('--confirm is not the sha256 of the qualification output: activation must name the evidence reviewed')
        m = json.loads((HERE / 'MANIFEST.json').read_bytes())
        installed_exactly(m)
        flags = [f for f in a.flags.split(',') if f]
        if not flags or any(f not in FLAG_MODULE for f in flags):
            refuse(f'--flags must name some of {sorted(FLAG_MODULE)}')
        doc = {'format': 'enclave-finality-activation/v1', 'flags': {f: sha(R(FLAG_MODULE[f]).read_bytes()) for f in flags},
               'stageSha256Sums': sums_sha, 'qualificationSha256': q_sha, 'activatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        b = json.dumps(doc, indent=1, sort_keys=True).encode() + b'\n'
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        op = {'dest': ACTIVATION_FILE, 'mode': 0o644, 'sha256': sha(b), 'parents': parents_to_create(ACTIVATION_FILE), **dest_action(b, ACTIVATION_FILE, 0o644, True)}
        res = commit([(op, b)], stamp) if a.commit else f'would-{op["action"]}'
    except (Refused, OSError, KeyError, ValueError) as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(json.dumps({'ok': True, 'commit': a.commit, 'activation': ACTIVATION_FILE, 'result': res, 'flags': doc['flags']}, indent=1))
    return 0


def main(argv):
    if argv[:1] == ['activate']:
        return activate(argv[1:])
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    if argv[:1] == ['recover']:
        try:
            print(json.dumps({'ok': True, 'recovered': recover()}, indent=1)); return 0
        except (Refused, OSError, ValueError) as e:
            print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument('--qualification', required=True); ap.add_argument('--rc', required=True)
    ap.add_argument('--commit', action='store_true'); ap.add_argument('--replace', action='store_true'); ap.add_argument('--include-wrapper', action='store_true'); ap.add_argument('--include-units', action='store_true'); ap.add_argument('--include-configs', action='store_true')
    a = ap.parse_args(argv)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'); plan = []
    try:
        sums_sha = stage_sums(); qualified(a.qualification, a.rc, sums_sha)
        m = json.loads((HERE / 'MANIFEST.json').read_bytes())
        ops, plan = preflight(m, replace=a.replace, include_wrapper=a.include_wrapper, include_units=a.include_units, include_configs=a.include_configs)
        result = commit(ops, stamp) if a.commit else 'dry-run (nothing written)'
    except (Refused, OSError, KeyError, ValueError) as e:
        print(json.dumps({'ok': False, 'refused': str(e), 'plan': plan}, indent=1)); return 1
    print(json.dumps({'ok': True, 'commit': a.commit, 'result': result, 'plan': plan}, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

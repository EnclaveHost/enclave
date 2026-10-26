#!/usr/bin/env python3
"""install_verified.py (base-finality-proof-stage/r6; PREPARED; NOT run by Claude): ROOT-ONLY, guarded install of EXACTLY the qualified
bytes named in MANIFEST.json. Default: a dry run (the plan is printed; nothing is written). --commit installs. Refuses unless:
  - this stage's files equal its SHA256SUMS and MANIFEST.json is the one SHA256SUMS lists;
  - root's qualification run of THIS stage passed: --qualification <out> has '## finality-r5 rc=0' and '## r5 SHA256SUMS <sha>' with
    this stage's SHA256SUMS sha, and --rc <file> holds 0;
  - every source equals its manifest sha (trees: exactly the listed files, each sha, and the tree digest finality_state checks);
  - every destination parent is a real root-owned directory, not group/other writable (created 0755 when absent), no symlink;
  - an existing destination is identical (skipped) or --replace is given (the old bytes are kept as <dest>.pre-<UTC>, root 0600);
  - the wrapper (the live unit's file) only with --include-wrapper while no process runs it;
  - every installed source still carries its review flags = False (installing bytes activates nothing).
Each file: written to a sibling temp, fsynced, mode set, renamed into place, directory fsynced, re-read and re-verified."""
import datetime, hashlib, json, os, pathlib, stat, sys

HERE = pathlib.Path(__file__).resolve().parent; STAGE = HERE.parent
sha = lambda b: hashlib.sha256(b).hexdigest()


class Refused(Exception):
    pass


def refuse(why):
    raise Refused(why)


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
    if pathlib.Path(rc).read_text().strip() != '0' or '## finality-r6 rc=0' not in o or f'## r6 SHA256SUMS {sums_sha}' not in o:
        refuse('no passing root qualification of THIS stage (rc 0, "## finality-r5 rc=0", this SHA256SUMS sha)')


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


def secure_parent(dest, commit):
    cur = pathlib.Path('/')
    for part in dest.parent.parts[1:]:
        cur = cur / part
        try:
            st = os.lstat(cur)
        except FileNotFoundError:
            if commit:
                os.mkdir(cur, 0o755); os.chown(cur, 0, 0); st = os.lstat(cur)
            else:
                continue
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            refuse(f'{cur} is not a real root-owned directory without group/other write')


def wrapper_running(dest):
    for pd in pathlib.Path('/proc').iterdir():
        if pd.name.isdigit():
            try:
                if str(dest).encode() in (pd / 'cmdline').read_bytes():
                    return int(pd.name)
            except OSError:
                pass
    return None


def put(src_bytes, dest, mode, commit, replace, stamp):
    dest = pathlib.Path(dest); secure_parent(dest, commit)
    if os.path.lexists(dest):
        st = os.lstat(dest)
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            refuse(f'{dest} exists and is not a regular file')
        if sha(dest.read_bytes()) == sha(src_bytes) and st.st_uid == 0 and stat.S_IMODE(st.st_mode) == mode:
            return 'identical'
        if not replace:
            refuse(f'{dest} exists with other bytes or mode (use --replace after review)')
    if not commit:
        return 'would-install'
    if os.path.lexists(dest):
        keep = dest.with_name(f'{dest.name}.pre-{stamp}'); os.link(dest, keep); os.chmod(keep, 0o600)
    tmp = dest.with_name(f'.{dest.name}.install-{os.getpid()}')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        v = memoryview(src_bytes)
        while v:
            v = v[os.write(fd, v):]
        os.fsync(fd); os.fchown(fd, 0, 0); os.fchmod(fd, mode)
    finally:
        os.close(fd)
    os.replace(tmp, dest)
    dfd = os.open(dest.parent, os.O_RDONLY | os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
    if sha(dest.read_bytes()) != sha(src_bytes):
        refuse(f'{dest} did not land as verified')
    return 'installed'


ACTIVATION_FILE = pathlib.Path('/etc/enclave-rpc/finality-activation.json')
FLAG_MODULE = {'A1_CAPTURE_REVIEWED': '/opt/enclave-rpc/a2a4-recovery/a2a4.py', 'FINALITY_PROTOTYPE_REVIEWED': '/opt/enclave-rpc/finality/src/finality_state.py',
               'FINALITY_PROOF_REVIEWED': '/opt/enclave-rpc/base-launch/base_launch.py', 'LAUNCH_PRODUCER_REVIEWED': '/opt/enclave-rpc/chain_service.py'}


def activate(argv):
    """r6: the DELIBERATE activation step (root, after qualification and a byte-exact install): writes the root-owned activation
    artifact naming, per flag, the sha of the INSTALLED module that reads it (each module's reviewed() accepts only its own bytes).
    Requires --confirm <sha256 of the qualification output> and --commit; refuses unless every manifest file is installed exactly.
    Source flags stay False; nothing is edited, so every byte pin stays valid. Undo: remove the artifact."""
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
        for e in m['files']:
            if e.get('unit'):
                continue
            d = pathlib.Path(e['dest'])
            if not d.is_file() or d.is_symlink() or sha(d.read_bytes()) != e['sha256'] or os.lstat(d).st_uid != 0:
                refuse(f'{d} is not installed as the qualified bytes: install first')
        flags = [f for f in a.flags.split(',') if f]
        if not flags or any(f not in FLAG_MODULE for f in flags):
            refuse(f'--flags must name some of {sorted(FLAG_MODULE)}')
        doc = {'format': 'enclave-finality-activation/v1', 'flags': {f: sha(pathlib.Path(FLAG_MODULE[f]).read_bytes()) for f in flags},
               'stageSha256Sums': sums_sha, 'qualificationSha256': q_sha, 'activatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        res = put(json.dumps(doc, indent=1, sort_keys=True).encode() + b'\n', ACTIVATION_FILE, 0o644, a.commit, True,
                  datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    except (Refused, OSError, KeyError, ValueError) as e:
        print(json.dumps({'ok': False, 'refused': str(e)})); return 1
    print(json.dumps({'ok': True, 'commit': a.commit, 'activation': str(ACTIVATION_FILE), 'result': res, 'flags': doc['flags']}, indent=1))
    return 0


def main(argv):
    if argv[:1] == ['activate']:
        return activate(argv[1:])
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument('--qualification', required=True); ap.add_argument('--rc', required=True)
    ap.add_argument('--commit', action='store_true'); ap.add_argument('--replace', action='store_true'); ap.add_argument('--include-wrapper', action='store_true'); ap.add_argument('--include-units', action='store_true')
    a = ap.parse_args(argv)
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'); plan = []
    try:
        sums_sha = stage_sums(); qualified(a.qualification, a.rc, sums_sha)
        m = json.loads((HERE / 'MANIFEST.json').read_bytes())
        if m.get('format') != 'enclave-finality-install-manifest/v1':
            refuse('not the r5 install manifest')
        for e in m['files']:
            if e.get('wrapper') and not a.include_wrapper:
                plan.append({'dest': e['dest'], 'result': 'skipped (wrapper: needs --include-wrapper)'}); continue
            if e.get('unit') and not a.include_units:
                plan.append({'dest': e['dest'], 'result': 'skipped (systemd unit: needs --include-units; then daemon-reload by root)'}); continue
            if e.get('wrapper') and wrapper_running(e['dest']):
                refuse(f'{e["dest"]} is in use by a running process: stop the units first (root)')
            src = (STAGE / e['src']) if not e['src'].startswith('/') else pathlib.Path(e['src'])
            b = src.read_bytes()
            if sha(b) != e['sha256']:
                refuse(f'{e["src"]} differs from its manifest sha')
            for line in e.get('flagsFalse', []):
                if f'\n{line} = False' not in '\n' + b.decode():
                    refuse(f'{e["src"]}: {line} is not False in the source: nothing is installed')
            plan.append({'dest': e['dest'], 'result': put(b, e['dest'], int(e['mode'], 8), a.commit, a.replace, stamp)})
        for t in m['trees']:
            src = pathlib.Path(t['src'])
            files = {p.relative_to(src).as_posix(): p for p in src.rglob('*') if p.is_file() or p.is_symlink()}
            if tree_sha256(src) != t['treeSha256'] or set(files) != set(t['files']) or any(sha(files[r].read_bytes()) != s for r, s in t['files'].items()):
                refuse(f'{src} differs from its manifest tree')
            for r in sorted(t['files']):
                plan.append({'dest': f'{t["dest"]}/{r}', 'result': put(files[r].read_bytes(), pathlib.Path(t['dest'], r), 0o644, a.commit, a.replace, stamp)})
            if a.commit and tree_sha256(t['dest']) != t['treeSha256']:
                refuse(f'{t["dest"]} holds other files than the qualified tree')
    except (Refused, OSError, KeyError, ValueError) as e:
        print(json.dumps({'ok': False, 'refused': str(e), 'plan': plan}, indent=1)); return 1
    print(json.dumps({'ok': True, 'commit': a.commit, 'plan': plan, 'note': 'bytes only: every review flag stays False'}, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

#!/usr/bin/env python3
"""Root-authorized SOURCE integration of fix/platform-api-argv-guard.patch into work/enclave (main working tree), CAS:
each target must equal its reviewed preimage (fix/a) or be absent (the new entry); the patch is applied with fuzz 0 to
temporary copies; each result must equal the reviewed fix/b file; then same-directory temp files are renamed into place
(mode preserved). No git operation, no other path touched. Receipt: integrate-main.json."""
import hashlib, json, os, shutil, subprocess, sys, tempfile, datetime
from pathlib import Path

H = Path(__file__).resolve().parent; M = H.parents[1] / 'enclave'; FIX = H / 'fix'
PATCH = FIX / 'platform-api-argv-guard.patch'
FILES = ['metal/guest/platform-api-entry.mjs', 'metal/guest/platform-api-role.mjs', 'scripts/build-platform-api-guest-bundle.mjs']
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).exists() else None
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()

def main():
    rec = {'startedAt': now(), 'target': str(M), 'patch': str(PATCH), 'patchSha256': sha(PATCH), 'files': []}
    for f in FILES:
        pre, live, want = sha(FIX / 'a' / f), sha(M / f), sha(FIX / 'b' / f)
        rec['files'].append({'path': f, 'expectedBefore': pre, 'before': live, 'expectedAfter': want})
        if live != pre: sys.exit(f'REFUSED: work/enclave/{f} is {live}, not the reviewed preimage {pre}; nothing written')
    with tempfile.TemporaryDirectory(dir=H) as td:
        for f in FILES:
            if (M / f).exists(): (Path(td) / f).parent.mkdir(parents=True, exist_ok=True); shutil.copy2(M / f, Path(td) / f)
        r = subprocess.run(['patch', '-p1', '--fuzz=0', '--no-backup-if-mismatch', '-d', td, '-i', str(PATCH)], capture_output=True, text=True)
        rec['patchOutput'] = (r.stdout + r.stderr).strip()
        if r.returncode: sys.exit('REFUSED: the patch does not apply with fuzz 0:\n' + rec['patchOutput'])
        for x in rec['files']:
            got = sha(Path(td) / x['path'])
            if got != x['expectedAfter']: sys.exit(f"REFUSED: patched {x['path']} is {got}, not the reviewed {x['expectedAfter']}")
        for x in rec['files']:   # all verified: install, each by a same-directory rename
            dst = M / x['path']; dst.parent.mkdir(parents=True, exist_ok=True)
            if sha(dst) != x['expectedBefore']: sys.exit(f"REFUSED: {x['path']} changed during the run; stopped (earlier files may be installed: see receipt)")
            mode = os.stat(dst).st_mode & 0o777 if dst.exists() else 0o644
            fd, tmp = tempfile.mkstemp(dir=dst.parent, prefix=f'.{dst.name}.argv-guard.')
            os.close(fd); shutil.copyfile(Path(td) / x['path'], tmp); os.chmod(tmp, mode); os.replace(tmp, dst)
            x['after'] = sha(dst); x['mode'] = oct(mode)
    rec['ok'] = all(x['after'] == x['expectedAfter'] for x in rec['files']); rec['finishedAt'] = now()
    json.dump(rec, open(H / 'integrate-main.json', 'w'), indent=1)
    print(json.dumps(rec, indent=1)); print('MAIN-INTEGRATED' if rec['ok'] else 'MAIN-MISMATCH')

if __name__ == '__main__':
    main()

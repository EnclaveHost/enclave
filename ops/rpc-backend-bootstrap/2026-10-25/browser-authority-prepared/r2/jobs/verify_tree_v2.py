#!/usr/bin/env python3
"""verify_tree.py <repo> <tree> <pins.json> <pre|post> <out.json>: CONTENT verification of the private tree against the
pinned git revision - never tar metadata. For EVERY tracked entry of `git ls-tree -r <rev>`:
  * 100644/100755 blob: the tree path is a regular file (not a symlink) whose bytes hash (sha256) equal the git blob's bytes;
  * 120000 blob: the tree path is a symlink whose target equals the blob (the link text);
  * 160000 gitlink: refused (none expected at this rev).
EXCEPTIONS, each exact: the two overlaid files must instead equal their src pins (and must differ from git); the two added
tests must exist with their pins; node_modules and network/node_modules must be symlinks with the exact pinned targets
(never descended). Anything else present on disk (file, symlink, special file) is UNEXPECTED and fails. Phase `post` also
allows exactly the two generated bundle files (recorded by sha256, not pinned). Permission bits are NOT compared: the tree
is intentionally frozen read-only by root, so write bits differ from git's 644/755; the executable bit is REPORTED
(mismatch count) for review, never used to excuse a content difference. Exit 0 only if every check passed.
v2 (browser-authority-stage r2; derived from verify_tree.py 08e6b813 with ONLY this addition): pins "gitClone": true
means the tree is a private full-history `git clone --no-local` checked out detached at the rev. Then `.git` must be a
directory and is not walked (its objects are git's own), HEAD must equal the rev, and `git status --porcelain
--untracked-files=all` must list EXACTLY the overlaid files as modified and the added files + allowed links as untracked
(+ the generated files in phase post). Every content check above still runs unchanged."""
import hashlib, json, os, stat, subprocess, sys, threading

repo, tree, pins_p, phase, out_p = sys.argv[1:6]
if phase not in ('pre', 'post'): sys.exit('phase must be pre or post')
pins = json.load(open(pins_p))
rev = pins['rev']
ls = subprocess.run(['git', '-C', repo, 'ls-tree', '-r', '-z', '--full-tree', rev], capture_output=True, check=True).stdout
entries = []
for rec in ls.split(b'\0'):
    if not rec: continue
    meta, path = rec.split(b'\t', 1)
    mode, typ, oid = meta.decode().split()
    entries.append((mode, typ, oid, path.decode('utf-8', 'surrogateescape')))
# all blob bytes in one `git cat-file --batch` stream
blobs = {}
oids = sorted({oid for mode, typ, oid, _ in entries if typ == 'blob'})
p = subprocess.Popen(['git', '-C', repo, 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
def feed():                                   # a separate writer: git's output pipe must be drained while input is written
    p.stdin.write(('\n'.join(oids) + '\n').encode()); p.stdin.close()
writer = threading.Thread(target=feed, daemon=True); writer.start()
for _ in oids:
    hdr = p.stdout.readline().split()
    if len(hdr) != 3 or hdr[1] != b'blob': sys.exit(f'git cat-file: unexpected header {hdr}')
    data = p.stdout.read(int(hdr[2])); p.stdout.read(1)
    blobs[hdr[0].decode()] = data
writer.join()
if p.wait() != 0: sys.exit('git cat-file failed')
sha = lambda b: hashlib.sha256(b).hexdigest()
fails, info = [], {'execBitMismatch': 0, 'writableFiles': 0, 'readOnlyFiles': 0}
GITCLONE = pins.get('gitClone') is True
if GITCLONE:
    if not os.path.isdir(os.path.join(tree, '.git')) or os.path.islink(os.path.join(tree, '.git')): fails.append('gitClone: .git is not a directory')
    head = subprocess.run(['git', '-C', tree, 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
    if head != rev: fails.append(f'gitClone: HEAD {head or "?"} != {rev}')
overlaid, added, links = pins['overlaid'], pins['added'], pins['symlinks']
tracked = set()
for mode, typ, oid, rel in entries:
    tracked.add(rel); full = os.path.join(tree, rel)
    try: st = os.lstat(full)
    except FileNotFoundError: fails.append(f'missing tracked {rel}'); continue
    if typ != 'blob': fails.append(f'unsupported tracked type {typ} {rel}'); continue
    if mode == '120000':
        if not stat.S_ISLNK(st.st_mode): fails.append(f'not a symlink {rel}')
        elif os.readlink(full).encode('utf-8', 'surrogateescape') != blobs[oid]: fails.append(f'symlink target differs {rel}')
        continue
    if not stat.S_ISREG(st.st_mode): fails.append(f'not a regular file {rel}'); continue
    got = sha(open(full, 'rb').read())
    if rel in overlaid:
        if got != overlaid[rel]: fails.append(f'overlaid file differs from its src pin {rel}')
        if got == sha(blobs[oid]): fails.append(f'overlaid file equals git (overlay missing) {rel}')
    elif got != sha(blobs[oid]): fails.append(f'content differs {rel}')
    info['writableFiles' if st.st_mode & 0o222 else 'readOnlyFiles'] += 1
    if bool(st.st_mode & 0o100) != (mode == '100755'): info['execBitMismatch'] += 1
for rel in overlaid:
    if rel not in tracked: fails.append(f'overlaid path is not tracked {rel}')
gen = set(pins['generatedAfterBuild']) if phase == 'post' else set()
seen_added, seen_links, generated, unexpected = set(), set(), {}, []
for dirpath, dirnames, filenames in os.walk(tree, followlinks=False):
    for name in list(dirnames) + filenames:
        full = os.path.join(dirpath, name); rel = os.path.relpath(full, tree); st = os.lstat(full)
        if GITCLONE and rel == '.git': continue
        if stat.S_ISDIR(st.st_mode): continue
        if rel in tracked: continue
        if rel in links:
            if not stat.S_ISLNK(st.st_mode) or os.readlink(full) != links[rel]: fails.append(f'allowed symlink has another target/type {rel}')
            seen_links.add(rel); continue
        if rel in added:
            if not stat.S_ISREG(st.st_mode) or sha(open(full, 'rb').read()) != added[rel]: fails.append(f'added test differs from its pin {rel}')
            seen_added.add(rel); continue
        if rel in gen and stat.S_ISREG(st.st_mode): generated[rel] = sha(open(full, 'rb').read()); continue
        unexpected.append(rel)
    dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d)) and not (GITCLONE and dirpath == tree and d == '.git')]   # never descend a symlink (nor the clone's .git)
fails += [f'unexpected file {r}' for r in sorted(unexpected)]
fails += [f'missing added test {r}' for r in sorted(set(added) - seen_added)]
fails += [f'missing allowed symlink {r}' for r in sorted(set(links) - seen_links)]
if phase == 'post': fails += [f'missing generated {r}' for r in sorted(gen - set(generated))]
if GITCLONE:
    st_out = subprocess.run(['git', '-C', tree, 'status', '--porcelain', '--untracked-files=all', '--no-renames'], capture_output=True, text=True).stdout.splitlines()
    want = sorted([f' M {f}' for f in overlaid] + [f'?? {f}' for f in list(added) + list(links) + sorted(generated)])
    if sorted(st_out) != want: fails.append(f'gitClone: git status differs from the pinned overlay: {sorted(set(st_out) ^ set(want))[:6]}')
res = {'rev': rev, 'phase': phase, 'tracked': len(entries), 'trackedSymlinks': sum(1 for e in entries if e[0] == '120000'),
       'overlaid': sorted(overlaid), 'added': sorted(seen_added), 'symlinks': sorted(seen_links), 'generated': generated,
       'permissionBits': 'not compared (tree intentionally read-only); see info', 'gitClone': GITCLONE, 'info': info, 'failures': fails}
json.dump(res, open(out_p, 'w'), indent=1)
print(f"## tree {phase}: {len(entries)} tracked ({res['trackedSymlinks']} symlinks) verified by content/target; overlaid {len(overlaid)}, added {len(seen_added)}, "
      f"links {len(seen_links)}, generated {len(generated)}; execBitMismatch {info['execBitMismatch']}; failures {len(fails)}")
for f in fails[:40]: print('## TREE FAIL:', f)
sys.exit(1 if fails else 0)

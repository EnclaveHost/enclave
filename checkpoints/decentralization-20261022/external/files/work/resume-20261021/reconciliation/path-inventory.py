# Path-only divergence + data-sensitivity inventory (reads NO file contents: git metadata, path names, lstat sizes/modes).
# Writes path-inventory.json. Inputs: local work/enclave (base c2bc3cc6 -> e762a9c5 -> working tree, nonignored untracked
# included) and upstream rewritten main (adf9c5bb = T(c2bc3cc6) -> 7752a423).
import json, os, re, stat, subprocess, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent; W = HERE.parents[1]; M = W/'enclave'; U = W/'product-claims-20261021/repo'
BASE, LOCAL_HEAD = 'c2bc3cc636ce53719f52688093ea892b9c8639c1', 'e762a9c5f523cf7fcb6d68118ca459290926f8fa'
UBASE, UHEAD = 'adf9c5bbf40483f6270048165a55ec7700ea9155', '7752a4239b3bec2cf452491cd1b95164a8c2bdb8'
env = {**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
git = lambda repo, *a: subprocess.check_output(['git', '-C', str(repo), *a], env=env)
def name_status(repo, a, b):
    out = git(repo, 'diff', '--no-renames', '--name-status', '-z', a, b).split(b'\0')
    return {out[i+1].decode(): out[i].decode() for i in range(0, len(out)-1, 2)}
committed = name_status(M, BASE, LOCAL_HEAD)
upstream = name_status(U, UBASE, UHEAD)
working = {}
for e in git(M, 'status', '--porcelain=v1', '-z', '-uall', '--no-renames').split(b'\0'):
    if e: working[e[3:].decode()] = e[:2].decode()
# Sensitive by PATH only (never opened). Conservative: anything matching is excluded from the candidate unless it is an
# already-tracked source file whose name merely contains a word (listed separately as 'nameMatchTracked' for review).
SENSITIVE = [
    (r'(^|/)\.env($|\.|/)', 'dotenv'), (r'\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$', 'key-material'),
    (r'(^|/)(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$', 'ssh-key'), (r'(^|/)\.(npmrc|netrc|pgpass|git-credentials)$', 'credential-file'),
    (r'\.(db|sqlite3?|db-wal|db-shm|ldb|leveldb|mdb)$', 'database'), (r'(^|/)(state|runtime-state|data|backups?|private-backup)(/|$)', 'state-dir'),
    (r'(secret|credential|password|privkey|private[-_]?key|mnemonic|seed[-_]?phrase|wallet[-_]?key|operator[-_]?key)', 'secret-name'),
    (r'(^|/)(journal|.*\.journal)$', 'journal'), (r'\.(log|out|err|pid|sock)$', 'runtime-output'),
]
def classify(p):
    return [tag for rx, tag in SENSITIVE if re.search(rx, p, re.I)]
def lst(p):
    try:
        s = os.lstat(M/p); return {'mode': oct(s.st_mode), 'bytes': s.st_size, 'symlink': stat.S_ISLNK(s.st_mode)}
    except FileNotFoundError:
        return {'missing': True}
tracked_at_head = set(git(M, 'ls-tree', '-r', '-z', '--name-only', LOCAL_HEAD).decode().split('\0')) - {''}
rows = {}
for p in sorted(set(committed) | set(working)):
    r = {'committed': committed.get(p), 'working': working.get(p), 'upstream': upstream.get(p), 'trackedAtLocalHead': p in tracked_at_head,
         **lst(p), 'sensitive': classify(p)}
    rows[p] = r
for p in upstream:
    rows.setdefault(p, {'committed': None, 'working': None, 'upstream': upstream[p], **lst(p), 'sensitive': classify(p)})
flag = {p: r for p, r in rows.items() if r['sensitive']}
big = {p: r['bytes'] for p, r in rows.items() if r.get('bytes', 0) > 5 * 1024 * 1024}
both = sorted(p for p in upstream if rows[p]['committed'] or rows[p]['working'])
summary = {'localCommittedPaths': len(committed), 'workingEntries': len(working), 'untracked': sum(v == '??' for v in working.values()),
           'workingModified': sum(v.strip() == 'M' for v in working.values()), 'workingDeleted': sum('D' in v for v in working.values()),
           'upstreamPaths': upstream, 'touchedByBothSides': both, 'unionPaths': len(rows), 'sensitiveByPath': len(flag), 'over5MiB': big}
json.dump({'summary': summary, 'sensitiveByPath': flag, 'paths': rows}, open(HERE/'path-inventory.json', 'w'), indent=1)
print(json.dumps(summary, indent=1))
for p, r in sorted(flag.items()): print('SENSITIVE?', r['sensitive'], 'committed' if r['committed'] else '', r['working'] or '', p)

"""frozen-0931 derived inputs (deterministic, read-only on their sources). "0931" is this batch's IDENTIFIER = its actual start,
2026-10-23T09:31Z (date -u), not a publication time.
1. log digests (per job: sha256/size of the full log, rc, guard line and only queue/summary/failure/skip/scan lines; raw logs stay
   local) of B's runtime-final jobs, F's host-service-rpc-closure, C's storage-write-release (now through the database-drain round)
   and D's windows-upgrade-delta-review;
2. dated snapshots of root's two living documents, whose earlier bytes are already in the manifest under their own paths
   (append-only by source path)."""
from pathlib import Path
import hashlib, re, shutil
sp = Path(__file__).resolve().parent; base = sp.parent; work = base.parent
keep = re.compile(r'^\s*(\[queue\]|\[memory-guard\]|\[q\.sh\]|ℹ (tests|pass|fail|skipped|cancelled|todo)|✖ |# (pass|fail|skip|tests)|not ok |\[V[01]\]|.*KILLED|.*SURVIVED|.*killed|.*no leaks|.*scan-crypto-keys|\[job\]|.*exit=|Ran \d+ tests|OK|FAILED|.*PASS|.*FAIL|.*-DONE|.*-OK)')
def digest(d, title, out):
    lines = [f'# {title}; generated from {d.relative_to(work)}; full logs stay local.']
    for job in sorted({p.name.split('.')[0] for p in d.iterdir() if p.is_file() and not p.name.endswith(('.sh', '.py', '.mjs'))}):
        o = d / f'{job}.out'; g = d / f'{job}.guard.log'; rc = d / f'{job}.rc'
        data = o.read_bytes() if o.exists() else b''
        tries = sorted(p.name for p in d.iterdir() if p.name.startswith(job + '.try'))
        lines.append(f"\n## {job}  out-sha256 {hashlib.sha256(data).hexdigest()}  bytes {len(data)}  rc {rc.read_text().strip() if rc.exists() else 'absent'}"
                     + (f"  not-started-tries-kept {len(tries)}" if tries else ''))
        if g.exists(): lines += ['    ' + l for l in g.read_text().splitlines()]
        lines += ['    ' + l.rstrip()[:240] for l in data.decode('utf-8', 'replace').splitlines() if keep.match(l)][:80]
    (sp / out).write_text('\n'.join(lines) + '\n')
digest(base / 'rpc-runtime-final-integration/jobs', 'B rpc-runtime-final-integration (c31e975a) job log digest', 'frozen-0931-b-runtime-test-evidence.txt')
digest(base / 'host-service-rpc-closure/logs', 'F host-service-rpc-closure (14d1e495) job log digest', 'frozen-0931-f-rpc-closure-test-evidence.txt')
digest(base / 'storage-write-release/logs', 'C storage-write-release (through 5293405/19b9148) job log digest', 'frozen-0931-c-drain-test-evidence.txt')
digest(base / 'windows-upgrade-delta-review/rawlogs', 'D windows-upgrade-delta-review job log digest', 'frozen-0931-d-review-test-evidence.txt')
snap = sp / 'snapshots-0931'; snap.mkdir(exist_ok=True)
for src, name in ((sp / 'ROOT-PENDING-LATEST.txt', 'ROOT-PENDING-LATEST.snapshot-0931.txt'), (work / 'effective-goal-requirements.txt', 'effective-goal-requirements.snapshot-0931.txt')):
    t = snap / name
    if not t.exists(): shutil.copyfile(src, t)        # first copy wins: a re-run never moves a pinned snapshot
    print(name, hashlib.sha256(t.read_bytes()).hexdigest())

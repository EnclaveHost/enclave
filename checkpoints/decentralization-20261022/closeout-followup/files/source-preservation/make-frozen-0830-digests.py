"""frozen-0830 derived inputs (deterministic, read-only on their sources):
1. log digests of F's final compose (host-services-final-compose/logs) and C's storage-write-release (logs/): per job the
   sha256/size of each full log, its rc, guard line and only queue/summary/failure/skip/scan lines (raw logs stay local);
2. dated snapshots of root's two living documents (ROOT-PENDING-LATEST.txt, effective-goal-requirements.txt), whose earlier
   bytes are already in the manifest under their own paths (append-only by source path)."""
from pathlib import Path
import hashlib, re, shutil, sys
sp = Path(__file__).resolve().parent; base = sp.parent; work = base.parent
keep = re.compile(r'^\s*(\[queue\]|\[memory-guard\]|ℹ (tests|pass|fail|skipped|cancelled|todo)|✖ |# (pass|fail|skip|tests)|.*KILLED|.*SURVIVED|.*killed|.*no leaks|.*scan-crypto-keys|\[job\]|.*exit=|Ran \d+ tests|OK|FAILED|.*PASS|.*FAIL)')
def digest(d, title, out):
    lines = [f'# {title}; generated from {d.relative_to(work)}; full logs stay local.']
    for job in sorted({p.name.split('.')[0] for p in d.iterdir() if p.is_file()}):
        o = d / f'{job}.out'; g = d / f'{job}.guard.log'; rc = d / f'{job}.rc'
        data = o.read_bytes() if o.exists() else b''
        lines.append(f"\n## {job}  out-sha256 {hashlib.sha256(data).hexdigest()}  bytes {len(data)}  rc {rc.read_text().strip() if rc.exists() else 'absent'}")
        if g.exists(): lines += ['    ' + l for l in g.read_text().splitlines()]
        lines += ['    ' + l.rstrip()[:240] for l in data.decode('utf-8', 'replace').splitlines() if keep.match(l)][:80]
    (sp / out).write_text('\n'.join(lines) + '\n')
digest(base / 'host-services-final-compose/logs', 'F host-services-final-compose (4106c311) job log digest', 'frozen-0830-f-final-test-evidence.txt')
digest(base / 'storage-write-release/logs', 'C storage-write-release (6fd7a929/bbf0a009) job log digest', 'frozen-0830-c-storage-test-evidence.txt')
snap = sp / 'snapshots-0830'; snap.mkdir(exist_ok=True)
for src, name in ((sp / 'ROOT-PENDING-LATEST.txt', 'ROOT-PENDING-LATEST.snapshot-0830.txt'), (work / 'effective-goal-requirements.txt', 'effective-goal-requirements.snapshot-0830.txt')):
    t = snap / name
    if not t.exists(): shutil.copyfile(src, t)        # first copy wins: a re-run never moves a pinned snapshot
    print(name, hashlib.sha256(t.read_bytes()).hexdigest())

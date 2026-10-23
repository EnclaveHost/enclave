"""frozen-1517 ("1517" = batch start 2026-10-23T15:17Z, an identifier): dated snapshots of root's two living documents (the
journal ROOT-PENDING-LATEST.txt and effective-goal-requirements.txt), whose earlier bytes are already in the manifest under their own
paths (append-only by source path). First copy wins: a re-run never moves a pinned snapshot."""
from pathlib import Path
import hashlib, shutil
sp = Path(__file__).resolve().parent; work = sp.parent.parent
snap = sp / 'snapshots-1517'; snap.mkdir(exist_ok=True)
for src, name in ((sp / 'ROOT-PENDING-LATEST.txt', 'ROOT-PENDING-LATEST.snapshot-1517.txt'), (work / 'effective-goal-requirements.txt', 'effective-goal-requirements.snapshot-1517.txt')):
    t = snap / name
    if not t.exists(): shutil.copyfile(src, t)
    print(name, hashlib.sha256(t.read_bytes()).hexdigest())

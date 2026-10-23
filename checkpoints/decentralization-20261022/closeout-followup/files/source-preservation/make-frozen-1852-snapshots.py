"""frozen-1852 ("1852" = batch start 2026-10-23T18:52Z, an identifier; snapshots taken 18:54:24Z): dated snapshots of root's living documents
(the journals ROOT-PENDING-LATEST.txt and ROOT-CONTINUE-LATEST.txt, and effective-goal-requirements.txt), whose earlier bytes are already
in the manifest under their own paths (append-only by source path). First copy wins: a re-run never moves a pinned snapshot."""
from pathlib import Path
import hashlib, shutil
sp = Path(__file__).resolve().parent; work = sp.parent.parent
snap = sp / 'snapshots-1852'; snap.mkdir(exist_ok=True)
for src, name in ((sp / 'ROOT-PENDING-LATEST.txt', 'ROOT-PENDING-LATEST.snapshot-1852.txt'),
                  (sp.parent / 'ROOT-CONTINUE-LATEST.txt', 'ROOT-CONTINUE-LATEST.snapshot-1852.txt'),
                  (work / 'effective-goal-requirements.txt', 'effective-goal-requirements.snapshot-1852.txt')):
    t = snap / name
    if not t.exists(): shutil.copyfile(src, t)
    print(name, hashlib.sha256(t.read_bytes()).hexdigest())

"""frozen-2246 ("2246" = batch start 2026-10-23T22:46:00Z, an identifier): a dated snapshot of root's living public output
outputs/decentralization-audit/custody-v2-live-verification-20261023.md, as it stood at 22:42:35Z (sha256 pinned below). Its earlier
stored bytes (23c9aeba original, the 2025 snapshot a033b002, the 2100 snapshot d687b10d) stay stored unchanged. First copy wins."""
from pathlib import Path
import hashlib, shutil
sp = Path(__file__).resolve().parent; work = sp.parent.parent
h = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
src = work.parent / 'outputs/decentralization-audit/custody-v2-live-verification-20261023.md'
PIN = 'd57763d11d84185a'
snap = sp / 'snapshots-2246'; snap.mkdir(exist_ok=True); t = snap / 'custody-v2-live-verification-20261023.snapshot-2246.md'
if not t.exists():
    assert h(src).startswith(PIN), f'the output moved past its 22:42 version ({h(src)[:16]}): not snapshotting a different state'
    assert h(src) != h(sp / 'snapshots-2100/custody-v2-live-verification-20261023.snapshot-2100.md')
    shutil.copyfile(src, t)
assert h(t).startswith(PIN); print(t.name, h(t))

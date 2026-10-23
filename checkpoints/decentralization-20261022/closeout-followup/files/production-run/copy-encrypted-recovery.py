"""Copy only the pinned encrypted recovery archive to the attached array; no keys."""
import datetime
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUN = '20261022T195643Z-c16c22ef'
NAME = f'sia-direct-recovery-{RUN}.tar.gpg'
SHA = '3cfb4f12991b3588d6c9b1317e08ef9613bac349f1a60073a2d835cad326c335'
src = ROOT / 'work/private/sia-direct-recovery' / RUN / NAME
body = src.read_bytes()
if hashlib.sha256(body).hexdigest() != SHA:
    raise SystemExit('Source archive hash mismatch')
base = Path('/mnt/usb')
if not os.path.ismount(base) or base.is_symlink():
    raise SystemExit('Expected attached storage mount absent')
d = base / 'enclave-cold-recovery' / RUN
for part in (d.parent, d):
    if part.is_symlink():
        raise SystemExit('Refusing symlink destination')
d.mkdir(parents=True, exist_ok=True)
dst = d / NAME
if dst.is_symlink():
    raise SystemExit('Refusing symlink archive')
if not dst.exists():
    with dst.open('xb') as f:
        f.write(body)
        f.flush()
        os.fsync(f.fileno())
if hashlib.sha256(dst.read_bytes()).hexdigest() != SHA:
    raise SystemExit('Destination archive hash mismatch; preserved for inspection')
r = dict(at=datetime.datetime.now(datetime.timezone.utc).isoformat(), archive=NAME,
         sha256=SHA, bytes=dst.stat().st_size, destination=str(dst), verifiedReadback=True,
         plaintextSecretsCopied=False, passphraseRemainsOnWorkstation=True,
         failureDomain='Separate attached storage device, same workstation/site; not offsite or complete cold recovery')
receipt = json.dumps(r, indent=2) + '\n'
(d / 'receipt.json').write_text(receipt)
(ROOT / 'outputs/decentralization-audit/storage-cold-recovery-second-device-20261023.json').write_text(receipt)
print(receipt, end='')

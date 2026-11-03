"""Remove stale `base snapshot download` partials from a Base data disk and return the space.

python3 -I rpc/snp/base_cache_prune.py WORK_DIR BASE_QCOW2 FS_UUID NAME:BYTES [NAME:BYTES ...]

`base snapshot download` resumes into data/.download-cache/*.part. Once the snapshot is
extracted nothing reads them, but inside the qcow2 they still hold host space (the
production disk held 795 GB, including a 761 GB state.tar.zst.part, which pushed /vm
under the enclave's disk-guard floor). Each NAME must be a regular file directly in
data/.download-cache ending in .part, with exactly BYTES bytes, or nothing is removed.
The helper VM (base_history_backfill.helper_vm) attaches the disk with discard=unmap
and runs fstrim, so the freed extents are punched out of the qcow2 on the host.
A receipt (enclave-base-cache-prune/1) is written to the disk root and to WORK_DIR.

The disk must not be attached to any other VM while this runs.
"""
import json
from pathlib import Path
import sys
import time

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from base_history_backfill import helper_vm  # noqa: E402
from build_image import BOOT_SHA256, BOOT_VHDX, sha  # noqa: E402

GUEST = r'''
import json, os, pathlib, stat, subprocess, sys
want = json.load(open('/opt/backfill/prune.json'))
cache = pathlib.Path('/mnt/base/data/.download-cache')
for name, size in want.items():
    st = os.lstat(cache/name)
    if '/' in name or not name.endswith('.part') or not stat.S_ISREG(st.st_mode) or st.st_size != size:
        raise SystemExit('refusing: %s is not the expected %d-byte partial' % (name, size))
for name in want:
    os.unlink(cache/name)
os.sync()
trim = subprocess.run(['fstrim', '-v', '/mnt/base'], check=True, capture_output=True, text=True).stdout.strip()
receipt = {'format': 'enclave-base-cache-prune/1', 'removed': want, 'fstrim': trim}
path = pathlib.Path('/mnt/base/cache-prune-%d.json' % int(os.environ['PRUNE_AT']))
path.write_text(json.dumps(receipt, indent=1) + '\n'); os.chmod(path, 0o644)
os.sync()
print(json.dumps(receipt))
'''


def main(work, disk, uuid, *items):
    work, disk = Path(work), Path(disk)
    want = {}
    for item in items:
        name, size = item.rsplit(':', 1)
        want[name] = int(size)
    if not want:
        raise ValueError('nothing to prune')
    work.mkdir(mode=0o700)
    if sha(BOOT_VHDX) != BOOT_SHA256:
        raise ValueError('Pinned boot image changed')
    at = int(time.time())
    before = disk.stat().st_blocks * 512
    receipt_path = helper_vm(work, disk, 'base-cache-prune-%d' % at, [
        'mkdir -p /mnt/base', 'mount -o noatime UUID=%s /mnt/base' % uuid,
        'PRUNE_AT=%d python3 -I /opt/backfill/prune.py' % at,
        'cp /mnt/base/cache-prune-%d.json /mnt/results/receipt.json' % at,
        'umount /mnt/base', 'sync',
    ], [('/opt/backfill/prune.json', json.dumps(want).encode(), '0644'), ('/opt/backfill/prune.py', GUEST.encode(), '0644')])
    result = {'disk': str(disk), 'removed': want, 'hostBytesBefore': before, 'hostBytesAfter': disk.stat().st_blocks * 512,
              'receiptSha256': sha(receipt_path)}
    (work/'RESULT.json').write_text(json.dumps(result, indent=1)+'\n')
    print(json.dumps(result))


if __name__ == '__main__':
    main(*sys.argv[1:])

"""Punch holes in an unmounted ext4 image over the blocks its bitmaps mark free.

python3 -I punchfree.py RAW_IMAGE [--dry-run]

RAW_IMAGE is the writable raw view (qemu-storage-daemon FUSE export with discard=unmap) of a qcow2
whose filesystem e2fsck -fn has just found clean, so the free-block bitmaps are authoritative.
Ranges are shrunk inward to 64 KiB (qcow2 cluster) alignment; smaller ones are skipped.
"""
import ctypes, os, re, subprocess, sys, time

ALIGN = 64 << 10
libc = ctypes.CDLL(None, use_errno=True)
libc.fallocate.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_long, ctypes.c_long]
PUNCH = 0x02 | 0x01   # FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE

img, dry = sys.argv[1], '--dry-run' in sys.argv
out = subprocess.run(['dumpe2fs', img], capture_output=True, text=True, check=True).stdout
if not re.search(r'^Filesystem state:\s+clean$', out, re.M):
    raise SystemExit('filesystem not clean')
if 'needs_recovery' in re.search(r'^Filesystem features:(.*)$', out, re.M).group(1):
    raise SystemExit('journal needs recovery')
bs = int(re.search(r'^Block size:\s+(\d+)', out, re.M).group(1))
ranges = []
for line in out.splitlines():
    s = line.strip()
    if not s.startswith('Free blocks: '):
        continue
    for part in s[len('Free blocks: '):].split(','):
        part = part.strip()
        if not part:
            continue
        a, _, b = part.partition('-')
        a = int(a); b = int(b or a)
        if ranges and ranges[-1][1] + 1 == a:
            ranges[-1][1] = b
        else:
            ranges.append([a, b])
total_free = sum(b - a + 1 for a, b in ranges) * bs
sb_free = int(re.search(r'^Free blocks:\s+(\d+)', out, re.M).group(1)) * bs
fd = os.open(img, os.O_RDWR)
punched = n = 0; t = time.time()
for a, b in ranges:
    start = -(-a * bs // ALIGN) * ALIGN
    end = (b + 1) * bs // ALIGN * ALIGN
    if end <= start:
        continue
    if not dry and libc.fallocate(fd, PUNCH, start, end - start) != 0:
        raise OSError(ctypes.get_errno(), 'fallocate at %d' % start)
    punched += end - start; n += 1
os.close(fd)
G = 2**30
print('bitmap free %.1f GiB (superblock %.1f GiB), %d ranges, %s %.1f GiB in %.0f s'
      % (total_free / G, sb_free / G, n, 'would punch' if dry else 'punched', punched / G, time.time() - t), flush=True)

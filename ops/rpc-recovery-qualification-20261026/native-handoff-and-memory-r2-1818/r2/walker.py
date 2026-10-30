#!/usr/bin/env python3
"""composite-memory-fixture-stage/r1 walker.py (prepared by Claude 1810; NOT run by Claude). Stdlib only.

The MEASURED child: maps PATH read-only (MAP_SHARED, PROT_READ, MADV_RANDOM like libmdbx for a DB larger than RAM) and touches ONE
byte of EVERY 4 KiB page, in order. It never copies the file into memory and never writes. One JSON line per GiB (progress) and a
final JSON line {scannedBytes, pages, nonzeroPages, seconds}.

    walker.py PATH EXPECTED_BYTES LIMIT_SECONDS
Exit: 0 every page touched and all zero (the sparse fixture); 1 a nonzero page; 2 usage / size mismatch; 3 limit reached (partial)."""
import json, mmap, os, sys, time

PAGE, CHECK_EVERY = 4096, 65536


def main(argv):
    if len(argv) != 4:
        print(json.dumps({"error": "usage: walker.py PATH EXPECTED_BYTES LIMIT_SECONDS"})); return 2
    path, want, limit = argv[1], int(argv[2]), float(argv[3])
    t0 = time.monotonic(); end = t0 + limit
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        size = os.fstat(fd).st_size
        if size != want or want <= 0 or want % PAGE:
            print(json.dumps({"error": f"size {size} != expected {want} (or not a positive multiple of {PAGE})"})); return 2
        m = mmap.mmap(fd, want, flags=mmap.MAP_SHARED, prot=mmap.PROT_READ)
    finally:
        os.close(fd)                                                  # the mapping keeps the file referenced
    pages = nonzero = 0
    next_report, timed_out = 1 << 30, False
    try:
        if hasattr(mmap, "MADV_RANDOM"):
            m.madvise(mmap.MADV_RANDOM)
        for off in range(0, want, PAGE):
            if m[off]:
                nonzero += 1
            pages += 1
            if pages % CHECK_EVERY == 0:
                if off + PAGE >= next_report:
                    print(json.dumps({"progressBytes": off + PAGE, "seconds": round(time.monotonic() - t0, 1)}), flush=True)
                    next_report += 1 << 30
                if time.monotonic() > end:
                    timed_out = True; break
    finally:
        m.close()
    print(json.dumps({"scannedBytes": pages * PAGE, "pages": pages, "nonzeroPages": nonzero, "timedOut": timed_out,
                      "seconds": round(time.monotonic() - t0, 3)}), flush=True)
    if timed_out:
        return 3
    return 0 if pages * PAGE == want and nonzero == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

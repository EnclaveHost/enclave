#!/usr/bin/env python3
"""The SEV kernel hash table, computed the way QEMU computes it, for step 0b+2.

WHY THIS EXISTS SEPARATELY FROM THE BUILD. For the IGVM path the hash table has to be emitted as MEASURED page
data by igvmbuilder rather than written by QEMU at launch, and if any of the three hashes is constructed
differently from QEMU's the firmware refuses - with a message ("Hash comparison failed for initrd") that looks
exactly like a substituted artifact. So the construction is checked OFFLINE, against sev-snp-measure, before any
of it reaches a build.

THE THREE TRAPS, all three verified here rather than assumed:

  cmdline  hashed WITH its terminating NUL. sev_hashes.py: append.encode() + b'\\x00', and an absent cmdline is
           a lone NUL rather than an empty string.
  initrd   hashed as-is, the file's bytes.
  kernel   hashed as the file's bytes. An independent review warned that QEMU hashes setup_data || kernel_data
           AFTER patching the setup header, which would differ from the file - but sev-snp-measure hashes the
           file and its predictions equal live launch measurements on this box (M2 check 1, repeatedly), so for
           this kernel and this QEMU the file's bytes are what is hashed. If that ever stops holding, the
           symptom is a firmware refusal on a kernel nobody touched, and this comment is the place to start.

  usage: hash-table.py <kernel> <initrd> <cmdline> [--area-size N]
         prints the three hashes and the table bytes in hex, and checks them against sev-snp-measure.
"""
import sys, hashlib, argparse

HEADER_GUID = bytes.fromhex('06d63894224fc94cb479a793d411fd21')   # 9438d606-4f22-4cc9-b479-a793d411fd21, LE mixed
CMDLINE_GUID = bytes.fromhex('4de79437abd24833b5b2e8687ca9f0f7')
INITRD_GUID = bytes.fromhex('44baf731895a4224bab0f3db33dd0d0f')
KERNEL_GUID = bytes.fromhex('cd1c85dcfa4bde4dbdaf3ea5f4fcb890')

def entry(guid: bytes, digest: bytes) -> bytes:
    # {guid, u16 length, sha256}: length covers the whole entry
    return guid + (16 + 2 + 32).to_bytes(2, 'little') + digest

def table(kernel: str, initrd: str, cmdline: str, area_size: int = 0) -> tuple[bytes, dict]:
    h = {
        'kernel': hashlib.sha256(open(kernel, 'rb').read()).digest(),
        'initrd': hashlib.sha256(open(initrd, 'rb').read()).digest(),
        # the trap: the terminating NUL is part of what is hashed
        'cmdline': hashlib.sha256(cmdline.encode() + b'\x00').digest(),
    }
    body = entry(CMDLINE_GUID, h['cmdline']) + entry(INITRD_GUID, h['initrd']) + entry(KERNEL_GUID, h['kernel'])
    t = HEADER_GUID + (16 + 2 + 6 + len(body)).to_bytes(2, 'little') + b'\x00' * 6 + body
    if area_size:
        if len(t) > area_size:
            raise SystemExit(f'the table is {len(t)} bytes and the area is {area_size}')
        t += b'\x00' * (area_size - len(t))      # zero padding, so the measurement is reliably calculable
    return t, h

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('kernel'); ap.add_argument('initrd'); ap.add_argument('cmdline')
    ap.add_argument('--area-size', type=int, default=0)
    a = ap.parse_args()
    t, h = table(a.kernel, a.initrd, a.cmdline, a.area_size)
    for k in ('kernel', 'initrd', 'cmdline'):
        print(f'{k:8} {h[k].hex()}')
    print(f'table    {len(t)} bytes')
    print(f'hex      {t.hex()}')
    # and the check that matters: the same three hashes sev-snp-measure would use
    try:
        sys.path.insert(0, '/home/steven/.local/lib/python3.14/site-packages')
        from sevsnpmeasure import sev_hashes
        ref = sev_hashes.SevHashes(a.kernel, a.initrd, a.cmdline)
        ok = (bytes(ref.kernel_hash) == h['kernel'] and bytes(ref.initrd_hash) == h['initrd']
              and bytes(ref.cmdline_hash) == h['cmdline'])
        print(f'against sev-snp-measure: {"MATCH on all three" if ok else "DIFFERS - do not build with this"}')
        return 0 if ok else 1
    except ImportError:
        print('against sev-snp-measure: NOT CHECKED (module absent) - check before building')
        return 1

if __name__ == '__main__':
    raise SystemExit(main())

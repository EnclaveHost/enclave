#!/usr/bin/env python3
"""The SEV kernel hash table, computed the way QEMU computes it, for step 0b+2.

WHY THIS EXISTS SEPARATELY FROM THE BUILD. For the IGVM path the hash table has to be emitted as MEASURED page
data by igvmbuilder rather than written by QEMU at launch. Get it wrong and the failure is NOT a refusal: the
firmware's BlobVerifierSevHashes walks the table looking for a per-blob GUID, and if it finds none it says so and
returns EFI_SUCCESS - "If the GUID is not in the hash table, execution can still continue." A table whose header
GUID and length pass the constructor but whose entries are malformed therefore verifies NOTHING while booting
normally, and on a RELEASE build the DEBUG lines that would say so are compiled out. That is the failure this
file exists to catch, and it caught it: an earlier revision of this script had six spurious pad bytes and three
wrong entry GUIDs, and its self-check compared only the three DIGESTS, which matched. The digests being right
says nothing about whether the firmware can find them.

So the check here is WHOLE-TABLE and byte-for-byte against sev-snp-measure's construct_table(), which is the
same reference QEMU's own layout is kept in step with.

THE LAYOUT, from sevsnpmeasure/sev_hashes.py and OvmfPkg/AmdSev/BlobVerifierLibSevHashes:

  SevHashTable is _pack_ = 1 - NO padding after the u16 length. Header GUID (16) + length (2) then three
  50-byte entries back to back, first entry at offset 18, declared length 168 = sizeof(SevHashTable).
  PaddedSevHashTable then rounds the whole thing UP to a 16-byte boundary: 168 -> 176, eight trailing zero
  bytes that are OUTSIDE the declared length. The firmware walks Ptr->Len - 18 = 150 bytes = exactly three
  entries, so the padding is never walked - but it is measured, so it has to be there.

THE THREE HASH TRAPS, all verified here rather than assumed:

  cmdline  hashed WITH its terminating NUL, and an absent cmdline is a lone NUL rather than an empty string.
  initrd   hashed as-is, the file's bytes.
  kernel   hashed as the file's bytes. An independent review first warned that QEMU hashes setup_data ||
           kernel_data AFTER patching the setup header, which would differ from the file. It then found the
           reason it does not: QEMU skips the setup-header patch for ANY confidential guest
           (hw/i386/x86-common.c:955-964), so under -object sev-snp-guest hashing the FILE is the rule, not a
           coincidence of this kernel.

  usage: hash-table.py <kernel> <initrd> <cmdline> [--area-size N] [--compare FILE|--compare-hex HEX]
         --compare/--compare-hex checks a table someone else emitted (igvmbuilder's, extracted from the IGVM)
         against the reference instead of printing a fresh one. Exit status is 0 only on a byte-for-byte match.
"""
import sys, hashlib, argparse, uuid

# Exactly the GUIDs in OvmfPkg/AmdSev/BlobVerifierLibSevHashes/BlobVerifierSevHashes.c. Written as strings and
# converted with uuid.bytes_le rather than transcribed as hex, because hand-transcribing the mixed-endian form
# is precisely how three wrong GUIDs got in here.
HEADER_GUID  = '9438d606-4f22-4cc9-b479-a793d411fd21'
CMDLINE_GUID = '97d02dd8-bd20-4c94-aa78-e7714d36ab2a'
INITRD_GUID  = '44baf731-3a2f-4bd7-9af1-41e29169781d'
KERNEL_GUID  = '4de79437-abd2-427f-b835-d5b172d2045b'

ENTRY_LEN = 16 + 2 + 32          # GUID + u16 length + SHA-256; the length covers the whole entry
TABLE_LEN = 16 + 2 + 3 * ENTRY_LEN   # 168, and this is what the header's length field declares
PADDED_LEN = (TABLE_LEN + 15) & ~15  # 176, PaddedSevHashTable rounds up to 16

def le(guid: str) -> bytes:
    return uuid.UUID('{' + guid + '}').bytes_le

def entry(guid: str, digest: bytes) -> bytes:
    return le(guid) + ENTRY_LEN.to_bytes(2, 'little') + digest

def hashes(kernel: str, initrd: str, cmdline: str) -> dict:
    return {
        'kernel': hashlib.sha256(open(kernel, 'rb').read()).digest(),
        'initrd': hashlib.sha256(open(initrd, 'rb').read() if initrd else b'').digest(),
        'cmdline': hashlib.sha256((cmdline.encode() + b'\x00') if cmdline else b'\x00').digest(),
    }

def table(kernel: str, initrd: str, cmdline: str, area_size: int = 0) -> tuple[bytes, dict]:
    h = hashes(kernel, initrd, cmdline)
    t = le(HEADER_GUID) + TABLE_LEN.to_bytes(2, 'little')
    t += entry(CMDLINE_GUID, h['cmdline'])
    t += entry(INITRD_GUID, h['initrd'])
    t += entry(KERNEL_GUID, h['kernel'])
    assert len(t) == TABLE_LEN, len(t)
    t += b'\x00' * (PADDED_LEN - TABLE_LEN)      # the 16-byte round-up, outside the declared length
    if area_size:
        if len(t) > area_size:
            raise SystemExit(f'the table is {len(t)} bytes and the area is {area_size}')
        t += b'\x00' * (area_size - len(t))      # zero to the area, so the measurement is reliably calculable
    return t, h

def reference(kernel: str, initrd: str, cmdline: str) -> bytes | None:
    """sev-snp-measure's construct_table(), the bytes QEMU's layout is kept in step with."""
    try:
        sys.path.insert(0, '/home/steven/.local/lib/python3.14/site-packages')
        from sevsnpmeasure import sev_hashes
    except ImportError:
        return None
    return bytes(sev_hashes.SevHashes(kernel, initrd, cmdline).construct_table())

def diff(mine: bytes, ref: bytes) -> None:
    for off in range(0, max(len(mine), len(ref)), 16):
        a, b = mine[off:off + 16], ref[off:off + 16]
        if a != b:
            print(f'  +{off:03d} got {a.hex()}')
            print(f'       ref {b.hex()}')

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('kernel'); ap.add_argument('initrd'); ap.add_argument('cmdline')
    ap.add_argument('--area-size', type=int, default=0)
    ap.add_argument('--compare', help='a file holding a table to check against the reference')
    ap.add_argument('--compare-hex', help='the same, as hex')
    a = ap.parse_args()

    ref = reference(a.kernel, a.initrd, a.cmdline)
    if ref is None:
        print('sev-snp-measure is absent, so nothing can be checked - do not build from this')
        return 1

    if a.compare or a.compare_hex:
        got = open(a.compare, 'rb').read() if a.compare else bytes.fromhex(a.compare_hex)
        what = a.compare or 'the given hex'
        # a longer buffer is the area, zero-padded past the table; only the trailing bytes may differ in length
        head, tail = got[:len(ref)], got[len(ref):]
        if head == ref and tail == b'\x00' * len(tail):
            print(f'{what}: {len(got)} bytes, table IDENTICAL to construct_table() '
                  f'({len(ref)} B) and {len(tail)} B of zero padding')
            return 0
        print(f'{what}: {len(got)} bytes, DIFFERS from construct_table() - do not build with this')
        diff(head, ref)
        if tail.strip(b'\x00'):
            print(f'  and the {len(tail)} bytes past the table are not all zero')
        return 1

    t, h = table(a.kernel, a.initrd, a.cmdline, a.area_size)
    for k in ('kernel', 'initrd', 'cmdline'):
        print(f'{k:8} {h[k].hex()}')
    print(f'table    {len(t)} bytes')
    print(f'hex      {t.hex()}')
    ok = t[:len(ref)] == ref and t[len(ref):] == b'\x00' * (len(t) - len(ref))
    print(f'against construct_table(): {"WHOLE TABLE IDENTICAL" if ok else "DIFFERS - do not build with this"}')
    if not ok:
        diff(t[:len(ref)], ref)
    return 0 if ok else 1

if __name__ == '__main__':
    raise SystemExit(main())

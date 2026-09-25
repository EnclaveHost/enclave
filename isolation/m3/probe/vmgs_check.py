#!/usr/bin/env python3
"""vmgs_check.py - what OpenHCL will make of a guest-state file (VMGS) on this host, before booting it.

On a fresh boot OpenHCL opens the VMGS with try_open(format_on_empty=true, format_on_failure=<lifetime is
ReprovisionOnFailure>) (openvmm a7b0bd4 openhcl/underhill_core/src/worker.rs:1864). The NucBox host (26200) has no
GuestStateLifetime setting, so format_on_failure is false there. Any VMGS that is neither EMPTY nor a valid v3 file
therefore fails with "failed to open vmgs". OpenHCL reports that to the host (CompleteStartVtl0), waits two minutes
to be terminated, and panics (vm/devices/get/guest_emulation_transport/src/client.rs:543-566): a started partition,
nothing on COM1, a fatal firmware error at +120 s.

The rules are vmgs_impl.rs validate_header (1609-1645) and read_headers_inner (1530-1570): signature "GUESTRTS",
version exactly 3.0, header_size 168, file_table_offset >= 2 blocks, file_table_size 1, encryption_algorithm <= 1,
and CRC-32 over the 168-byte header with its checksum zeroed. Header 1 is at 0 and header 2 at the disk's sector size
(storage.rs:172-175: 512 on a 512-byte-sector disk, 4096 on a 4K one). The active header has sequence = the other's + 1. A fixed-VHD footer ("conectix", the last 512 bytes) is what Hyper-V wraps the store in.

  python vmgs_check.py <file.vmgs>          prints the format, headers, allocated files and OpenHCL's expected outcome
  python vmgs_check.py --selftest           synthetic empty / V1 / v2 / bad-CRC / encrypted cases

A store that carries file 18 (PROVISIONING_MARKER) with "provisioner":"openhcl" was formatted by OpenHCL's own VM
worker: that worker ran at least through worker.rs:1911 of the boot that formatted it.
"""
import struct, sys, zlib

BLOCK = 4096
HDR = struct.Struct('<QIIII II HH 64s64s I')        # 168 bytes
assert HDR.size == 168
SIG = int.from_bytes(b'GUESTRTS', 'little')
NAMES = {0: 'FILE_TABLE', 1: 'BIOS_NVRAM', 2: 'TPM_PPI', 3: 'TPM_NVRAM', 4: 'RTC_SKEW', 5: 'ATTEST', 6: 'KEY_PROTECTOR',
         7: 'VM_UNIQUE_ID', 8: 'GUEST_FIRMWARE', 9: 'CUSTOM_UEFI', 10: 'GUEST_WATCHDOG', 11: 'HW_KEY_PROTECTOR',
         13: 'GUEST_SECRET_KEY', 14: 'HIBERNATION_TOKEN', 15: 'PLATFORM_SEED', 16: 'PROVENANCE_DOC',
         17: 'TPM_NVRAM_BACKUP', 18: 'PROVISIONING_MARKER', 19: 'TPM_185_NVRAM', 63: 'EXTENDED_FILE_TABLE'}


def header(buf, off):
    f = HDR.unpack_from(buf, off)
    h = dict(zip(('signature', 'version', 'checksum', 'sequence', 'header_size', 'file_table_offset',
                  'file_table_size', 'encryption_algorithm', 'markers', 'key1', 'key2', 'reserved'), f))
    raw = bytearray(buf[off:off + 168]); raw[12:16] = b'\0\0\0\0'
    why = None
    if h['signature'] != SIG: why = 'Invalid header signature'
    elif h['version'] != 0x00030000: why = f"Invalid header version {h['version'] >> 16}.{h['version'] & 0xffff}"
    elif h['header_size'] != 168: why = 'Invalid header size'
    elif h['file_table_offset'] < 2: why = 'Invalid file table offset'
    elif h['file_table_size'] != 1: why = 'Invalid file table size'
    elif h['encryption_algorithm'] > 1: why = 'Invalid encryption algorithm'
    elif zlib.crc32(bytes(raw)) != h['checksum']: why = 'Invalid header checksum'
    h['invalid'] = why
    return h


def examine(data):
    """-> (verdict, lines). verdict: EMPTY | V1 | INVALID | V3-PLAIN | V3-ENCRYPTED"""
    out = []
    if len(data) >= 512 and data[-512:-504] == b'conectix':
        out.append(f'fixed-VHD footer present; store = the first {len(data) - 512} bytes')
        data = data[:-512]
    first = data[:2 * BLOCK]
    if len(first) >= 520 and first[512:520] == b'EFI PART':
        return 'V1', out + ['"EFI PART" at 512: the V1 (GPT) format, which this OpenHCL cannot open (Error::V1Format)']
    # header 2 sits at the sector size: 512 unless that is blank and 4096 is not (a 4K-sector disk)
    h2off = 4096 if (not any(first[512:680]) and any(first[BLOCK:BLOCK + 168])) else 512
    h1, h2 = header(first, 0), header(first, h2off)
    if not any(first[:168]) and not any(first[h2off:h2off + 168]):
        return 'EMPTY', out + ['both headers are zero: an EMPTY store']
    out.append(f'header 2 read at offset {h2off} (sector size)')
    for n, h in ((1, h1), (2, h2)):
        out.append(f"header {n}: sig={'GUESTRTS' if h['signature'] == SIG else hex(h['signature'])} "
                   f"version={h['version'] >> 16}.{h['version'] & 0xffff} seq={h['sequence']} size={h['header_size']} "
                   f"file_table@block {h['file_table_offset']} x{h['file_table_size']} "
                   f"encryption={('NONE', 'AES_GCM')[h['encryption_algorithm']] if h['encryption_algorithm'] < 2 else h['encryption_algorithm']} "
                   f"markers={h['markers']:#x} -> {'VALID' if not h['invalid'] else 'INVALID: ' + h['invalid']}")
    valid = [h for h in (h1, h2) if not h['invalid']]
    if not valid:
        return 'INVALID', out + ['no valid header: OpenHCL fails with InvalidFormat/CorruptFormat']
    if len(valid) == 2:
        if h1['sequence'] == (h2['sequence'] + 1) & 0xffffffff: act = h1
        elif h2['sequence'] == (h1['sequence'] + 1) & 0xffffffff: act = h2
        else: return 'INVALID', out + ['both headers valid but their sequence numbers are not consecutive: CorruptFormat']
    else:
        act = valid[0]
    out.append(f"active header: {1 if act is h1 else 2}")
    ft = data[act['file_table_offset'] * BLOCK: act['file_table_offset'] * BLOCK + BLOCK]
    for i in range(64):
        off, alloc, valid_sz, nonce, tag, attr = struct.unpack_from('<IIQ12s16sI', ft, i * 64)
        if alloc:
            out.append(f"  file {i:2} {NAMES.get(i, '?'):20} blocks@{off} alloc={alloc} valid={valid_sz} "
                       f"encrypted={attr & 1} authenticated={attr >> 1 & 1}")
        if alloc and i == 18 and not attr & 1:
            # PROVISIONING_MARKER: JSON OpenHCL writes right after it formats a store this boot (underhill_core
            # worker.rs:1458-1478, called at 1909-1919): who provisioned it, why, and OpenHCL's own build revision
            raw = data[off * BLOCK: off * BLOCK + min(valid_sz, 4096)]
            out.append(f"  provisioning marker: {raw.decode('utf-8', 'replace')}")
    return ('V3-ENCRYPTED' if act['encryption_algorithm'] == 1 else 'V3-PLAIN'), out


OUTCOME = {
    'EMPTY': 'OpenHCL formats it on this boot ("empty vmgs file, formatting") and provisions: no open failure.',
    'V1': 'OpenHCL: "failed to open vmgs" (V1Format) -> reported to the host -> panic at +120 s. Replace it.',
    'INVALID': 'OpenHCL: "failed to open vmgs" -> reported to the host -> panic at +120 s. Replace it.',
    'V3-PLAIN': 'opens. A KEY_PROTECTOR from another VM id only triggers a TPM seed refresh (not a failure); '
                'without one, OpenHCL provisions as on a first boot.',
    'V3-ENCRYPTED': 'opens, then needs a key to unlock. On this host there is no tenant key (no agent) and the host '
                    'log says "Gsp server unavailable", so expect DisableVmgsEncryptionFailed after 10 retries: fatal. '
                    'A store encrypted for another VM will not unlock. Use an EMPTY or plain v3 store.',
}


def selftest():
    ok = True
    def mk(ver=0x00030000, seq=1, enc=0, crc_ok=True):
        h = bytearray(HDR.pack(SIG, ver, 0, seq, 168, 2, 1, enc, 0, b'\0' * 64, b'\0' * 64, 0))
        h[12:16] = struct.pack('<I', zlib.crc32(bytes(h)) ^ (0 if crc_ok else 1))
        return bytes(h)
    def store(h1, h2):
        b = bytearray(8 * BLOCK); b[0:168] = h1; b[512:680] = h2; return bytes(b)
    v1 = bytearray(8 * BLOCK); v1[512:520] = b'EFI PART'
    cases = [('zeros', bytes(8 * BLOCK), 'EMPTY'), ('V1', bytes(v1), 'V1'),
             ('v3 plain', store(mk(seq=1), mk(seq=2)), 'V3-PLAIN'), ('v3 AES_GCM', store(mk(seq=1, enc=1), mk(seq=2, enc=1)), 'V3-ENCRYPTED'),
             ('v2', store(mk(ver=0x00020000), mk(ver=0x00020000, seq=2)), 'INVALID'),
             ('bad CRC both', store(mk(crc_ok=False), mk(seq=2, crc_ok=False)), 'INVALID'),
             ('one bad CRC', store(mk(seq=1, crc_ok=False), mk(seq=2)), 'V3-PLAIN'),
             ('seq gap', store(mk(seq=1), mk(seq=5)), 'INVALID')]
    k4 = bytearray(8 * BLOCK); k4[0:168] = mk(seq=1); k4[BLOCK:BLOCK + 168] = mk(seq=2)
    cases.append(('4K-sector layout', bytes(k4), 'V3-PLAIN'))
    for name, data, want in cases:
        got, _ = examine(data)
        print(f"{'PASS' if got == want else 'FAIL'} {name}: {got}")
        ok &= got == want
    return 0 if ok else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        sys.exit(selftest())
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    verdict, lines = examine(open(sys.argv[1], 'rb').read())
    print('\n'.join(lines))
    print(f'VERDICT {verdict}: {OUTCOME[verdict]}')

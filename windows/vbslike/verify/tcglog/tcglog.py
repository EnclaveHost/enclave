#!/usr/bin/env python3
"""tcglog.py - read a Windows measured-boot log (TCG PC Client crypto-agile format) and check it.

Read-only. Written for the nucbox-k11 trust-root review (windows/vbslike/evidence/trust-root-2026-09-25.md).

  tcglog.py policy  <log>             the security-relevant Windows (SIPA) events and the Secure Boot variable
  tcglog.py keys    <log>             the VSM IDK / IDKS public keys the secure kernel logged
  tcglog.py replay  <log> <pcrs.txt>  replay SHA-256 into PCRs 0-14 and compare with values read from the TPM
                                      (pcrs.txt = lines "PCRnn sha256 <hex>", from ops/tpm-pcr-read.ps1), then run
                                      two negative controls that MUST be detected

SIPA event names are Microsoft's (wbcl.h; values confirmed from the Win32 metadata bindings). A name not in the
table prints as UNNAMED with its raw value - it is never guessed.
"""
import hashlib, re, struct, sys

NAMES = {
    0x40001: 'BOOTDEBUGGING', 0x40002: 'BOOT_REVOCATION_LIST',
    0x50001: 'OSKERNELDEBUG', 0x50002: 'CODEINTEGRITY', 0x50003: 'TESTSIGNING', 0x50004: 'DATAEXECUTIONPREVENTION',
    0x50005: 'SAFEMODE', 0x50006: 'WINPE', 0x50007: 'PHYSICALADDRESSEXTENSION', 0x50008: 'OSDEVICE', 0x50009: 'SYSTEMROOT',
    0x5000a: 'HYPERVISOR_LAUNCH_TYPE', 0x5000b: 'HYPERVISOR_PATH', 0x5000c: 'HYPERVISOR_IOMMU_POLICY',
    0x5000d: 'HYPERVISOR_DEBUG', 0x5000e: 'DRIVER_LOAD_POLICY', 0x5000f: 'SI_POLICY',
    0x50010: 'HYPERVISOR_MMIO_NX_POLICY', 0x50011: 'HYPERVISOR_MSR_FILTER_POLICY', 0x50012: 'VSM_LAUNCH_TYPE',
    0x50013: 'OS_REVOCATION_LIST', 0x50014: 'SMT_STATUS', 0x50020: 'VSM_IDK_INFO', 0x50023: 'VSM_IDKS_INFO',
    0x50028: 'LSAISO_CONFIG', 0x50029: 'SBCP_INFO',
    0xa0001: 'VBS_VSM_REQUIRED', 0xa0002: 'VBS_SECUREBOOT_REQUIRED', 0xa0003: 'VBS_IOMMU_REQUIRED',
    0xa0004: 'VBS_MMIO_NX_REQUIRED', 0xa0005: 'VBS_MSR_FILTERING_REQUIRED', 0xa0006: 'VBS_MANDATORY_ENFORCEMENT',
    0xa0007: 'VBS_HVCI_POLICY', 0xa0008: 'VBS_MICROSOFT_BOOT_CHAIN_REQUIRED', 0xa0009: 'VBS_DUMP_USES_AMEROOT',
    0xa000a: 'VBS_VSM_NOSECRETS_ENFORCED',
}
SHA256 = 0x000b

def parse(b):
    """-> list of events {n, pcr, type, dig{alg: (offset, bytes)}, data}"""
    off = 0
    _pcr, _et, _d, esz = struct.unpack_from('<II20sI', b, off); off += 32
    spec = b[off:off + esz]; off += esz
    if not spec.startswith(b'Spec ID Event03'):
        raise SystemExit('not a crypto-agile TCG log')
    nalg = struct.unpack_from('<I', spec, 24)[0]; sizes = {}
    for i in range(nalg):
        a, s = struct.unpack_from('<HH', spec, 28 + 4 * i); sizes[a] = s
    evs = []; n = 0
    while off < len(b):
        pcr, et, cnt = struct.unpack_from('<III', b, off); off += 12
        dig = {}
        for _ in range(cnt):
            a = struct.unpack_from('<H', b, off)[0]; dig[a] = (off + 2, b[off + 2:off + 2 + sizes[a]]); off += 2 + sizes[a]
        esz = struct.unpack_from('<I', b, off)[0]; off += 4
        n += 1; evs.append(dict(n=n, pcr=pcr, type=et, dig=dig, data=b[off:off + esz])); off += esz
    return evs

def sipa(buf):
    """Walk Windows SIPA events inside an EV_EVENT_TAG, recursing into containers/aggregations."""
    off = 0
    while off + 8 <= len(buf):
        t, n = struct.unpack_from('<II', buf, off); off += 8
        data = buf[off:off + n]; off += n
        yield t, data
        if t & 0x40000000 or (t & 0x000F0000) == 0x00010000:
            yield from sipa(data)

def cmd_policy(path):
    for e in parse(open(path, 'rb').read()):
        if e['type'] == 0x80000001:                       # EV_EFI_VARIABLE_DRIVER_CONFIG
            d = e['data']; nl, dl = struct.unpack_from('<QQ', d, 16)
            name = d[32:32 + 2 * nl].decode('utf-16-le'); val = d[32 + 2 * nl:32 + 2 * nl + dl]
            print('ev%-3d pcr%-2d UEFI %-32s %s' % (e['n'], e['pcr'], name, val.hex() if dl <= 4 else '%d bytes' % dl))
        if e['type'] != 0x6:
            continue
        for t, data in sipa(e['data']):
            base = t & 0x0FFFFFFF
            if (base & 0xF0000) not in (0x40000, 0x50000, 0xa0000):
                continue
            name = NAMES.get(base, 'UNNAMED 0x%05x' % base)
            print('ev%-3d pcr%-2d SIPA %-32s %s' % (e['n'], e['pcr'], name, data.hex() if len(data) <= 8 else '%d bytes' % len(data)))

def cmd_keys(path):
    for e in parse(open(path, 'rb').read()):
        if e['type'] != 0x6:
            continue
        for t, data in sipa(e['data']):
            if t in (0x50020, 0x50023):
                alg, bits, explen, modlen = struct.unpack_from('<IIII', data, 0)
                exp = data[16:16 + explen]; mod = data[16 + explen:16 + explen + modlen]
                print('ev%d pcr%d %s: KeyAlgID=%d bits=%d exponent=%s modulus_sha256=%s' % (
                    e['n'], e['pcr'], NAMES[t], alg, bits, exp.hex(), hashlib.sha256(mod).hexdigest()))

def replay(evs, check_tag_data=True):
    pcrs = {i: b'\0' * 32 for i in range(24)}; problems = []
    for e in evs:
        if e['type'] == 0x3:                               # EV_NO_ACTION is not extended
            if e['pcr'] == 0 and e['data'].startswith(b'StartupLocality\0'):
                pcrs[0] = b'\0' * 31 + bytes([e['data'][16]])
            continue
        d = e['dig'][SHA256][1]
        # Windows' tagged events are measured as the hash of their data. A verifier READS that data (the IDKS
        # key, the testsigning flag), so it must hash to the digest that went into the PCR.
        if check_tag_data and e['type'] == 0x6 and hashlib.sha256(e['data']).digest() != d:
            problems.append('ev%d pcr%d: EV_EVENT_TAG data does not hash to its logged digest' % (e['n'], e['pcr']))
        pcrs[e['pcr']] = hashlib.sha256(pcrs[e['pcr']] + d).digest()
    return pcrs, problems

def cmd_replay(path, pcrfile):
    tpm = {int(m.group(1)): m.group(2) for m in re.finditer(r'PCR(\d\d) sha256 ([0-9a-f]{64})', open(pcrfile).read())}
    b = open(path, 'rb').read(); evs = parse(b)
    mism = lambda p: [i for i in range(15) if p[i].hex() != tpm.get(i)]
    p, pr = replay(evs)
    print('POSITIVE: PCRs 0-14 differing from the TPM: %s; tagged-data problems: %s' % (mism(p) or 'none', pr or 'none'))
    ok = not mism(p) and not pr
    k = b.find(struct.pack('<I', 0x00050023)); assert k > 0, 'no IDKS record'
    m1 = bytearray(b); m1[k + 8 + 16 + 3 + 10] ^= 1           # one byte of the IDKS modulus, digests untouched
    _, pr1 = replay(parse(bytes(m1)))
    print('NEGATIVE 1 (one IDKS modulus byte changed): detected=%s %s' % (bool(pr1), pr1))
    e = [x for x in evs if x['type'] == 0x6 and struct.pack('<I', 0x00050023) in x['data']][0]
    m2 = bytearray(b); m2[e['dig'][SHA256][0]] ^= 1            # that event's logged digest changed
    p2, _ = replay(parse(bytes(m2)), check_tag_data=False)
    print('NEGATIVE 2 (the IDKS event digest changed): detected=%s PCRs differing: %s' % (bool(mism(p2)), mism(p2)))
    ok = ok and bool(pr1) and bool(mism(p2))
    print('RESULT:', 'PASS (replay matches; both forgeries detected)' if ok else 'FAIL')
    return 0 if ok else 1

if __name__ == '__main__':
    c = sys.argv[1] if len(sys.argv) > 1 else ''
    if c == 'policy': cmd_policy(sys.argv[2])
    elif c == 'keys': cmd_keys(sys.argv[2])
    elif c == 'replay': sys.exit(cmd_replay(sys.argv[2], sys.argv[3]))
    else: print(__doc__); sys.exit(2)

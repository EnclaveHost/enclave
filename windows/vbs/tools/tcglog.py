#!/usr/bin/env python3
"""Parse a Windows measured-boot TCG log (C:\\Windows\\Logs\\MeasuredBoot\\*.log), replay the SHA-256 PCRs,
and decode the Windows SIPA records that a consumer-node verifier needs.  Names follow the SDK's wbcl.h.
Usage: tcglog.py LOG [--dump]"""
import struct, sys, hashlib, collections

EV = {3:'NO_ACTION',4:'SEPARATOR',5:'ACTION',6:'EVENT_TAG',8:'S_CRTM_VERSION',0xc:'COMPACT_HASH',0x80000001:'EFI_VARIABLE_DRIVER_CONFIG',
      0x80000002:'EFI_VARIABLE_BOOT',0x80000003:'EFI_BOOT_SERVICES_APPLICATION',0x80000004:'EFI_BOOT_SERVICES_DRIVER',0x80000006:'EFI_GPT_EVENT',
      0x80000007:'EFI_ACTION',0x8000000a:'EFI_PLATFORM_FIRMWARE_BLOB2',0x8000000b:'EFI_HANDOFF_TABLES2',0x800000e0:'EFI_VARIABLE_AUTHORITY'}
SIPA = {0x40010001:'TRUSTBOUNDARY',0x40010002:'LOADEDMODULE_AGGREGATION',0x40010003:'LOADEDMODULE_AGGREGATION',0xC0010003:'TRUSTPOINT_AGGREGATION',
 0x20001:'INFORMATION',0x20002:'BOOTCOUNTER',0x20003:'TRANSFER_CONTROL',0x20004:'APPLICATION_RETURN',0x20005:'BITLOCKER_UNLOCK',0x20006:'EVENTCOUNTER',
 0x20007:'COUNTERID',0x20008:'MORBIT_NOT_CANCELABLE',0x2000b:'MORBIT_API_STATUS',0x2000c:'IDK_GENERATION_STATUS',0x40001:'BOOTDEBUGGING',
 0x40002:'BOOTREVOCATIONLIST',0x50001:'OSKERNELDEBUG',0x50002:'CODEINTEGRITY',0x50003:'TESTSIGNING',0x50004:'DATAEXECUTIONPREVENTION',0x50005:'SAFEMODE',
 0x50006:'WINPE',0x50008:'OSDEVICE',0x50009:'SYSTEMROOT',0x5000a:'HYPERVISOR_LAUNCH_TYPE',0x5000b:'HYPERVISOR_PATH',0x5000c:'HYPERVISOR_IOMMU_POLICY',
 0x5000d:'HYPERVISOR_DEBUG',0x5000e:'DRIVER_LOAD_POLICY',0x5000f:'SIPOLICY',0x50010:'HYPERVISOR_MMIO_NX_POLICY',0x50011:'HYPERVISOR_MSR_FILTER_POLICY',
 0x50012:'VSM_LAUNCH_TYPE',0x50013:'OS_REVOCATION_LIST',0x50014:'SMT_STATUS',0x50020:'VSM_IDK_INFO',0x50021:'FLIGHTSIGNING',0x50022:'PAGEFILE_ENCRYPTION_ENABLED',
 0x50023:'VSM_IDKS_INFO',0x50024:'HIBERNATION_DISABLED',0x50025:'DUMPS_DISABLED',0x50026:'DUMP_ENCRYPTION_ENABLED',0x50027:'DUMP_ENCRYPTION_KEY_DIGEST',
 0x50028:'LSAISO_CONFIG',0x50029:'SBCP_INFO',0x50030:'HYPERVISOR_BOOT_DMA_PROTECTION',0x50031:'SI_POLICY_SIGNER',0x50032:'SI_POLICY_UPDATE_SIGNER',
 0x5003a:'VSM_SEALED_SI_POLICY',0x5003b:'VSM_DRTM_KEYROLL_DETECTED',0x5003c:'VSM_SRTM_UNSEAL_POLICY',0x5003d:'VSM_SRTM_ANTI_ROLLBACK_COUNTER',0x50040:'VTL1_DUMP_CONFIG',
 0x60001:'NOAUTHORITY',0x60002:'AUTHORITYPUBKEY',0x70001:'FILEPATH',0x70002:'IMAGESIZE',0x70003:'HASHALGORITHMID',0x70004:'AUTHENTICODEHASH',
 0x70005:'AUTHORITYISSUER',0x70006:'AUTHORITYSERIAL',0x70007:'IMAGEBASE',0x70008:'AUTHORITYPUBLISHER',0x70009:'AUTHORITYSHA1THUMBPRINT',0x7000a:'IMAGEVALIDATED',
 0x7000b:'MODULESVN',0x7000c:'MODULE_PLUTON',0x7000d:'MODULE_ORIGINAL_FILENAME',0x7000e:'MODULE_VERSION',0x7000f:'PUBLISHER_OEMNAME',
 0xa0001:'VBS_VSM_REQUIRED',0xa0002:'VBS_SECUREBOOT_REQUIRED',0xa0003:'VBS_IOMMU_REQUIRED',0xa0004:'VBS_NX_REQUIRED',0xa0005:'VBS_MSR_FILTERING_REQUIRED',
 0xa0006:'VBS_MANDATORY_ENFORCEMENT',0xa0007:'VBS_HVCI_POLICY',0xa0008:'VBS_MICROSOFT_BOOT_CHAIN_REQUIRED',0xa0009:'VBS_DUMP_USES_AMEROOT',0xa000a:'VBS_VSM_NOSECRETS_ENFORCED',
 0xc0001:'DRTM_STATE_AUTH',0xc0002:'DRTM_SMM_LEVEL',0xc0003:'DRTM_AMD_SMM_HASH',0xc0004:'DRTM_AMD_SMM_SIGNER_KEY'}
CONTAINERS = {0x40010001,0x40010002,0x40010003,0xC0010003,0x20001}
STRINGS = {0x70001,0x50009,0x5000b,0x70008,0x70005}

def parse(data):
    """Yield (pcr, event_type, {alg: digest}, event_bytes) for a crypto-agile TCG log."""
    off = 0
    pcr, et = struct.unpack_from('<II', data, off); off += 8 + 20
    esz, = struct.unpack_from('<I', data, off); off += 4; hdr = data[off:off+esz]; off += esz
    assert hdr[:15] == b'Spec ID Event03', 'not a TCG 2.0 log'
    nalg, = struct.unpack_from('<I', hdr, 24); algs = {}
    for i in range(nalg):
        a, sz = struct.unpack_from('<HH', hdr, 28 + 4*i); algs[a] = sz
    events = []
    while off < len(data):
        pcr, et, cnt = struct.unpack_from('<III', data, off); off += 12; dig = {}
        for i in range(cnt):
            a, = struct.unpack_from('<H', data, off); off += 2; dig[a] = data[off:off+algs[a]]; off += algs[a]
        esz, = struct.unpack_from('<I', data, off); off += 4; events.append((pcr, et, dig, data[off:off+esz])); off += esz
    return events

def replay(events, alg=0xb):
    pcrs = {}
    for pcr, et, dig, ev in events:
        if alg in dig: pcrs[pcr] = hashlib.sha256(pcrs.get(pcr, b'\0'*32) + dig[alg]).digest()
    return pcrs

def unhashed_events(events, alg=0xb):
    """Events whose recorded digest is NOT the hash of their event data, among the kinds where it must be.
    Windows SIPA records (EV_EVENT_TAG, PCR 11-14) are measured as SHA-256(event data); a log whose event data was
    edited while its digests were kept would replay to the quoted PCRs and still lie, so a verifier must recompute."""
    bad = []
    for i, (pcr, et, dig, ev) in enumerate(events):
        if et == 6 and alg in dig and hashlib.sha256(ev).digest() != dig[alg]: bad.append((i, pcr))
    return bad

def sipa_walk(buf, depth=0):
    """Flatten a SIPA TLV tree into (depth, id, name, value_bytes)."""
    out, off = [], 0
    while off + 8 <= len(buf):
        tid, size = struct.unpack_from('<II', buf, off); off += 8; val = buf[off:off+size]; off += size
        out.append((depth, tid, SIPA.get(tid, 'UNKNOWN_%08x' % tid), val))
        if tid in CONTAINERS: out += sipa_walk(val, depth+1)
    return out

def sipa_fields(events, pcr=12):
    """All scalar SIPA fields measured into a PCR, as {name: [values...]} (a field can appear more than once)."""
    fields = collections.defaultdict(list)
    for p, et, dig, ev in events:
        if et != 6 or p != pcr: continue
        for depth, tid, name, val in sipa_walk(ev):
            if tid in CONTAINERS: continue
            if len(val) in (1, 2, 4, 8): fields[name].append(int.from_bytes(val, 'little'))
            elif tid in STRINGS: fields[name].append(val.decode('utf-16-le', 'replace').rstrip('\0'))
            else: fields[name].append(val)
    return fields

def vsm_key(events, which='IDKS'):
    """The VSM identity public key (RSA modulus, exponent) from the boot log: IDKS signs enclave reports, IDK decrypts."""
    tid = 0x50023 if which == 'IDKS' else 0x50020
    for p, et, dig, ev in events:
        if et != 6: continue
        for depth, t, name, val in sipa_walk(ev):
            if t == tid:
                alg, bits, esz, msz = struct.unpack_from('<IIII', val, 0)
                return int.from_bytes(val[16+esz:16+esz+msz], 'big'), int.from_bytes(val[16:16+esz], 'big'), bits
    return None

def secure_boot_from_log(events):
    """PCR7's EFI_VARIABLE_DRIVER_CONFIG 'SecureBoot' variable: 1 = on."""
    for pcr, et, dig, ev in events:
        if pcr == 7 and et == 0x80000001:
            nl, dl = struct.unpack_from('<QQ', ev, 16); name = ev[32:32+2*nl].decode('utf-16-le', 'replace')
            if name == 'SecureBoot': return ev[32+2*nl]
    return None

if __name__ == '__main__':
    events = parse(open(sys.argv[1], 'rb').read())
    print('events:', len(events), ' secure boot (PCR7):', secure_boot_from_log(events))
    for p, v in sorted(replay(events).items()): print('  PCR%-2d %s' % (p, v.hex()))
    for pcr in (12, 13, 14):
        f = sipa_fields(events, pcr)
        for k in sorted(f):
            vals = f[k]
            if isinstance(vals[0], bytes): s = '%d bytes' % len(vals[0]) + (' x%d' % len(vals) if len(vals) > 1 else '')
            else: s = ', '.join(str(v) for v in vals)
            if '--dump' in sys.argv or pcr == 12 and not k.startswith(('AUTHENTICODE','FILEPATH','IMAGE','HASHALG','AUTHORITY','MODULE')):
                print('  PCR%d %-36s %s' % (pcr, k, s))
    k = vsm_key(events, 'IDKS'); print('  IDKS: RSA-%d modulus sha256=%s' % (k[2], hashlib.sha256(k[0].to_bytes(k[2]//8, 'big')).hexdigest()[:16]) if k else '  no IDKS record')

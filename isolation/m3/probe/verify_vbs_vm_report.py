#!/usr/bin/env python3
"""verify_vbs_vm_report.py - the host half of the VBS report-chain experiment (isolation/m3/VBS-ISOLATION.md).

Input: a VBS VM report (openvmm hvdef::vbs::VbsReport, 0x230 bytes) - raw, or the VBSREPORT hex lines the probe
module (vbsreport.ko) prints on the partition's console - and the measured-boot (TCG) log of the SAME host boot.

The question is only: WHICH KEY SIGNS IT, and is that key one a remote client can reach through the host's
measured boot? The open source defines the report's layout but not its signer. VBS ENCLAVE reports on the same box
verify with the IDKS key the boot log carries (windows/vbs/REPORT.md, measured 2026-09-20). This tries the log's VSM
keys (IDKS 0x50023, IDK 0x50020) over each plausible signed span, with RSA-PSS (salt 32 and auto) and PKCS#1 v1.5,
and says exactly which combination verifies - or that none does. It judges nothing else: freshness, the log's own
replay against a TPM quote, and the EK chain are windows/vbs/tools/verify_vbs_report.py's checks and still required.

  verify_vbs_vm_report.py --serial <console log> --log <TCG log>      a box result
  verify_vbs_vm_report.py --report <report.bin> --log <TCG log>
  verify_vbs_vm_report.py --selftest                                   the span/scheme search on a synthetic report
"""
import argparse, os, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', '..', 'windows', 'vbs', 'tools'))

SIZE = 0x230
MARKER = b'ENCLAVE-VBS-REPORT-PROBE/1'
SPANS = {                      # candidate signed regions, all ending where the signature begins (0x130)
    'header..identity [0x00:0x130]': (0x00, 0x130),
    'version..identity [0x14:0x130]': (0x14, 0x130),
    'report_data..identity [0x18:0x130]': (0x18, 0x130),
    'identity only [0x58:0x130]': (0x58, 0x130),
}
SCHEMES = {'RSA-PSS salt 32': ['-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:32'],
           'RSA-PSS salt auto': ['-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:auto'],
           'RSA PKCS#1 v1.5': []}


def parse(rep):
    if len(rep) < SIZE:
        raise ValueError(f'the report is {len(rep)} bytes; a VbsReport is {SIZE}')
    pkg, ver, scheme, sigsz, _ = struct.unpack_from('<IIIII', rep, 0)
    f = {'package_size': pkg, 'package_version': ver, 'signature_scheme': scheme, 'signature_size': sigsz,
         'version': struct.unpack_from('<I', rep, 0x14)[0], 'report_data': rep[0x18:0x58]}
    o = 0x58
    for k in ('owner_id', 'measurement', 'signer', 'host_data'):
        f[k] = rep[o:o + 32]; o += 32
    (f['enabled_vtl'], f['policy'], f['guest_vtl'], f['guest_svn'], f['guest_product_id'],
     f['guest_module_id']) = struct.unpack_from('<IIIIII', rep, o)
    f['signature'] = rep[0x130:0x130 + 256]
    return f


def from_serial(path):
    """The probe's console lines: 'VBSREPORT <offset> <hex>' ... 'VBSREPORT end len=<n>' (kernel timestamps allowed)."""
    chunks, status = {}, None
    for line in open(path, 'rb').read().decode('latin1').replace('\r', '').splitlines():
        i = line.find('VBSREPORT ')
        if i < 0:
            continue
        rest = line[i + 10:].split()
        if rest and rest[0].startswith('status='):
            status = rest[0][7:]
        elif len(rest) == 2 and len(rest[0]) == 4 and all(c in '0123456789abcdef' for c in rest[0]):
            chunks[int(rest[0], 16)] = bytes.fromhex(rest[1])
    if not chunks:
        raise ValueError(f'no report lines in {path} (hypercall status {status})')
    out = b''.join(chunks[k] for k in sorted(chunks))
    return out, status


def pem_of(n, e, d):
    conf, der, pem = (os.path.join(d, x) for x in ('k.asn1', 'k.der', 'k.pem'))
    open(conf, 'w').write('asn1=SEQUENCE:pub\n[pub]\nn=INTEGER:%d\ne=INTEGER:%d\n' % (n, e))
    subprocess.run(['openssl', 'asn1parse', '-genconf', conf, '-out', der, '-noout'], check=True)
    subprocess.run(['openssl', 'rsa', '-RSAPublicKey_in', '-inform', 'der', '-in', der, '-pubout', '-out', pem],
                   check=True, capture_output=True)
    return pem


def verifies(pem, data, sig, opts, d):
    df, sf = os.path.join(d, 'data'), os.path.join(d, 'sig')
    open(df, 'wb').write(data); open(sf, 'wb').write(sig)
    r = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', pem] + opts + ['-signature', sf, df], capture_output=True, text=True)
    return 'Verified OK' in r.stdout


def search(rep, keys):
    """-> list of (key name, span name, scheme name) that verify, over every key/span/scheme (and the signature as
    stored and byte-reversed, since some Windows signers emit little-endian integers)"""
    hits = []
    sig = parse(rep)['signature']
    with tempfile.TemporaryDirectory() as d:
        for kname, (n, e) in keys.items():
            pem = pem_of(n, e, d)
            for sname, (a, b) in SPANS.items():
                for scname, opts in SCHEMES.items():
                    for order, s in (('', sig), (' (signature byte-reversed)', sig[::-1])):
                        if verifies(pem, rep[a:b], s, opts, d):
                            hits.append((kname, sname, scname + order))
    return hits


def show(f):
    print(f"  package_size={f['package_size']} package_version={f['package_version']} signature_scheme={f['signature_scheme']} "
          f"signature_size={f['signature_size']} version={f['version']}")
    print(f"  report_data={f['report_data'].hex()}  (probe marker {'PRESENT' if f['report_data'].startswith(MARKER) else 'ABSENT'})")
    for k in ('owner_id', 'measurement', 'signer', 'host_data'):
        print(f'  {k}={f[k].hex()}')
    vtl = f['enabled_vtl']
    print(f"  enabled_vtl=vtl0:{vtl & 1} vtl1:{vtl >> 1 & 1} vtl2:{vtl >> 2 & 1}  debug_allowed={f['policy'] & 1}  guest_vtl={f['guest_vtl']} "
          f"guest_svn={f['guest_svn']} product={f['guest_product_id']:#x} module={f['guest_module_id']:#x}")


def selftest():
    """a synthetic report signed over one span with one scheme: the search must find exactly that, and nothing on a
    one-byte change"""
    with tempfile.TemporaryDirectory() as d:
        key = os.path.join(d, 'k.pem')
        subprocess.run(['openssl', 'genrsa', '-out', key, '2048'], check=True, capture_output=True)
        mod = subprocess.run(['openssl', 'rsa', '-in', key, '-noout', '-modulus'], capture_output=True, text=True, check=True).stdout
        n = int(mod.strip().split('=')[1], 16)
        rep = bytearray(SIZE)
        struct.pack_into('<IIIII', rep, 0, SIZE, 1, 1, 256, 0)
        struct.pack_into('<I', rep, 0x14, 1)
        rep[0x18:0x18 + len(MARKER)] = MARKER
        rep[0x78:0x98] = os.urandom(32)                      # measurement
        df, sf = os.path.join(d, 'data'), os.path.join(d, 'sig')
        open(df, 'wb').write(bytes(rep[0x14:0x130]))
        subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key, '-sigopt', 'rsa_padding_mode:pss', '-sigopt',
                        'rsa_pss_saltlen:32', '-out', sf, df], check=True)
        rep[0x130:0x230] = open(sf, 'rb').read()
        hits = search(bytes(rep), {'SELFTEST': (n, 65537)})
        want = ('SELFTEST', 'version..identity [0x14:0x130]', 'RSA-PSS salt 32')
        ok1 = want in hits and all(h[1] == want[1] and h[2].startswith('RSA-PSS') for h in hits)
        rep[0x80] ^= 1
        ok2 = search(bytes(rep), {'SELFTEST': (n, 65537)}) == []
        print(f"selftest: signed span found: {ok1} {hits}; a flipped measurement byte verifies nowhere: {ok2}")
        return 0 if ok1 and ok2 else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--serial'); ap.add_argument('--report'); ap.add_argument('--log'); ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.log or not (a.serial or a.report):
        ap.error('--log and one of --serial/--report are required')
    if a.serial:
        rep, status = from_serial(a.serial)
        print(f'report from the console: hypercall status {status}, {len(rep)} bytes')
    else:
        rep = open(a.report, 'rb').read()
    f = parse(rep)
    show(f)
    import tcglog
    events = tcglog.parse(open(a.log, 'rb').read())
    keys = {}
    for which in ('IDKS', 'IDK'):
        k = tcglog.vsm_key(events, which)
        if k:
            keys[which] = (k[0], k[1])
            print(f'  log key {which}: RSA-{k[2]} modulus {hex(k[0])[2:18]}...')
    if not keys:
        print('RESULT: the log carries no VSM key (IDKS/IDK): nothing to try')
        return 2
    hits = search(rep, keys)
    for h in hits:
        print(f'  VERIFIES: key {h[0]}, span {h[1]}, {h[2]}')
    if hits:
        print(f'RESULT: the VBS VM report is signed by this boot\'s {hits[0][0]} ({hits[0][1]}, {hits[0][2]}). A remote client '
              'reaches that key through the measured-boot log, which a TPM quote must still bind (verify_vbs_report.py sections 1-3).')
        return 0
    print('RESULT: NOT signed by any VSM key in this boot\'s log under the spans and schemes tried: the signer is still unknown, '
          'and without it the report is something the host asserts, not something a client can check.')
    return 1


if __name__ == '__main__':
    sys.exit(main())

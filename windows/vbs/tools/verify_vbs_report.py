#!/usr/bin/env python3
"""Verifier for a consumer-node (Windows VBS enclave) attestation, from evidence a node would send:
   the measured-boot TCG log, a TPM quote over PCR 7/12/13/14 (TPMS_ATTEST + RSASSA signature + the quoting key's TPMT_PUBLIC),
   the EK certificate, and the enclave's VBS_ENCLAVE_REPORT package with the nonce the verifier chose.
Every check prints PASS/FAIL and the script exits non-zero if any required check fails.  Policy knobs at the top.
Usage: verify_vbs_report.py --log mb.log --report report.bin --nonce nonce.bin
                            [--quote quoted.bin --quote-sig quote_sig.bin --quote-nonce quote_nonce.bin --aik aik_pub.bin]
                            [--ek ek.der --ek-roots amd-ek-root.pem] [--allow-testsigning] [--pin-pcr0 HEX]
                            [--credential HEX --credential-expected HEX]   (the ActivateCredential round trip, see makecredential.py)"""
import argparse, hashlib, struct, subprocess, sys, tempfile, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tcglog

# ---- policy -----------------------------------------------------------------------------------------------
EXPECTED_ENCLAVE = {            # what a published enclave measurement looks like; None = don't check (spike mode)
    'AuthorId': None, 'FamilyId': None, 'ImageId': None, 'min_svn': 0 }
REQUIRE = {'VSM_LAUNCH_TYPE': 1, 'HYPERVISOR_LAUNCH_TYPE': 1, 'VBS_VSM_REQUIRED': 1, 'VBS_HVCI_POLICY': 1,
           'CODEINTEGRITY': 1, 'BOOTDEBUGGING': 0, 'OSKERNELDEBUG': 0, 'HYPERVISOR_DEBUG': 0, 'SAFEMODE': 0, 'WINPE': 0, 'FLIGHTSIGNING': 0}
# HYPERVISOR_BOOT_DMA_PROTECTION and VBS_IOMMU_REQUIRED are reported below but not yet required (see REPORT.md).

results = []
def check(name, ok, detail='', required=True):
    results.append((name, bool(ok), required)); print('  [%s] %-46s %s' % ('PASS' if ok else ('FAIL' if required else 'warn'), name, detail))

def rsa_pem(n, e):
    d = tempfile.mkdtemp(); conf = os.path.join(d, 'k.asn1'); der = os.path.join(d, 'k.der'); pem = os.path.join(d, 'k.pem')
    open(conf, 'w').write('asn1=SEQUENCE:pub\n[pub]\nn=INTEGER:%d\ne=INTEGER:%d\n' % (n, e))
    subprocess.run(['openssl', 'asn1parse', '-genconf', conf, '-out', der, '-noout'], check=True)
    subprocess.run('openssl rsa -RSAPublicKey_in -inform der -in %s -pubout -out %s 2>/dev/null' % (der, pem), shell=True, check=True)
    return pem

def openssl_verify(pem, data, sig, pss=False):
    d = tempfile.mkdtemp(); df = os.path.join(d, 'd'); sf = os.path.join(d, 's'); open(df, 'wb').write(data); open(sf, 'wb').write(sig)
    cmd = ['openssl', 'dgst', '-sha256', '-verify', pem] + (['-sigopt', 'rsa_padding_mode:pss', '-sigopt', 'rsa_pss_saltlen:32'] if pss else []) + ['-signature', sf, df]
    return 'Verified OK' in subprocess.run(cmd, capture_output=True, text=True).stdout

def main():
    ap = argparse.ArgumentParser(); a = ap.add_argument
    a('--log', required=True); a('--report', required=True); a('--nonce', required=True)
    a('--quote'); a('--quote-sig'); a('--quote-nonce'); a('--aik'); a('--ek'); a('--ek-roots'); a('--allow-testsigning', action='store_true'); a('--pin-pcr0')
    a('--credential'); a('--credential-expected')
    args = ap.parse_args()
    events = tcglog.parse(open(args.log, 'rb').read()); pcrs = tcglog.replay(events); f12 = tcglog.sipa_fields(events, 12)

    print('1. TPM genuineness (EK certificate chains to a pinned hardware root)')
    if args.ek and args.ek_roots:
        r = subprocess.run(['openssl', 'verify', '-CAfile', args.ek_roots, '-untrusted', args.ek_roots, args.ek], capture_output=True, text=True)
        # the AIA-fetched intermediate must be supplied alongside the root in --ek-roots; a chain to anything else fails
        subj = subprocess.run(['openssl', 'x509', '-in', args.ek, '-noout', '-ext', 'subjectAltName'], capture_output=True, text=True).stdout
        check('EK cert chains to pinned root', 'OK' in r.stdout, r.stdout.strip().splitlines()[-1] if r.stdout else r.stderr.strip()[:80])
        check('EK is an AMD/Intel firmware TPM (on-die), not discrete/virtual', 'tpmManufacturer=id:414D4400' in subj or 'tpmManufacturer=id:494E5443' in subj, subj.strip().splitlines()[-1][:70] if subj else '')
    else: check('EK certificate supplied', False, 'no --ek/--ek-roots given', required=False)

    print('2. TPM quote binds the log to hardware')
    if args.quote:
        pub = open(args.aik, 'rb').read(); q = open(args.quote, 'rb').read(); sig = open(args.quote_sig, 'rb').read(); qn = open(args.quote_nonce, 'rb').read()
        t, na, attrs = struct.unpack_from('>HHI', pub, 0); apl = struct.unpack_from('>H', pub, 8)[0]; o = 10 + apl + 12; ul = struct.unpack_from('>H', pub, o)[0]; mod = pub[o+2:o+2+ul]
        check('quoting key is restricted+sign, fixedTPM', attrs & 0x00050072 == 0x00050072, 'attrs=0x%08x' % attrs)
        check('quote signature verifies with the quoting key', openssl_verify(rsa_pem(int.from_bytes(mod, 'big'), 65537), q, sig))
        magic, typ = struct.unpack_from('>IH', q, 0); o = 6; n = struct.unpack_from('>H', q, o)[0]; o += 2 + n; n = struct.unpack_from('>H', q, o)[0]; extra = q[o+2:o+2+n]; o += 2 + n + 17 + 8
        cnt = struct.unpack_from('>I', q, o)[0]; o += 4; sel = []
        for i in range(cnt):
            alg, ssz = struct.unpack_from('>HB', q, o); bits = q[o+3:o+3+ssz]; o += 3 + ssz; sel += [p for p in range(ssz*8) if bits[p//8] >> (p % 8) & 1]
        n = struct.unpack_from('>H', q, o)[0]; digest = q[o+2:o+2+n]
        check('quote is TPM_ST_ATTEST_QUOTE with our nonce', magic == 0xff544347 and typ == 0x8018 and extra == qn)
        rep = dict(pcrs)
        if args.pin_pcr0: rep[0] = bytes.fromhex(args.pin_pcr0)
        missing = [p for p in sel if p not in rep]
        check('quoted PCR digest == replayed log (PCRs %s)' % sel, not missing and hashlib.sha256(b''.join(rep[p] for p in sel)).digest() == digest,
              'PCR0 needs --pin-pcr0 on firmware that does not log its early measurements' if 0 in sel and not args.pin_pcr0 else '')
        if args.credential and args.credential_expected:   # the node returned what TPM2_ActivateCredential(AIK, EK) recovered from our TPM2_MakeCredential(EK, name(AIK))
            check('quoting key is bound to the EK (ActivateCredential)', args.credential.lower() == args.credential_expected.lower())
        else: check('quoting key is bound to the EK (ActivateCredential)', False, 'no --credential/--credential-expected given (windows/node/tpmattest.c activate + tools/makecredential.py)', required=False)
    else: check('TPM quote supplied', False, 'no --quote given', required=False)

    print('3. Platform state from the measured boot log (PCR 12 / PCR 7)')
    bad = tcglog.unhashed_events(events); check('every SIPA record hashes to its recorded digest', not bad, 'edited events at %s' % bad[:4] if bad else '%d records checked' % sum(1 for e in events if e[1] == 6))
    for k, want in REQUIRE.items():
        vals = f12.get(k, []); check('%s == %d' % (k, want), vals and all(v == want for v in vals), 'log: %s' % vals)
    ts = f12.get('TESTSIGNING', []); check('TESTSIGNING == 0 (production signing only)', ts and all(v == 0 for v in ts), 'log: %s' % ts, required=not args.allow_testsigning)
    sb = tcglog.secure_boot_from_log(events); check('Secure Boot on (PCR7 SecureBoot variable)', sb == 1, 'log: %s' % sb, required=not args.allow_testsigning)
    check('HYPERVISOR_BOOT_DMA_PROTECTION == 1', f12.get('HYPERVISOR_BOOT_DMA_PROTECTION') == [1], 'log: %s' % f12.get('HYPERVISOR_BOOT_DMA_PROTECTION'), required=False)
    check('VBS_IOMMU_REQUIRED present', 'VBS_IOMMU_REQUIRED' in f12, 'log: %s' % f12.get('VBS_IOMMU_REQUIRED'), required=False)
    check('memory encryption state attested', False, 'NOT AVAILABLE on Windows: no SIPA record carries TSME/SME state', required=False)

    print('4. Enclave report (signed by the VSM identity key measured into PCR 12)')
    rep = open(args.report, 'rb').read(); nonce = open(args.nonce, 'rb').read()
    pkg, ver, scheme, ssz, sgsz, _ = struct.unpack_from('<IIIIII', rep, 0); stmt = rep[24:24+ssz]; sig = rep[24+ssz:24+ssz+sgsz]
    check('package header sane', pkg == len(rep) == 24 + ssz + sgsz and ver == 1 and scheme == 1, 'scheme=%d (1 = SHA256/RSA-PSS)' % scheme)
    key = tcglog.vsm_key(events, 'IDKS'); check('IDKS key present in log', key is not None)
    check('report signature verifies with IDKS from THIS boot\'s log', key and openssl_verify(rsa_pem(key[0], key[1]), stmt, sig, pss=True))
    check('report EnclaveData == verifier nonce', stmt[8:72] == nonce)
    ident = stmt[72:224]; svn, sksvn, psvn, flags, siglvl, etype = struct.unpack_from('<IIIIII', ident, 128)
    author, unique, family, image = ident[64:96].hex(), ident[32:64].hex(), ident[96:112].hex(), ident[112:128].hex()
    print('       AuthorId=%s\n       UniqueId=%s\n       FamilyId=%s ImageId=%s Svn=%d PlatformSvn=%d Flags=0x%x' % (author, unique, family, image, svn, psvn, flags))
    check('enclave not debuggable (Flags == 0)', flags == 0, 'flags=0x%x' % flags)
    check('enclave type VBS', etype == 0x10)
    for k, want in (('AuthorId', author), ('FamilyId', family), ('ImageId', image)):
        if EXPECTED_ENCLAVE[k]: check('%s matches published measurement' % k, want == EXPECTED_ENCLAVE[k])
    check('enclave SVN >= policy minimum', svn >= EXPECTED_ENCLAVE['min_svn'], 'svn=%d' % svn)
    # modules loaded into the enclave (vardata): the primary plus the platform DLLs vertdll / ucrtbase_enclave
    p, mods = 224, []
    while p + 8 <= len(stmt):
        dt, sz = struct.unpack_from('<II', stmt, p)
        if dt == 1: mods.append(stmt[p+108:p+sz].decode('utf-16-le', 'replace').rstrip('\0'))
        p += sz if sz else 8
    check('only expected modules in enclave', set(mods) <= {'vertdll.dll', 'ucrtbase_enclave.dll'} | {m for m in mods if m.lower().startswith(('rawenclave', 'enclave'))}, ', '.join(mods))

    bad = [n for n, ok, req in results if req and not ok]
    print('\nVERDICT: %s  (%d checks, %d required failures%s)' % ('ACCEPT' if not bad else 'REJECT', len(results), len(bad), ': ' + '; '.join(bad) if bad else ''))
    sys.exit(1 if bad else 0)

if __name__ == '__main__': main()

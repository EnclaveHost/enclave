#!/usr/bin/env python3
"""End-to-end proof of the EK binding on a Windows node (windows/vbs/EVIDENCE.md steps 3-5), driving tpmattest.exe
over its stdin/stdout grammar exactly as the node agent will:
    keys -> MakeCredential(EK cert, AIK name, random 32-byte credential) -> activate -> recovered == credential
    quote(random extraData) -> RSASSA-PKCS1v15-SHA256 verified with the AIK public; TPMS_ATTEST parsed; PCR digest == live PCRs
    log -> a file for the current boot exists
Everything the tool prints is copied verbatim into the transcript (--out); every check prints PASS/FAIL; exit 1 on any FAIL.
Usage: credential_roundtrip.py [--exe tpmattest.exe] [--out credential-roundtrip.txt]"""
import argparse, hashlib, os, secrets, struct, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from makecredential import make_credential, cert_rsa_public, tpmt_public_rsa

class Transcript:
    def __init__(self, path): self.f = open(path, 'w', newline='\n') if path else None
    def line(self, s):
        print(s); sys.stdout.flush()
        if self.f: self.f.write(s + '\n'); self.f.flush()

class Tool:
    def __init__(self, exe, t):
        self.t = t; self.p = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.banner = self.p.stdout.readline().rstrip('\r\n'); t.line('<  ' + self.banner)
    def cmd(self, line):
        self.t.line('>  ' + line); self.p.stdin.write(line + '\n'); self.p.stdin.flush(); rows = []
        while True:
            l = self.p.stdout.readline()
            if not l: raise RuntimeError('tool exited during ' + line)
            l = l.rstrip('\r\n'); self.t.line('<  ' + l)
            if l == 'ok': return True, rows
            if l.startswith('err '): return False, rows
            k, _, v = l.partition(' '); rows.append((k, v))
    @staticmethod
    def get(rows, key): return next((v for k, v in rows if k == key), None)

fails = []
def check(t, name, ok, detail=''):
    if not ok: fails.append(name)
    t.line('  [%s] %-52s %s' % ('PASS' if ok else 'FAIL', name, detail))

def pkcs1v15_sha256_verify(n, e, data, sig):
    k = (n.bit_length() + 7) // 8; em = pow(int.from_bytes(sig, 'big'), e, n).to_bytes(k, 'big')
    t = bytes.fromhex('3031300d060960864801650304020105000420') + hashlib.sha256(data).digest()
    return em == b'\x00\x01' + b'\xff' * (k - len(t) - 3) + b'\x00' + t

def parse_attest(q):
    magic, typ = struct.unpack_from('>IH', q, 0); o = 6
    n = struct.unpack_from('>H', q, o)[0]; signer = q[o+2:o+2+n]; o += 2 + n
    n = struct.unpack_from('>H', q, o)[0]; extra = q[o+2:o+2+n]; o += 2 + n
    clock, reset, restart, safe = struct.unpack_from('>QIIB', q, o); o += 17; fw = q[o:o+8]; o += 8
    cnt = struct.unpack_from('>I', q, o)[0]; o += 4; sel = []
    for _ in range(cnt):
        alg, ssz = struct.unpack_from('>HB', q, o); bits = q[o+3:o+3+ssz]; o += 3 + ssz
        sel += [(alg, p) for p in range(ssz * 8) if bits[p // 8] >> (p % 8) & 1]
    n = struct.unpack_from('>H', q, o)[0]; digest = q[o+2:o+2+n]
    return dict(magic=magic, type=typ, signer=signer, extra=extra, clock=clock, resetCount=reset, restartCount=restart, safe=safe, sel=sel, digest=digest)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--exe', default='tpmattest.exe'); ap.add_argument('--out'); args = ap.parse_args()
    t = Transcript(args.out)
    t.line('# credential round trip, %s, host %s, exe %s' % (time.strftime('%Y-%m-%d %H:%M:%S'), os.environ.get('COMPUTERNAME', '?'), args.exe))
    tool = Tool(args.exe, t); check(t, 'tool ready', tool.banner.startswith('ready tpmattest/'), tool.banner)

    t.line('## 1. keys'); ok, rows = tool.cmd('keys'); check(t, 'keys ok', ok)
    ek_der = bytes.fromhex(tool.get(rows, 'ek-cert') or ''); aik_pub = bytes.fromhex(tool.get(rows, 'aik-pub') or ''); aik_name = bytes.fromhex(tool.get(rows, 'aik-name') or '')
    check(t, 'EK certificate present (%s)' % tool.get(rows, 'ek-cert-source'), len(ek_der) > 0 and ek_der[0] == 0x30, '%d bytes DER, sha256 %s' % (len(ek_der), hashlib.sha256(ek_der).hexdigest()[:16]))
    check(t, 'aik-name == 0x000b || sha256(aik-pub)', aik_name == b'\x00\x0b' + hashlib.sha256(aik_pub).digest())
    aik = tpmt_public_rsa(aik_pub); check(t, 'AIK attrs fixedTPM|fixedParent|sensitiveDataOrigin|restricted|sign', aik['attrs'] & 0x00050072 == 0x00050072, 'attrs=0x%08x scheme=0x%04x keyBits=%d' % (aik['attrs'], aik['scheme'], aik['keyBits']))
    if not ek_der or ek_der[0] != 0x30 or not aik_pub: t.line('VERDICT: FAIL (no EK certificate / AIK from the tool; nothing further to test)'); sys.exit(1)
    ek_n, ek_e = cert_rsa_public(ek_der); check(t, 'EK certificate carries an RSA-2048 key', ek_n.bit_length() == 2048 and ek_e == 65537)

    t.line('## 2. MakeCredential (verifier side, makecredential.py) with a random 32-byte credential')
    credential = secrets.token_bytes(32); blob, secret = make_credential(ek_n, ek_e, aik_name, credential)
    t.line('   credential     ' + credential.hex()); t.line('   credentialBlob ' + blob.hex()); t.line('   secret         ' + secret.hex())

    t.line('## 3. activate (node side: EK under TPM_RH_ENDORSEMENT, PolicySecret session, ActivateCredential)')
    ok, rows = tool.cmd('activate %s %s' % (blob.hex(), secret.hex())); check(t, 'activate ok', ok)
    ek_pub = bytes.fromhex(tool.get(rows, 'ek-pub') or '')
    if ek_pub:
        ek = tpmt_public_rsa(ek_pub)
        check(t, 'EK TPMT_PUBLIC modulus == certificate modulus (checked here too)', ek['n'] == ek_n)
        check(t, 'EK attrs/policy are the TCG default template', ek['attrs'] == 0x000300B2 and ek['authPolicy'].hex() == '837197674484b3f81a90cc8d46a5d724fd52d76e06520b64f2a1da1b331469aa' and ek['sym'] == (6, 128, 0x43), 'attrs=0x%08x sym=%s' % (ek['attrs'], ek['sym']))
        check(t, 'ek-name == 0x000b || sha256(ek-pub)', bytes.fromhex(tool.get(rows, 'ek-name') or '') == b'\x00\x0b' + hashlib.sha256(ek_pub).digest())
    recovered = tool.get(rows, 'credential'); check(t, 'recovered credential == the one MakeCredential wrapped', recovered == credential.hex(), 'source=%s auth=%s hmac=%s' % (tool.get(rows, 'ek-source'), tool.get(rows, 'endorsement-auth'), tool.get(rows, 'policy-hmac')))

    t.line('## 3b. negative: a credential made for a DIFFERENT name must not activate')
    wrong_name = b'\x00\x0b' + hashlib.sha256(b'not the aik').digest(); blob2, secret2 = make_credential(ek_n, ek_e, wrong_name, credential)
    ok2, rows2 = tool.cmd('activate %s %s' % (blob2.hex(), secret2.hex())); check(t, 'activate with a foreign name is refused', not ok2 and tool.get(rows2, 'credential') is None)

    t.line('## 4. quote with a random 32-byte extraData'); extra = secrets.token_bytes(32)
    ok, rows = tool.cmd('quote ' + extra.hex()); check(t, 'quote ok', ok)
    attest = bytes.fromhex(tool.get(rows, 'attest') or ''); sig = bytes.fromhex(tool.get(rows, 'sig') or '')
    check(t, 'aik-pub in the quote reply == the one from keys', tool.get(rows, 'aik-pub') == aik_pub.hex())
    check(t, 'RSASSA-PKCS1v15-SHA256 signature verifies with the AIK public', pkcs1v15_sha256_verify(aik['n'], aik['e'], attest, sig), 'sig-scheme %s' % tool.get(rows, 'sig-scheme'))
    a = parse_attest(attest)
    check(t, 'TPMS_ATTEST magic 0xff544347, type TPM_ST_ATTEST_QUOTE', a['magic'] == 0xff544347 and a['type'] == 0x8018, 'magic=0x%08x type=0x%04x' % (a['magic'], a['type']))
    check(t, 'extraData == our random value', a['extra'] == extra)
    qn = b'\x00\x0b' + hashlib.sha256(bytes.fromhex('40000007') + aik_name).digest()   # Part 1 26.5: QN = H(QN(parent) || Name); parent = TPM_RH_NULL
    check(t, 'qualifiedSigner == QN(AIK) = H(TPM_RH_NULL || aik-name)', a['signer'] == qn, 'signer=%s' % a['signer'].hex())
    check(t, 'PCR selection sha256 {0,7,12,13,14}', a['sel'] == [(0x0b, p) for p in (0, 7, 12, 13, 14)], str(a['sel']))
    live = {}
    for p in (0, 7, 12, 13, 14):
        ok, rows = tool.cmd('pcr %d' % p); v = tool.get(rows, 'pcr'); live[p] = bytes.fromhex(v.split()[1]) if ok and v else b''
    check(t, 'pcrDigest == sha256(live PCR 0||7||12||13||14)', hashlib.sha256(b''.join(live[p] for p in (0, 7, 12, 13, 14))).digest() == a['digest'], 'resetCount=%d restartCount=%d' % (a['resetCount'], a['restartCount']))

    t.line('## 5. log'); ok, rows = tool.cmd('log'); path = tool.get(rows, 'log')
    check(t, 'newest measured-boot log exists', ok and path and os.path.exists(path), '%s (%d bytes)' % (path, os.path.getsize(path)) if path and os.path.exists(path) else str(path))
    ok, _ = tool.cmd('quit'); check(t, 'quit ok, exit 0', ok and tool.p.wait(10) == 0)
    t.line('VERDICT: %s (%d failures%s)' % ('PASS' if not fails else 'FAIL', len(fails), ': ' + '; '.join(fails) if fails else ''))
    sys.exit(1 if fails else 0)

if __name__ == '__main__': main()

#!/usr/bin/env python3
"""TPM2_MakeCredential, the verifier's half of the EK binding (windows/vbs/EVIDENCE.md, handshake step 4), as a
pure-Python reference (hashlib + hmac + integer RSA + a small AES-128; no third-party packages, so it runs on the
Windows box as it is). Reference: TPM 2.0 Library Part 1 section 24 "Credential Protection", Part 3 TPM2_MakeCredential,
Part 1 11.4.10 KDFa, and the reference implementation's CryptSecretEncrypt (label "IDENTITY").

    seed          = random bytes, one nameAlg digest long (32 for SHA-256)
    secret        = RSA-OAEP-SHA256(EK public, seed, label = b"IDENTITY\\0")      -> TPM2B_ENCRYPTED_SECRET contents
    symKey        = KDFa(SHA-256, seed, "STORAGE",   contextU = AIK name, contextV = "", 128 bits)
    encIdentity   = AES-128-CFB(symKey, iv = 0) of TPM2B(credential) = u16 size || credential
    hmacKey       = KDFa(SHA-256, seed, "INTEGRITY", "", "", 256 bits)
    integrityHMAC = HMAC-SHA256(hmacKey, encIdentity || AIK name)
    credentialBlob = TPM2B(integrityHMAC) || encIdentity                           -> TPM2B_ID_OBJECT contents

The AIK name is the 34-byte TPM2B_NAME contents (0x000b || sha256(TPMT_PUBLIC)); KDFa's label gets a terminating zero byte.
What the node returns from TPM2_ActivateCredential(AIK, EK, credentialBlob, secret) must equal `credential`.

Usage: makecredential.py (--ek-cert ek.der | --ek-pub <hex TPMT_PUBLIC>) --aik-name <hex 34 bytes>
                         [--credential <hex 32 bytes>] [--json]      prints credentialBlob, secret and the credential (hex)
       makecredential.py --selftest                                   AES/OAEP/KDFa checks (uses `cryptography` when present)
"""
import argparse, hashlib, hmac, json, os, struct, sys

# ---- AES-128, forward cipher only (CFB encryption needs nothing else). FIPS-197.
_SBOX = bytes.fromhex(
    '637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275'
    '09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2'
    'cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08'
    'ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16')
def _xt(a): return ((a << 1) ^ 0x1b) & 0xff if a & 0x80 else a << 1
def _expand(key):
    w = [list(key[i:i+4]) for i in range(0, 16, 4)]; rcon = 1
    for i in range(4, 44):
        t = list(w[i-1])
        if i % 4 == 0: t = [_SBOX[b] for b in t[1:] + t[:1]]; t[0] ^= rcon; rcon = _xt(rcon)
        w.append([w[i-4][j] ^ t[j] for j in range(4)])
    return [sum(w[4*r:4*r+4], []) for r in range(11)]
def _encrypt_block(rk, block):
    s = [b ^ k for b, k in zip(block, rk[0])]
    for r in range(1, 11):
        s = [_SBOX[b] for b in s]
        s = [s[4 * ((c + row) % 4) + row] for c in range(4) for row in range(4)]          # ShiftRows (column-major state)
        if r != 10:
            o = []
            for c in range(4):
                a0, a1, a2, a3 = s[4*c:4*c+4]
                o += [_xt(a0) ^ _xt(a1) ^ a1 ^ a2 ^ a3, a0 ^ _xt(a1) ^ _xt(a2) ^ a2 ^ a3, a0 ^ a1 ^ _xt(a2) ^ _xt(a3) ^ a3, _xt(a0) ^ a0 ^ a1 ^ a2 ^ _xt(a3)]
            s = o
        s = [b ^ k for b, k in zip(s, rk[r])]
    return bytes(s)
def aes128_cfb_encrypt(key, iv, data):
    rk, prev, out = _expand(key), iv, b''
    for i in range(0, len(data), 16):
        ks = _encrypt_block(rk, prev); chunk = data[i:i+16]
        c = bytes(a ^ b for a, b in zip(chunk, ks)); out += c; prev = c if len(c) == 16 else prev
    return out

# ---- RSA-OAEP (PKCS#1 v2.1, RFC 8017 7.1.1) with SHA-256 for both the label hash and MGF1
def _mgf1(seed, n):
    return b''.join(hashlib.sha256(seed + struct.pack('>I', i)).digest() for i in range((n + 31) // 32))[:n]
def rsa_oaep_encrypt(n, e, msg, label, rnd=os.urandom):
    k = (n.bit_length() + 7) // 8; h = 32
    if len(msg) > k - 2*h - 2: raise ValueError('message too long')
    db = hashlib.sha256(label).digest() + bytes(k - len(msg) - 2*h - 2) + b'\x01' + msg
    seed = rnd(h); masked_db = bytes(a ^ b for a, b in zip(db, _mgf1(seed, k - h - 1)))
    masked_seed = bytes(a ^ b for a, b in zip(seed, _mgf1(masked_db, h)))
    return pow(int.from_bytes(b'\x00' + masked_seed + masked_db, 'big'), e, n).to_bytes(k, 'big')

# ---- KDFa (TPM 2.0 Part 1, 11.4.10): HMAC counter mode, label || 0x00 || contextU || contextV || bits
def kdfa(key, label, context_u, context_v, bits):
    out, i = b'', 1
    while len(out) * 8 < bits:
        out += hmac.new(key, struct.pack('>I', i) + label + b'\x00' + context_u + context_v + struct.pack('>I', bits), 'sha256').digest(); i += 1
    return out[:bits // 8]

def make_credential(ek_n, ek_e, aik_name, credential, sym_bits=128, rnd=os.urandom):
    """-> (credentialBlob, secret) as the TPM2B_ID_OBJECT / TPM2B_ENCRYPTED_SECRET contents (no size prefix)."""
    if len(aik_name) != 34 or aik_name[:2] != b'\x00\x0b': raise ValueError('aik name must be 0x000b || sha256')
    seed = rnd(32)
    secret = rsa_oaep_encrypt(ek_n, ek_e, seed, b'IDENTITY\x00', rnd)
    sym_key = kdfa(seed, b'STORAGE', aik_name, b'', sym_bits)
    enc_identity = aes128_cfb_encrypt(sym_key, bytes(16), struct.pack('>H', len(credential)) + credential)
    hmac_key = kdfa(seed, b'INTEGRITY', b'', b'', 256)
    integrity = hmac.new(hmac_key, enc_identity + aik_name, 'sha256').digest()
    return struct.pack('>H', len(integrity)) + integrity + enc_identity, secret

# ---- key material: from a TPMT_PUBLIC (RSA) or from an X.509 certificate DER
def tpmt_public_rsa(pub):
    """-> dict(type, nameAlg, attrs, authPolicy, sym=(alg, bits, mode), scheme, keyBits, exponent, n, e)"""
    t, name_alg, attrs, pol = struct.unpack_from('>HHIH', pub, 0); o = 10 + pol; auth_policy = pub[10:o]
    if t != 1: raise ValueError('not an RSA TPMT_PUBLIC')
    sym = struct.unpack_from('>H', pub, o)[0]; o += 2; sym_bits = sym_mode = None
    if sym != 0x10: sym_bits, sym_mode = struct.unpack_from('>HH', pub, o); o += 4
    scheme = struct.unpack_from('>H', pub, o)[0]; o += 2
    if scheme != 0x10: o += 2
    key_bits, exp = struct.unpack_from('>HI', pub, o); o += 6
    ul = struct.unpack_from('>H', pub, o)[0]; n = int.from_bytes(pub[o+2:o+2+ul], 'big')
    return dict(type=t, nameAlg=name_alg, attrs=attrs, authPolicy=auth_policy, sym=(sym, sym_bits, sym_mode), scheme=scheme,
                keyBits=key_bits, exponent=exp or 65537, n=n, e=exp or 65537)
def _tlv(buf, off=0):
    tag, l, off = buf[off], buf[off+1], off + 2
    if l & 0x80: nb = l & 0x7f; l = int.from_bytes(buf[off:off+nb], 'big'); off += nb
    return tag, buf[off:off+l], off + l
def _children(body):
    out, off = [], 0
    while off < len(body): tag, val, off = _tlv(body, off); out.append((tag, val))
    return out
def cert_rsa_public(der):
    """-> (n, e) of the RSA key in an X.509 certificate DER (subjectPublicKeyInfo walk; no signature check here)."""
    _, cert, _ = _tlv(der); tbs = _children(cert)[0][1]; fields = _children(tbs)
    if fields[0][0] == 0xa0: fields = fields[1:]                          # explicit version
    spki = _children(fields[5][1]); bits = spki[1][1][1:]                 # BIT STRING, skip the unused-bits byte
    n, e = _children(_tlv(bits)[1]); return int.from_bytes(n[1], 'big'), int.from_bytes(e[1], 'big')

def selftest():
    ok = True
    ct = _encrypt_block(_expand(bytes.fromhex('000102030405060708090a0b0c0d0e0f')), bytes.fromhex('00112233445566778899aabbccddeeff'))
    print('AES-128 FIPS-197 C.1 vector         ', 'PASS' if ct.hex() == '69c4e0d86a7b0430d8cdb78070b4c55a' else 'FAIL ' + ct.hex()); ok &= ct.hex() == '69c4e0d86a7b0430d8cdb78070b4c55a'
    # KDFa against a hand computation of one block (the function is one HMAC; this pins the byte layout)
    k = kdfa(b'k' * 32, b'STORAGE', b'ctx', b'', 128); ref = hmac.new(b'k' * 32, b'\x00\x00\x00\x01STORAGE\x00ctx\x00\x00\x00\x80', 'sha256').digest()[:16]
    print('KDFa layout (counter|label|0|ctx|bits)', 'PASS' if k == ref else 'FAIL'); ok &= k == ref
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms
        try: from cryptography.hazmat.decrepit.ciphers import modes
        except ImportError: from cryptography.hazmat.primitives.ciphers import modes
        from cryptography.hazmat.primitives.asymmetric import rsa, padding
        from cryptography.hazmat.primitives import hashes
        key, iv, data = os.urandom(16), os.urandom(16), os.urandom(45)
        enc = Cipher(algorithms.AES(key), modes.CFB(iv)).encryptor(); ref = enc.update(data) + enc.finalize()
        mine = aes128_cfb_encrypt(key, iv, data); print('AES-128-CFB vs cryptography (45 bytes)', 'PASS' if mine == ref else 'FAIL'); ok &= mine == ref
        priv = rsa.generate_private_key(65537, 2048); pub = priv.public_key().public_numbers(); msg = os.urandom(32)
        c = rsa_oaep_encrypt(pub.n, pub.e, msg, b'IDENTITY\x00')
        dec = priv.decrypt(c, padding.OAEP(padding.MGF1(hashes.SHA256()), hashes.SHA256(), b'IDENTITY\x00'))
        print('RSA-OAEP-SHA256 label IDENTITY\\0 decrypts', 'PASS' if dec == msg else 'FAIL'); ok &= dec == msg
    except ImportError: print('(cryptography not installed: CFB/OAEP cross-checks skipped)')
    return ok

def main():
    ap = argparse.ArgumentParser(); a = ap.add_argument
    a('--ek-cert'); a('--ek-pub'); a('--aik-name'); a('--credential'); a('--json', action='store_true'); a('--selftest', action='store_true')
    args = ap.parse_args()
    if args.selftest: sys.exit(0 if selftest() else 1)
    if not args.aik_name or not (args.ek_cert or args.ek_pub): ap.error('--aik-name and one of --ek-cert/--ek-pub are required')
    sym_bits = 128
    if args.ek_pub:
        p = tpmt_public_rsa(bytes.fromhex(args.ek_pub)); n, e = p['n'], p['e']
        if p['nameAlg'] != 0x0b or p['sym'][0] != 0x06 or p['sym'][2] != 0x43: sys.exit('EK must be SHA-256 name / AES-CFB (TCG default template)')
        sym_bits = p['sym'][1]
    else: n, e = cert_rsa_public(open(args.ek_cert, 'rb').read())
    credential = bytes.fromhex(args.credential) if args.credential else os.urandom(32)
    blob, secret = make_credential(n, e, bytes.fromhex(args.aik_name), credential, sym_bits)
    out = {'credentialBlob': blob.hex(), 'secret': secret.hex(), 'credential': credential.hex()}
    print(json.dumps(out) if args.json else '\n'.join('%s %s' % kv for kv in out.items()))

if __name__ == '__main__': main()

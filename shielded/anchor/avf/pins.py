#!/usr/bin/env python3
"""pins.py -- the two policy pins the relay needs for an anchor APK build.

  codeHash      the APK's fs-verity Merkle root as carried by its v4 signature
                (.idsig). Microdroid reports it as the APK component's codeHash
                in the pVM attestation extension; the relay allowlists it
                (METAL_AVF_CODE_HASHES).
  authorityHash sha512 of the APK signing certificate (DER); the attestation
                extension's authorityHash for that component; the relay pins it
                (METAL_AVF_AUTHORITY_HASHES).

  pins.py out/anchor.apk [--idsig FILE] [--keystore keys/anchor.jks --alias anchor --storepass PW]

codeHash is computed here directly over the apk bytes (fs-verity Merkle root);
--idsig cross-checks it against an idsig made for the SAME bytes, e.g. the
build's own out/anchor.apk.idsig or the phone's `vm create-idsig` output. Note
`apksigner sign --out X` RE-SIGNS and so hashes different bytes: never pin
from that.
"""
import argparse, hashlib, os, struct, subprocess, sys

def parse_idsig(path):
    b = open(path, "rb").read(); off = 0
    def u32():
        nonlocal off; v = struct.unpack_from("<I", b, off)[0]; off += 4; return v
    def sized():
        nonlocal off; n = u32(); v = b[off:off + n]; off += n; return v
    version = u32()
    hashing = sized()
    # HashingInfo: int32 hashAlgorithm, int8 log2BlockSize, sized salt, sized rawRootHash
    algo = struct.unpack_from("<I", hashing, 0)[0]; log2bs = hashing[4]
    salt_n = struct.unpack_from("<I", hashing, 5)[0]; salt = hashing[9:9 + salt_n]
    p = 9 + salt_n; root_n = struct.unpack_from("<I", hashing, p)[0]; root = hashing[p + 4:p + 4 + root_n]
    return {"version": version, "hashAlgorithm": algo, "log2BlockSize": log2bs, "salt": salt.hex(), "rootHash": root.hex()}

def fsverity_root(data, bs=4096):
    """The fs-verity Merkle root: sha256 leaves over 4096-byte blocks, levels hashed
    up in 4096-byte chunks, every block including the last data block zero-padded
    to 4096, root = sha256 of the top block. This is the rawRootHash a v4 idsig
    carries, computed over the FINAL apk bytes. Matched byte-for-byte against the
    phone's own `vm create-idsig` and apksigner's v4 output (2026-09-02)."""
    blocks = [data[i:i + bs] for i in range(0, len(data), bs)] or [b""]
    blocks[-1] = blocks[-1] + b"\0" * (bs - len(blocks[-1]))        # the last DATA block is zero-padded too
    level = b"".join(hashlib.sha256(b).digest() for b in blocks)
    while len(level) > bs:
        if len(level) % bs: level += b"\0" * (bs - len(level) % bs)
        level = b"".join(hashlib.sha256(level[i:i + bs]).digest() for i in range(0, len(level), bs))
    if len(level) < bs: level += b"\0" * (bs - len(level))
    return hashlib.sha256(level).digest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("apk"); ap.add_argument("--idsig", help="cross-check: an idsig made for this exact apk (apksigner v4 or the device's vm create-idsig)")
    ap.add_argument("--keystore", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "keys", "anchor.jks"))
    ap.add_argument("--alias", default="anchor"); ap.add_argument("--storepass", default="anchor123")
    a = ap.parse_args()
    code = fsverity_root(open(a.apk, "rb").read()).hex()
    if a.idsig:
        info = parse_idsig(a.idsig)
        print(f"idsig:          v{info['version']} algo={info['hashAlgorithm']} log2bs={info['log2BlockSize']} salt={info['salt'] or '(none)'} rootHash={info['rootHash']}")
        if info["rootHash"] != code: print("MISMATCH: that idsig was not made over these apk bytes (apksigner --out re-signs; use the build's own .idsig)", file=sys.stderr); sys.exit(1)
    cert_der = subprocess.run(["keytool", "-exportcert", "-keystore", a.keystore, "-alias", a.alias, "-storepass", a.storepass], check=True, capture_output=True).stdout
    authority = hashlib.sha512(cert_der).hexdigest()
    print(f"apk:            {a.apk}")
    print(f"codeHash:       {code}   (fs-verity Merkle root of the apk bytes{' = idsig' if a.idsig else ''})")
    print(f"authorityHash:  {authority}   (sha512 of the signing certificate DER, sha256 {hashlib.sha256(cert_der).hexdigest()[:16]}…)")
    print()
    print("relay env:      METAL_AVF_CODE_HASHES=%s METAL_AVF_AUTHORITY_HASHES=%s" % (code, authority))
    print("local hub:      node host/local-hub.mjs --code-hash %s --authority %s" % (code, authority))

if __name__ == "__main__":
    main()

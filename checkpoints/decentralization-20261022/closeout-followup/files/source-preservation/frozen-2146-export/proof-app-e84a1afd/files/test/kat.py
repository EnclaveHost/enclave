#!/usr/bin/env python3
"""Independent known-answer vectors for src/proof.rs (python stdlib hmac/hashlib only; SYNTHETIC markers in the canary
driver's format CANARY_<run>_<set>_<64 hex>, driver/markers.mjs createMarkerSet)."""
import hashlib, hmac
DOMAIN = b"enclave-custody-canary-proof-v1\n"
C = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
M1 = "CANARY_20261023T000000Z_c1-rev1_1f3c5b7d9e0a2c4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6"
M2 = "CANARY_20261023T000000Z_c1-rev1_a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf"
def proof(marker, name, c):
    return hmac.new(marker.encode(), DOMAIN + name.encode() + b"\n" + c.encode(), hashlib.sha256).hexdigest()
if __name__ == "__main__":
    print("KAT1", proof(M1, "CANARY_R1_A", C))
    print("KAT2", proof(M2, "CANARY_R1_B", C))

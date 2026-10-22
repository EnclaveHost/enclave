#!/usr/bin/env python3
"""Applies ONE mutant of the clone-privacy fix (exact-string edits). Each must make a clone_privacy case fail."""
import sys, pathlib
S = pathlib.Path(__file__).resolve().parent.parent / "sia-s3/vendor/sia-sdk-rs/sia_storage/src"
M = {
    # slab key no longer bound to the slab's plaintext
    "M1": ("erasure_coding.rs", "    parts.extend(data.iter().map(|d| d.as_slice()));\n", "    let _ = data;\n"),
    # metadata key a plain random draw again
    "M2": ("object_encryption.rs", """    hedged_key(
        b"sia_storage/metadata-key/v1",
        &[object_id.as_ref(), &(metadata.len() as u64).to_le_bytes(), metadata],
    )""", """    let _ = (object_id, metadata);
    EncryptionKey::from(rand::random::<[u8; 32]>())"""),
    # sealing nonces not bound to what they seal
    "M3": ("object_encryption.rs", "    let h = hedged(domain, parts);\n", "    let _ = parts;\n    let h = hedged(domain, &[]);\n"),
    # inner (object key) layer skipped
    "M4": ("erasure_coding.rs", "                cipher.apply_keystream(buf);\n", "                let _ = &mut cipher;\n"),
    # hedged derivation ignores its input entirely
    "M5": ("object_encryption.rs", "    input.extend_from_slice(parts);\n", "    let _ = parts;\n"),
}
rel, old, new = M[sys.argv[1]]
p = S / rel
s = p.read_text()
if s.count(old) != 1:
    sys.exit(f"{sys.argv[1]}: anchor found {s.count(old)} times")
p.write_text(s.replace(old, new))
print(f"{sys.argv[1]} applied to {rel}")

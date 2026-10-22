#!/usr/bin/env python3
"""Test-only additions (no behaviour change): a mock-feature helper that opens a sealed object's metadata key, and the
metadata copy regression in sia-s3 src/clone_privacy.rs. Applied BEFORE the fix, so the regression runs on the old SDK
first."""
import sys, pathlib

CAND = pathlib.Path(__file__).resolve().parent.parent / "sia-s3"


def edit(rel, old, new):
    p = CAND / rel
    s = p.read_text()
    n = s.count(old)
    if n != 1:
        sys.exit(f"{rel}: anchor found {n} times:\n{old[:200]}")
    p.write_text(s.replace(old, new))


edit("vendor/sia-sdk-rs/sia_storage/src/mock.rs", """impl Default for MockNetwork {""",
"""/// PATCH (clone privacy review), TEST ONLY: the metadata key `sealed` carries, opened with `key` (None: the object has
/// no metadata or was not sealed with `key`).
pub fn opened_metadata_key(key: &AppKey, sealed: &crate::SealedObject) -> Option<[u8; 32]> {
    if sealed.encrypted_metadata_key.is_empty() {
        return None;
    }
    crate::object_encryption::open_metadata_key(&key.0, &sealed.id(), &sealed.encrypted_metadata_key)
        .ok()
        .map(|k| *k.as_ref())
}

impl Default for MockNetwork {""")

# the harness hands raw bytes across; captures are encoded by a wrapper
edit("src/clone_privacy.rs", """fn copied<F, Fut>(test: F) -> (Vec<Captured>, Vec<Captured>)
where
    F: FnOnce(Copier) -> Fut,
    Fut: Future<Output = Vec<Captured>>,
{""", """fn copied<F, Fut>(test: F) -> (Vec<Captured>, Vec<Captured>)
where
    F: FnOnce(Copier) -> Fut,
    Fut: Future<Output = Vec<Captured>>,
{
    let (a, b) = copied_bytes(|copier| {
        let fut = test(copier);
        async move { encode(&fut.await) }
    });
    (decode(&a), decode(&b))
}

/// As [copied], for a test that hands over raw bytes.
fn copied_bytes<F, Fut>(test: F) -> (Vec<u8>, Vec<u8>)
where
    F: FnOnce(Copier) -> Fut,
    Fut: Future<Output = Vec<u8>>,
{""")
edit("src/clone_privacy.rs", """                Ok(c) => match to_b.write_all(&encode(&c)) {""", """                Ok(c) => match to_b.write_all(&c) {""")
edit("src/clone_privacy.rs", """            (a, decode(&raw))""", """            (a, raw)""")

with open(CAND / "src/clone_privacy.rs", "a") as f:
    f.write('''
/// Metadata sealing (sia-s3 keeps its whole key index in object metadata). Old SDK: a copy draws the same metadata
/// key, so only the XChaCha20-Poly1305 nonce (from the OS RNG: different after a fork, possibly repeated in a VM
/// snapshot or by a WASI host) separates two copies' different metadata. Hedged: different metadata gets a different
/// key, the same metadata the same key.
#[test]
fn copies_seal_different_metadata_under_different_keys() {
    let (a, b) = copied_bytes(|copier| async move {
        let key = AppKey::import([0x5a; 32]);
        let mut obj = Object::default(); // one object, made before the copy
        copier.now();
        let mut out = Vec::new();
        for m in [if copier.is_child() { "copy B: secret key names" } else { "copy A: known key names" }, "the same in both"] {
            obj.metadata = m.as_bytes().to_vec();
            let sealed = obj.seal(&key);
            out.extend(sia_storage::mock::opened_metadata_key(&key, &sealed).expect("sealed with metadata"));
        }
        out
    });
    eprintln!("metadata keys equal across the copies: different metadata {}, same metadata {}", a[..32] == b[..32], a[32..] == b[32..]);
    assert_ne!(
        a[..32],
        b[..32],
        "copies sealed different metadata under the SAME metadata key: only the OS nonce separates them"
    );
    assert_eq!(a[32..], b[32..], "the same metadata, the same key (equality only)");
}
''')
print("metadata test applied")

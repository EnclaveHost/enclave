#!/usr/bin/env python3
"""Applies the clone-privacy candidate fix to candidate/sia-s3/vendor/sia-sdk-rs/sia_storage (exact-string edits;
fails loudly if any anchor is missing or ambiguous)."""
import sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent / "sia-s3/vendor/sia-sdk-rs/sia_storage/src"


def edit(rel, old, new):
    p = ROOT / rel
    s = p.read_text()
    n = s.count(old)
    if n != 1:
        sys.exit(f"{rel}: anchor found {n} times:\n{old[:200]}")
    p.write_text(s.replace(old, new))


# ---- erasure_coding.rs: hedged slab key, chosen when the slab is complete; inner layer applied then ----
edit("erasure_coding.rs", """use crate::EncryptionKey;
use crate::encryption::Chacha20Cipher;
""", """use crate::EncryptionKey;
use crate::encryption::Chacha20Cipher;
use crate::object_encryption::hedged_key;
""")

edit("erasure_coding.rs", """pub(crate) struct SlabReader {
    data_shards: usize,
    encryption_key: EncryptionKey,
    shards: Vec<Vec<u8>>,
    /// Contiguous landing area for incoming data. The object keystream is
    /// applied to it in one call per fill, then the bytes are scattered into
    /// the interleaved shard layout. Allocated once and reused, so a slab
    /// costs no allocation here.
    read_buffer: Vec<u8>,
""", """pub(crate) struct SlabReader {
    data_shards: usize,
    shards: Vec<Vec<u8>>,
    /// PATCH (clone privacy): the current slab's plaintext ranges in slab
    /// order, each with the data key of the object it belongs to. The slab key
    /// is chosen, and these ranges encrypted, only once the slab is complete
    /// (see [seal](Self::seal)).
    segments: Vec<(usize, usize, EncryptionKey)>,
    /// Contiguous landing area for incoming data, scattered from here into
    /// the interleaved shard layout; when a slab is sealed, the same buffer
    /// holds one chunk at a time while the object keystream is applied.
    /// Allocated once and reused, so a slab costs no allocation here.
    read_buffer: Vec<u8>,
""")

edit("erasure_coding.rs", """    Ok(read_total)
}

impl SlabReader {""", """    Ok(read_total)
}

/// Visits the interleaved data-shard layout of slab bytes `start..start + len`
/// in slab order: `f(shard, offset in shard, offset in the range, length)`.
/// 64-byte segments are striped across the data shards.
fn for_each_striped(
    data_shards: usize,
    start: usize,
    len: usize,
    mut f: impl FnMut(usize, usize, usize, usize),
) {
    let stripe_size = SEGMENT_SIZE * data_shards;
    let mut off = 0;
    while off < len {
        let logical = start + off;
        let shard_index = (logical % stripe_size) / SEGMENT_SIZE;
        let byte_in_seg = logical % SEGMENT_SIZE;
        let dst = (logical / stripe_size) * SEGMENT_SIZE + byte_in_seg;
        let take = (SEGMENT_SIZE - byte_in_seg).min(len - off);
        f(shard_index, dst, off, take);
        off += take;
    }
}

/// PATCH (clone privacy): the domain of the hedged slab key derivation.
const SLAB_KEY_DOMAIN: &[u8] = b"sia_storage/slab-key/v1";

/// PATCH (clone privacy): the key of a complete slab, derived from fresh
/// randomness AND everything that determines the slab's ciphertext: the
/// layout, the length, each plaintext range with its data key, and the data
/// shards' plaintext (zero padding included). See
/// [hedged_key](crate::object_encryption::hedged_key). Every field before the
/// shards has a fixed width, so the encoding is unambiguous.
fn hedged_slab_key(
    total_shards: usize,
    length: usize,
    segments: &[(usize, usize, EncryptionKey)],
    data: &[Vec<u8>],
) -> EncryptionKey {
    let mut header = zeroize::Zeroizing::new(Vec::with_capacity(32 + segments.len() * 48));
    for v in [data.len(), total_shards, length, segments.len()] {
        header.extend((v as u64).to_le_bytes());
    }
    for (start, end, data_key) in segments {
        header.extend((*start as u64).to_le_bytes());
        header.extend((*end as u64).to_le_bytes());
        header.extend(data_key.as_ref());
    }
    let mut parts: Vec<&[u8]> = vec![header.as_slice()];
    parts.extend(data.iter().map(|d| d.as_slice()));
    hedged_key(SLAB_KEY_DOMAIN, &parts)
}

impl SlabReader {""")

edit("erasure_coding.rs", """        Self {
            data_shards,
            encryption_key: rand::random::<[u8; 32]>().into(),
            shards: vec![vec![0u8; SECTOR_SIZE]; total_shards],
""", """        Self {
            data_shards,
            shards: vec![vec![0u8; SECTOR_SIZE]; total_shards],
            segments: Vec::new(),
""")

edit("erasure_coding.rs", """        let length = self.length;
        let shards = mem::take(&mut self.shards);
        let encryption_key = mem::replace(&mut self.encryption_key, [0u8; 32].into());
        Some(ReadSlab {
            encryption_key,
            length,
            shards,
        })
    }
""", """        let length = self.length;
        let shards = mem::take(&mut self.shards);
        Some(self.seal(shards, length))
    }

    /// PATCH (clone privacy): completes a slab. Its key is chosen only now,
    /// from fresh randomness and the slab's whole content (`hedged_slab_key`),
    /// and only then is each range encrypted with its object's keystream, as
    /// [read_slab](Self::read_slab) used to do while reading.
    ///
    /// Why: a key chosen before the input is complete is shared by every copy
    /// of a running process (the copies' RNGs are copies too), so copies given
    /// different input would encrypt it under the same keystreams in both
    /// layers. With a hedged key they get independent keystreams unless the
    /// slab is identical, in which case the ciphertext is identical too:
    /// equality is all copies can reveal. With fresh randomness the key is as
    /// random as before. The stored format is unchanged.
    fn seal(&mut self, mut shards: Vec<Vec<u8>>, length: usize) -> ReadSlab {
        let segments = mem::take(&mut self.segments);
        let total_shards = shards.len();
        let encryption_key = hedged_slab_key(
            total_shards,
            length,
            &segments,
            &shards[..self.data_shards],
        );
        let data_shards = self.data_shards;
        for (start, end, data_key) in segments {
            let mut cipher = Chacha20Cipher::new_v1(data_key, start as u64, &encryption_key);
            let mut p = start;
            while p < end {
                let n = (end - p).min(self.read_buffer.len());
                let buf = &mut self.read_buffer[..n];
                for_each_striped(data_shards, p, n, |s, dst, off, take| {
                    buf[off..off + take].copy_from_slice(&shards[s][dst..dst + take]);
                });
                cipher.apply_keystream(buf);
                for_each_striped(data_shards, p, n, |s, dst, off, take| {
                    shards[s][dst..dst + take].copy_from_slice(&buf[off..off + take]);
                });
                p += n;
            }
        }
        self.read_buffer.fill(0); // it held plaintext
        ReadSlab {
            encryption_key,
            length,
            shards,
        }
    }
""")

edit("erasure_coding.rs", """        let mut cipher = Chacha20Cipher::new_v1(data_key, self.length as u64, &self.encryption_key);
        let mut total_read = 0;
        let stripe_size = SEGMENT_SIZE * self.data_shards;
""", """        let mut total_read = 0;
""")

edit("erasure_coding.rs", """            let start_len = self.length;
            cipher.apply_keystream(&mut self.read_buffer[..filled]);

            let mut off = 0;
            while off < filled {
                let logical = start_len + off;
                let shard_index = (logical % stripe_size) / SEGMENT_SIZE;
                let byte_in_seg = logical % SEGMENT_SIZE;
                let seg_start = (logical / stripe_size) * SEGMENT_SIZE;
                let dst = seg_start + byte_in_seg;
                let take = (SEGMENT_SIZE - byte_in_seg).min(filled - off);
                self.shards[shard_index][dst..dst + take]
                    .copy_from_slice(&self.read_buffer[off..off + take]);
                off += take;
            }
""", """            // PATCH (clone privacy): stored as plaintext and recorded with its
            // data key; `seal` encrypts it once the slab is complete. Recorded
            // as soon as it lands, so bytes from a read that errors later are
            // encrypted (with the failed object's key) like any others.
            let start_len = self.length;
            let (shards, buf) = (&mut self.shards, &self.read_buffer);
            for_each_striped(self.data_shards, start_len, filled, |s, dst, off, take| {
                shards[s][dst..dst + take].copy_from_slice(&buf[off..off + take]);
            });
            match self.segments.last_mut() {
                Some((_, end, key)) if *end == start_len && *key == data_key => *end += filled,
                _ => self.segments.push((start_len, start_len + filled, data_key.clone())),
            }
""")

edit("erasure_coding.rs", """            let shards = mem::replace(&mut self.shards, vec![vec![0u8; SECTOR_SIZE]; total_shards]);
            let encryption_key =
                mem::replace(&mut self.encryption_key, rand::random::<[u8; 32]>().into());
            Some(ReadSlab {
                encryption_key,
                length,
                shards,
            })
""", """            let shards = mem::replace(&mut self.shards, vec![vec![0u8; SECTOR_SIZE]; total_shards]);
            Some(self.seal(shards, length))
""")

# ---- object_encryption.rs: the hedged derivation, and the metadata key ----
edit("object_encryption.rs", """pub(crate) fn derive_encryption_key(key: &[u8], salt: &[u8], domain: &[u8]) -> EncryptionKey {""",
"""/// PATCH (clone privacy): 32 bytes derived from fresh randomness AND the
/// input they protect (a hedged derivation, in the spirit of RFC 8937 and of
/// hedged nonces): HMAC-BLAKE2b-256 keyed by 32 secret bytes of the process
/// RNG, over the length-prefixed `domain`, 32 bytes of OS randomness and
/// `parts`.
///
/// - Fresh RNG: the output is pseudorandom, as a plain random draw was.
/// - A copy of a running process repeats the process RNG (and a VM snapshot
///   or WASI host may repeat the OS RNG too): the output then still differs
///   for any different (domain, parts), and is equal only for equal input.
/// - The HMAC key never leaves the process, so an output is not a public
///   function of the input: it cannot be used to test guesses of it.
///
/// Callers encode `parts` unambiguously (fixed widths or length prefixes);
/// each use has its own `domain`.
fn hedged(domain: &[u8], parts: &[&[u8]]) -> [u8; HASH_SIZE] {
    let seed = zeroize::Zeroizing::new(rand::random::<[u8; 32]>());
    let mut os = zeroize::Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut os[..]).expect("OS randomness");
    let domain_len = (domain.len() as u64).to_le_bytes();
    let mut input: Vec<&[u8]> = Vec::with_capacity(parts.len() + 3);
    input.extend([domain_len.as_slice(), domain, os.as_slice()]);
    input.extend_from_slice(parts);
    hmac(seed.as_slice(), &input)
}

/// PATCH (clone privacy): a new key bound to its input, see [hedged].
pub(crate) fn hedged_key(domain: &[u8], parts: &[&[u8]]) -> EncryptionKey {
    let mut key = hedged(domain, parts);
    let out = EncryptionKey::from(key);
    zeroize::Zeroize::zeroize(&mut key);
    out
}

/// PATCH (clone privacy): a sealing nonce bound to what it seals, see
/// [hedged]: unique per (domain, input) even when copies repeat every RNG;
/// equal only when the sealed input is equal (then so is the ciphertext).
fn hedged_nonce(domain: &[u8], parts: &[&[u8]]) -> XNonce {
    let h = hedged(domain, parts);
    let nonce: [u8; NONCE_SIZE] = h[..NONCE_SIZE].try_into().unwrap();
    XNonce::from(nonce)
}

/// PATCH (clone privacy): a new metadata key for sealing `metadata` of object
/// `object_id`, hedged: copies of a running process seal different metadata
/// under different keys.
pub(crate) fn new_metadata_key(object_id: &Hash256, metadata: &[u8]) -> EncryptionKey {
    hedged_key(
        b"sia_storage/metadata-key/v1",
        &[object_id.as_ref(), &(metadata.len() as u64).to_le_bytes(), metadata],
    )
}

pub(crate) fn derive_encryption_key(key: &[u8], salt: &[u8], domain: &[u8]) -> EncryptionKey {""")

edit("object_encryption.rs", """        derive_encryption_key(app_key.as_ref(), object_id.as_ref(), b"dataKey");
    let encryption_key_cipher = XChaCha20Poly1305::new(data_encryption_key.as_ref().into());
    let nonce = XNonce::generate();""", """        derive_encryption_key(app_key.as_ref(), object_id.as_ref(), b"dataKey");
    let encryption_key_cipher = XChaCha20Poly1305::new(data_encryption_key.as_ref().into());
    // PATCH (clone privacy): hedged nonce, see `hedged_nonce`
    let nonce = hedged_nonce(
        b"sia_storage/seal-nonce/data-key/v1",
        &[object_id.as_ref(), encryption_key.as_ref()],
    );""")

edit("object_encryption.rs", """    let nonce = XNonce::generate();
    let encrypted_meta_key = encryption_key_cipher""", """    // PATCH (clone privacy): hedged nonce, see `hedged_nonce`
    let nonce = hedged_nonce(
        b"sia_storage/seal-nonce/metadata-key/v1",
        &[object_id.as_ref(), encryption_key.as_ref()],
    );
    let encrypted_meta_key = encryption_key_cipher""")

edit("object_encryption.rs", """    let metadata_cipher = XChaCha20Poly1305::new(meta_key.as_ref().into());
    let nonce = XNonce::generate();""", """    let metadata_cipher = XChaCha20Poly1305::new(meta_key.as_ref().into());
    // PATCH (clone privacy): hedged nonce, see `hedged_nonce`
    let nonce = hedged_nonce(
        b"sia_storage/seal-nonce/metadata/v1",
        &[&(metadata.len() as u64).to_le_bytes(), metadata],
    );""")

edit("object_encryption.rs", """use chacha20poly1305::aead::{Aead, Generate};""", """use chacha20poly1305::aead::Aead;""")

# ---- slabs.rs: use it ----
edit("slabs.rs", """            let metadata_key = EncryptionKey::from(rand::random::<[u8; 32]>());
            let encrypted_metadata_key = seal_metadata_key(key, &object_id, &metadata_key);""",
"""            // PATCH (clone privacy): hedged, see `new_metadata_key`
            let metadata_key = new_metadata_key(&object_id, &self.metadata);
            let encrypted_metadata_key = seal_metadata_key(key, &object_id, &metadata_key);""")
edit("slabs.rs", """    DecryptError, open_data_key, open_metadata, open_metadata_key, seal_data_key, seal_metadata,
    seal_metadata_key,
};""", """    DecryptError, new_metadata_key, open_data_key, open_metadata, open_metadata_key, seal_data_key,
    seal_metadata, seal_metadata_key,
};""")
print("fix applied")

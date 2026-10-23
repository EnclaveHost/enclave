//! PATCH (clone privacy review): copies of a running instance must not encrypt different plaintext under the same
//! keystream.
//!
//! C2 lets copies of a running sia-s3 coexist (REPLICATION.md "Copies of a running writer"), and every copy uploads
//! its sectors to the hosts, and pins their slabs (with the slab key) to the indexers, before any metadata or CAS
//! step can refuse it. A copy of a process copies its userspace RNG: rand's ThreadRng is not reseeded on fork
//! (rand 0.10 src/rngs/thread.rs), so the copies draw the same "random" keys from then on.
//!
//! These tests copy a RUNNING test process with fork(2), the closest a native test gets to a VM or WASM snapshot:
//! everything in memory is copied (the SDK, its mock network, the runtime, the RNG); nothing is seeded or mocked in
//! the key path. Each copy then runs the actual SDK upload path (`Sdk::upload`, `upload_packed`: SlabReader, erasure
//! coding, both XChaCha20 layers, the host transport) and the test reads back the exact bytes each copy's mock hosts
//! received. Nothing is pinned as an object: these are the bytes that leave the instance before metadata or CAS.
//! What fork does NOT copy is kernel state, so the OS RNG (getrandom) differs between the copies here; in a VM
//! snapshot it may not (see the metadata test).
//!
//! The property checked: for differing plaintext, XORing what the two copies' hosts received must not reveal the
//! plaintext relation (with one copy's plaintext known, the other's must not be recoverable). For identical input,
//! identical ciphertext is accepted and asserted: that equality is the leakage the candidate fix declares.
//!
//! Run them one at a time (`--test-threads=1`): a fork copies only the forking thread.

use std::cell::Cell;
use std::future::Future;
use std::io::{Cursor, Read, Write};
use std::os::unix::net::UnixStream;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};
use std::time::Duration;

use sia_core::rhp4::{SECTOR_SIZE, SEGMENT_SIZE};
use sia_storage::mock::MockNetwork;
use sia_storage::{AppKey, Object, PackedUploadOptions, Slab, UploadOptions};
use tokio::io::{AsyncRead, ReadBuf};

unsafe extern "C" {
    fn fork() -> i32;
    fn _exit(code: i32) -> !;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
}
const SIGKILL: i32 = 9;

const DATA: u8 = 3;
const PARITY: u8 = 9; // 3 + 9: the smallest layout the SDK accepts
const SLAB: usize = DATA as usize * SECTOR_SIZE;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Role {
    NotCopied,
    /// The original process ("copy A"); holds the other copy's pid.
    Parent(i32),
    /// The copy ("copy B").
    Child,
}

/// Where the test takes its copy. `now()` forks the whole process at that point; both copies continue from there.
#[derive(Clone)]
struct Copier(Rc<Cell<Role>>);

impl Copier {
    fn now(&self) -> Role {
        assert_eq!(self.0.get(), Role::NotCopied, "one copy per test");
        let pid = unsafe { fork() };
        assert!(pid >= 0, "fork failed");
        let role = if pid == 0 { Role::Child } else { Role::Parent(pid) };
        self.0.set(role);
        role
    }
    fn is_child(&self) -> bool {
        self.0.get() == Role::Child
    }
}

/// One slab as the hosts received it: its key (sent to the indexer in the slab pin), its range in its object and
/// the bytes of its data shards, exactly as stored by the mock hosts.
#[derive(Debug, Clone, PartialEq)]
struct Captured {
    key: [u8; 32],
    offset: u32,
    length: u32,
    data_shards: Vec<Vec<u8>>,
}

fn capture(net: &MockNetwork, slabs: &[Slab]) -> Vec<Captured> {
    slabs
        .iter()
        .map(|s| Captured {
            key: *s.encryption_key.as_ref(),
            offset: s.offset,
            length: s.length,
            data_shards: s.sectors[..s.min_shards as usize]
                .iter()
                .map(|sec| net.raw_sector(&sec.host_key, &sec.root).expect("the host holds the sector it was sent"))
                .collect(),
        })
        .collect()
}

fn encode(slabs: &[Captured]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend((slabs.len() as u32).to_le_bytes());
    for s in slabs {
        out.extend(s.key);
        out.extend(s.offset.to_le_bytes());
        out.extend(s.length.to_le_bytes());
        out.extend((s.data_shards.len() as u32).to_le_bytes());
        for d in &s.data_shards {
            out.extend((d.len() as u32).to_le_bytes());
            out.extend(d);
        }
    }
    out
}

fn decode(mut b: &[u8]) -> Vec<Captured> {
    fn u32_(b: &mut &[u8]) -> u32 {
        let v = u32::from_le_bytes(b[..4].try_into().unwrap());
        *b = &b[4..];
        v
    }
    let n = u32_(&mut b);
    (0..n)
        .map(|_| {
            let key: [u8; 32] = b[..32].try_into().unwrap();
            b = &b[32..];
            let offset = u32_(&mut b);
            let length = u32_(&mut b);
            let shards = u32_(&mut b);
            let data_shards = (0..shards)
                .map(|_| {
                    let len = u32_(&mut b) as usize;
                    let d = b[..len].to_vec();
                    b = &b[len..];
                    d
                })
                .collect();
            Captured { key, offset, length, data_shards }
        })
        .collect()
}

/// Runs `test` on a fresh runtime (time driver only: no epoll or eventfd shared with the copy). `test` takes the copy
/// with its `Copier`; both copies then finish `test`. Returns (copy A's capture, copy B's capture). Copy B never
/// returns into the test harness: it hands its capture over a socket and exits.
fn copied<F, Fut>(test: F) -> (Vec<Captured>, Vec<Captured>)
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
{
    let (mut to_a, mut to_b) = UnixStream::pair().unwrap();
    let copier = Copier(Rc::new(Cell::new(Role::NotCopied)));
    let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    let res = std::panic::catch_unwind(AssertUnwindSafe(|| rt.block_on(test(copier.clone()))));
    match copier.0.get() {
        Role::Child => {
            drop(to_a);
            let code = match res {
                Ok(c) => match to_b.write_all(&c) {
                    Ok(()) => 0,
                    Err(_) => 102,
                },
                Err(_) => 101,
            };
            drop(to_b);
            unsafe { _exit(code) }
        }
        Role::Parent(pid) => {
            drop(to_b);
            let reap = |pid: i32| -> i32 {
                let mut status = 0;
                unsafe { waitpid(pid, &mut status, 0) };
                status
            };
            let a = match res {
                Ok(a) => a,
                Err(e) => {
                    unsafe { kill(pid, SIGKILL) };
                    reap(pid);
                    std::panic::resume_unwind(e)
                }
            };
            to_a.set_read_timeout(Some(Duration::from_secs(240))).unwrap();
            let mut raw = Vec::new();
            if let Err(e) = to_a.read_to_end(&mut raw) {
                unsafe { kill(pid, SIGKILL) };
                reap(pid);
                panic!("copy B did not hand over its capture: {e}");
            }
            let status = reap(pid);
            assert_eq!(status, 0, "copy B failed (wait status {status:#x}; 101 << 8: it panicked)");
            (a, raw)
        }
        Role::NotCopied => panic!("the test never took its copy"),
    }
}

/// Where logical byte `p` of a slab lands: (data shard, offset in it). The SDK stripes 64-byte segments across the
/// data shards (erasure_coding.rs `read_slab`).
fn stripe(p: usize) -> (usize, usize) {
    let stripe = SEGMENT_SIZE * DATA as usize;
    ((p % stripe) / SEGMENT_SIZE, (p / stripe) * SEGMENT_SIZE + p % SEGMENT_SIZE)
}

#[derive(Debug, Default)]
struct Relation {
    keys_equal: bool,
    compared: usize,
    /// bytes of B's plaintext recovered as A's ciphertext ^ B's ciphertext ^ A's plaintext (chance: 1 in 256)
    recovered: usize,
    identical_ciphertext: bool,
}

/// Compares the data shards of one slab from each copy, given the slab's plaintext in each (its `length` bytes, in
/// slab order).
fn relate(a: &Captured, b: &Captured, pa: &[u8], pb: &[u8]) -> Relation {
    assert_eq!((a.length, b.length), (pa.len() as u32, pb.len() as u32));
    let mut r = Relation { keys_equal: a.key == b.key, identical_ciphertext: a.data_shards == b.data_shards, ..Default::default() };
    for p in 0..pa.len() {
        let (s, o) = stripe(p);
        r.compared += 1;
        if a.data_shards[s][o] ^ b.data_shards[s][o] ^ pa[p] == pb[p] {
            r.recovered += 1;
        }
    }
    r
}

/// The safety property for one slab whose plaintext differs between the copies.
fn assert_no_keystream_reuse(what: &str, r: &Relation) {
    eprintln!("{what}: {r:?}");
    assert!(
        r.recovered * 50 < r.compared,
        "LEAK ({what}): copy B's plaintext is recovered from the two copies' host bytes and copy A's plaintext: \
         {}/{} bytes (slab keys equal: {}). Both XChaCha20 layers reused their keystream for different plaintext.",
        r.recovered,
        r.compared,
        r.keys_equal
    );
    assert!(!r.keys_equal, "LEAK ({what}): both copies chose the same slab key for different plaintext");
}

/// A deterministic, incompressible test plaintext (not secret; stands in for a client's data).
fn plaintext(tag: &str, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut ctr = 0u64;
    while out.len() < len {
        use sha2::Digest;
        out.extend_from_slice(&sha2::Sha256::new().chain_update(tag.as_bytes()).chain_update(ctr.to_le_bytes()).finalize());
        ctr += 1;
    }
    out.truncate(len);
    out
}

fn opts() -> UploadOptions {
    UploadOptions { data_shards: DATA, parity_shards: PARITY, max_buffered_slabs: Some(1), ..Default::default() }
}

async fn network() -> (MockNetwork, sia_storage::Sdk) {
    let net = MockNetwork::new();
    net.add_hosts(12);
    let sdk = net.sdk(AppKey::import([0x5a; 32])).await.unwrap();
    (net, sdk)
}

/// A request body arriving in two parts. The process is copied when the first `split` bytes have been consumed (the
/// SDK reads up to a slab boundary at most, so with `split` = a slab the first slab is complete then); after the
/// copy, each copy reads its own tail.
struct CopyingReader {
    head: Vec<u8>,
    tail_a: Vec<u8>,
    tail_b: Vec<u8>,
    pos: usize,
    copier: Copier,
}

impl AsyncRead for CopyingReader {
    fn poll_read(mut self: Pin<&mut Self>, _: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let me = &mut *self;
        if me.pos == me.head.len() && me.copier.0.get() == Role::NotCopied {
            me.copier.now();
        }
        let src: &[u8] = if me.pos < me.head.len() {
            &me.head[me.pos..]
        } else {
            let tail = if me.copier.is_child() { &me.tail_b } else { &me.tail_a };
            &tail[me.pos - me.head.len()..]
        };
        let n = src.len().min(buf.remaining());
        buf.put_slice(&src[..n]);
        me.pos += n;
        Poll::Ready(Ok(()))
    }
}

/// Next-object key generation: an idle, running instance is copied; each copy then uploads a different body (as a
/// host routing two clients' PUTs to two copies would make them). Old SDK: both copies draw the same data key and
/// slab key, so the data shards XOR to the plaintexts' XOR.
#[test]
fn copies_of_an_idle_instance_encrypt_different_uploads_under_different_keystreams() {
    let len = 3 * (1 << 20) + 123; // one partial slab: the `finish` path
    let (pa, pb) = (plaintext("A: known to the attacker", len), plaintext("B: secret", len));
    let (pa2, pb2) = (pa.clone(), pb.clone());
    let (a, b) = copied(|copier| async move {
        let (net, sdk) = network().await;
        // (no earlier upload: fork cannot copy the runtime's blocking-pool threads; the RNG is copied either way)
        sia_storage::mock::repeat_os_randomness(Some([0x0f; 32])); // worst case: the OS RNG repeats too
        copier.now();
        let body = if copier.is_child() { pb2 } else { pa2 };
        let obj = sdk.upload(Object::default(), Cursor::new(body), opts()).await.unwrap();
        capture(&net, obj.slabs())
    });
    assert_eq!((a.len(), b.len()), (1, 1));
    assert_no_keystream_reuse("new upload after the copy", &relate(&a[0], &b[0], &pa, &pb));
}

/// Next-slab key generation inside one streamed upload: the instance is copied after the first slab of a body was
/// read (old SDK: the second slab's key is already chosen then), and the copies continue with different tails.
/// The first slab, the same input in both, must be identical (equality is the only leak accepted).
#[test]
fn copies_mid_upload_encrypt_different_continuations_under_different_keystreams() {
    let tail = (1 << 20) + 5;
    let head = plaintext("head", SLAB);
    let (ta, tb) = (plaintext("tail A: known", tail), plaintext("tail B: secret", tail));
    let (h2, ta2, tb2) = (head.clone(), ta.clone(), tb.clone());
    let (a, b) = copied(|copier| async move {
        let (net, sdk) = network().await;
        sia_storage::mock::repeat_os_randomness(Some([0x0f; 32])); // worst case: the OS RNG repeats too
        let reader = CopyingReader { head: h2, tail_a: ta2, tail_b: tb2, pos: 0, copier };
        let obj = sdk.upload(Object::default(), reader, opts()).await.unwrap();
        capture(&net, obj.slabs())
    });
    assert_eq!((a.len(), b.len()), (2, 2));
    let first = relate(&a[0], &b[0], &head, &head);
    eprintln!("first slab (same input in both copies): {first:?}");
    assert!(first.identical_ciphertext && first.keys_equal, "the copied first slab is the same upload in both copies");
    assert_no_keystream_reuse("second slab after a mid-upload copy", &relate(&a[1], &b[1], &ta, &tb));
}

/// A copy that continues with the SAME input (a host replaying the same request bytes) produces the same
/// ciphertext: no new information beyond equality, before and after the fix.
#[test]
fn copies_mid_upload_with_the_same_input_produce_identical_ciphertext() {
    let head = plaintext("head", SLAB);
    let t = plaintext("same tail", (1 << 20) + 5);
    let (h2, t2) = (head.clone(), t.clone());
    let (a, b) = copied(|copier| async move {
        let (net, sdk) = network().await;
        sia_storage::mock::repeat_os_randomness(Some([0x0f; 32])); // worst case: the OS RNG repeats too
        let reader = CopyingReader { head: h2, tail_a: t2.clone(), tail_b: t2, pos: 0, copier };
        let obj = sdk.upload(Object::default(), reader, opts()).await.unwrap();
        capture(&net, obj.slabs())
    });
    // worst case (every RNG repeated): equal input gives equal bytes, the equality leak the fix accepts
    assert_eq!(a, b, "same input after the copy: the same bytes reach the hosts");
}

/// Packed uploads (sia-s3 `import`, repacking small keys): objects with different data keys share a slab. The copy
/// is taken between the first (identical) object and the second (different) one.
#[test]
fn copies_of_a_packed_upload_encrypt_different_objects_under_different_keystreams() {
    let n = 600_000;
    let common = plaintext("first object, same in both", n);
    let (oa, ob) = (plaintext("second object A: known", n), plaintext("second object B: secret", n));
    let (c2, oa2, ob2) = (common.clone(), oa.clone(), ob.clone());
    let (a, b) = copied(|copier| async move {
        let (net, sdk) = network().await;
        let mut packed = sdk
            .upload_packed(PackedUploadOptions { data_shards: DATA, parity_shards: PARITY, max_buffered_slabs: Some(1), shard_uploaded: None })
            .unwrap();
        packed.add(Cursor::new(c2)).await.unwrap();
        sia_storage::mock::repeat_os_randomness(Some([0x0f; 32])); // worst case: the OS RNG repeats too
        copier.now();
        packed.add(Cursor::new(if copier.is_child() { ob2 } else { oa2 })).await.unwrap();
        let objs = packed.finalize().await.unwrap();
        assert_eq!(objs.len(), 2);
        assert_eq!(objs[1].slabs().len(), 1, "both objects share one slab");
        capture(&net, objs[1].slabs())
    });
    assert_eq!(a[0].offset as usize, n);
    // the whole slab in slab order: first object, then the second
    let sa: Vec<u8> = common.iter().chain(&oa).copied().collect();
    let sb: Vec<u8> = common.iter().chain(&ob).copied().collect();
    let whole = |c: &Captured| Captured { offset: 0, length: (2 * n) as u32, ..c.clone() };
    let r = relate(&whole(&a[0]), &whole(&b[0]), &sa, &sb);
    // only the second object differs; count recovery over it alone
    let mut tail = Relation { keys_equal: r.keys_equal, ..Default::default() };
    for p in n..2 * n {
        let (s, o) = stripe(p);
        tail.compared += 1;
        if a[0].data_shards[s][o] ^ b[0].data_shards[s][o] ^ sa[p] == sb[p] {
            tail.recovered += 1;
        }
    }
    assert_no_keystream_reuse("packed slab, the object added after the copy", &tail);
}

/// Metadata sealing (sia-s3 keeps its whole key index in object metadata). Old SDK: a copy draws the same metadata
/// key, so only the XChaCha20-Poly1305 nonce (from the OS RNG: different after a fork, possibly repeated in a VM
/// snapshot or by a WASI host) separates two copies' different metadata. Hedged: different metadata gets a different
/// key, the same metadata the same key.
#[test]
fn copies_seal_different_metadata_under_different_keys() {
    // per copy: [metadata key, sealed metadata key (24 nonce + 32 + 16 tag)] for different, then for the same metadata
    let (a, b) = copied_bytes(|copier| async move {
        let key = AppKey::import([0x5a; 32]);
        let mut obj = Object::default(); // one object, made before the copy
        sia_storage::mock::repeat_os_randomness(Some([0x0f; 32])); // worst case: the OS RNG repeats too
        copier.now();
        let mut out = Vec::new();
        for m in [if copier.is_child() { "copy B: secret key names" } else { "copy A: known key names" }, "the same in both"] {
            obj.metadata = m.as_bytes().to_vec();
            let sealed = obj.seal(&key);
            out.extend(sia_storage::mock::opened_metadata_key(&key, &sealed).expect("sealed with metadata"));
            assert_eq!(sealed.encrypted_metadata_key.len(), 72);
            out.extend(&sealed.encrypted_metadata_key);
        }
        out
    });
    let (ka, kb) = (&a[..32], &b[..32]);
    let (sa, sb) = (&a[32..104], &b[32..104]);
    eprintln!(
        "different metadata: keys equal {}, sealing nonces equal {}; same metadata: keys equal {}, sealed bytes equal {}",
        ka == kb,
        sa[..24] == sb[..24],
        a[104..136] == b[104..136],
        a[136..] == b[136..]
    );
    assert_ne!(ka, kb, "copies sealed different metadata under the SAME metadata key");
    // the two metadata keys are sealed under the same per-object key: a repeated nonce would expose their XOR
    assert_ne!(sa[..24], sb[..24], "the two copies sealed different metadata keys under the same nonce");
    let xor_ct: Vec<u8> = sa[24..56].iter().zip(&sb[24..56]).map(|(x, y)| x ^ y).collect();
    let xor_pt: Vec<u8> = ka.iter().zip(kb).map(|(x, y)| x ^ y).collect();
    assert_ne!(xor_ct, xor_pt, "the sealed metadata keys XOR to the keys' XOR: keystream reuse");
    // worst case (every RNG repeated): the same metadata seals to the same bytes (equality only)
    assert_eq!(a[104..], b[104..], "the same metadata, the same sealed bytes");
}

// ---- Correctness of the upload path the fix changes (no copies): streaming, multiple slabs, ranges, packed uploads
// with a failed add, overwrites, and data written by another SDK build (legacy reads). They pass before and after.

async fn download(sdk: &sia_storage::Sdk, obj: &Object, offset: u64, length: Option<u64>) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut d = sdk.download(obj, sia_storage::DownloadOptions { offset, length, ..Default::default() }).unwrap();
    let mut out = Vec::new();
    d.read_to_end(&mut out).await.unwrap();
    out
}

/// Serves `data` in irregular small chunks, as a network body arrives.
struct Trickle {
    data: Vec<u8>,
    pos: usize,
    chunk: usize,
}

impl AsyncRead for Trickle {
    fn poll_read(mut self: Pin<&mut Self>, _: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let me = &mut *self;
        let n = (me.data.len() - me.pos).min(buf.remaining()).min(me.chunk);
        buf.put_slice(&me.data[me.pos..me.pos + n]);
        me.pos += n;
        me.chunk = if me.chunk > 9000 { 1777 } else { me.chunk * 2 + 1 };
        Poll::Ready(Ok(()))
    }
}

/// Serves `data`, then fails (a client connection dropped part-way).
struct FailsAfter {
    data: Vec<u8>,
    pos: usize,
}

impl AsyncRead for FailsAfter {
    fn poll_read(mut self: Pin<&mut Self>, _: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let me = &mut *self;
        if me.pos == me.data.len() {
            return Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "client went away")));
        }
        let n = (me.data.len() - me.pos).min(buf.remaining());
        buf.put_slice(&me.data[me.pos..me.pos + n]);
        me.pos += n;
        Poll::Ready(Ok(()))
    }
}

#[tokio::test]
async fn streamed_multi_slab_uploads_read_back_whole_and_by_range() {
    let (_net, sdk) = network().await;
    let data = plaintext("multi-slab", 2 * SLAB + 777_777);
    let obj = sdk.upload(Object::default(), Trickle { data: data.clone(), pos: 0, chunk: 1 }, opts()).await.unwrap();
    assert_eq!(obj.slabs().len(), 3);
    assert_ne!(obj.slabs()[0].encryption_key, obj.slabs()[1].encryption_key);
    assert_eq!(download(&sdk, &obj, 0, None).await, data);
    for (off, len) in [(SLAB - 100, 300), (2 * SLAB - 1, 2), (12345, 64 * 1024 + 3), (2 * SLAB + 777_000, 777)] {
        assert_eq!(download(&sdk, &obj, off as u64, Some(len as u64)).await, data[off..off + len], "range {off}+{len}");
    }
}

/// A packed add whose reader fails part-way leaves its landed bytes in the slab as padding: they must be encrypted
/// like everything else (under the failed object's key), never stored as plaintext.
#[tokio::test]
async fn packed_uploads_with_a_failed_add_read_back_and_never_store_plaintext() {
    let (net, sdk) = network().await;
    let marker: Vec<u8> = b"PLAINTEXT-MARKER".iter().copied().cycle().take(64 * 1024).collect();
    let (a, c) = (plaintext("packed a", 100_000), plaintext("packed c", SLAB));
    let mut packed = sdk
        .upload_packed(PackedUploadOptions { data_shards: DATA, parity_shards: PARITY, max_buffered_slabs: Some(1), shard_uploaded: None })
        .unwrap();
    packed.add(Cursor::new(a.clone())).await.unwrap();
    assert!(packed.add(FailsAfter { data: marker.clone(), pos: 0 }).await.is_err());
    packed.add(Cursor::new(c.clone())).await.unwrap(); // spans into a second slab
    packed.add(Cursor::new(Vec::new())).await.unwrap(); // empty
    let objs = packed.finalize().await.unwrap();
    assert_eq!(objs.len(), 3);
    assert_eq!(download(&sdk, &objs[0], 0, None).await, a);
    assert_eq!(download(&sdk, &objs[1], 0, None).await, c);
    assert!(objs[2].slabs().is_empty());
    for slab in objs[1].slabs() {
        for (i, sec) in slab.sectors.iter().enumerate() {
            let mut raw = net.raw_sector(&sec.host_key, &sec.root).unwrap();
            assert!(!raw.windows(16).any(|w| w == b"PLAINTEXT-MARKER"), "plaintext of the failed add reached a host");
            if i < DATA as usize {
                // the indexer knows the slab key: the object-key layer alone must hide it too
                sia_storage::mock::strip_slab_key_layer(&slab.encryption_key, i as u8, &mut raw);
                assert!(!raw.windows(16).any(|w| w == b"PLAINTEXT-MARKER"), "only the slab-key layer hid the failed add");
            }
        }
    }
}

#[tokio::test]
async fn overwrites_inside_an_object_read_back() {
    let (_net, sdk) = network().await;
    let mut data = plaintext("overwrite base", SLAB + 500_000);
    let obj = sdk.upload(Object::default(), Cursor::new(data.clone()), opts()).await.unwrap();
    let patch = plaintext("overwrite patch", 300_000);
    let at = SLAB - 100_000;
    let o = UploadOptions { start_offset: Some(at as u64), ..opts() };
    let obj = sdk.upload(obj, Cursor::new(patch.clone()), o).await.unwrap();
    data[at..at + patch.len()].copy_from_slice(&patch);
    assert_eq!(download(&sdk, &obj, 0, None).await, data);
}

/// Data written by one SDK build must read in another: the format is unchanged. The first run (on the unmodified
/// SDK) writes the fixture: sealed objects (with metadata) plus two data shards and one parity shard of each slab, so
/// reading also reconstructs a missing data shard. Every later run reads it with its own SDK, from those sectors only.
#[tokio::test]
async fn legacy_fixture_written_by_one_sdk_build_reads_in_another() {
    use sia_core::types::v2::{NetAddress, Protocol};
    use sia_storage::{Host, PublicKey, SealedObject};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../legacy-fixture/fixture.bin");
    let key = AppKey::import([0x5a; 32]);
    let a = plaintext("legacy object", SLAB + (1 << 20) + 5);
    let (p1, p2) = (plaintext("legacy packed 1", 600_000), plaintext("legacy packed 2", 700_000));
    if !path.exists() {
        let (net, sdk) = network().await;
        let mut oa = Object::default();
        oa.metadata = b"legacy metadata a".to_vec();
        let oa = sdk.upload(oa, Cursor::new(a.clone()), opts()).await.unwrap();
        let mut packed = sdk
            .upload_packed(PackedUploadOptions { data_shards: DATA, parity_shards: PARITY, max_buffered_slabs: Some(1), shard_uploaded: None })
            .unwrap();
        packed.add(Cursor::new(p1.clone())).await.unwrap();
        packed.add(Cursor::new(p2.clone())).await.unwrap();
        let mut objs = packed.finalize().await.unwrap();
        objs[1].metadata = b"legacy metadata p2".to_vec();
        let all = [oa, objs.remove(0), objs.remove(0)];
        let sealed: Vec<SealedObject> = all.iter().map(|o| o.seal(&key)).collect();
        let json = serde_json::to_vec(&sealed).unwrap();
        let mut out = Vec::new();
        out.extend((json.len() as u32).to_le_bytes());
        out.extend(&json);
        let mut seen = std::collections::HashSet::new();
        for o in &all {
            for slab in o.slabs() {
                for sec in &slab.sectors[1..4] {
                    if seen.insert(sec.root) {
                        out.extend(sec.host_key.as_ref());
                        out.extend(net.raw_sector(&sec.host_key, &sec.root).unwrap());
                    }
                }
            }
        }
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, out).unwrap();
        eprintln!("legacy fixture WRITTEN by this build: {}", path.display());
    }
    let raw = std::fs::read(&path).unwrap();
    let n = u32::from_le_bytes(raw[..4].try_into().unwrap()) as usize;
    let sealed: Vec<SealedObject> = serde_json::from_slice(&raw[4..4 + n]).unwrap();
    let net = MockNetwork::new();
    let mut hosts = Vec::new();
    for rec in raw[4 + n..].chunks(32 + SECTOR_SIZE) {
        let host = PublicKey::new(rec[..32].try_into().unwrap());
        net.put_raw_sector(host, rec[32..].to_vec());
        hosts.push(Host {
            public_key: host,
            addresses: vec![NetAddress { protocol: Protocol::QUIC, address: "localhost:9984".into() }],
            country_code: "US".into(),
            latitude: 0.0,
            longitude: 0.0,
            good_for_upload: false,
        });
    }
    assert_eq!(hosts.len(), 9, "3 slabs, 3 sectors each");
    let reader = net.recovery_reader(key.clone(), hosts);
    let want: [(&[u8], &[u8]); 3] = [(&a, b"legacy metadata a"), (&p1, b""), (&p2, b"legacy metadata p2")];
    for (s, (data, meta)) in sealed.into_iter().zip(want) {
        let obj = s.open(&key).unwrap();
        assert_eq!(obj.metadata, meta);
        use tokio::io::AsyncReadExt;
        let mut d = reader.download(&obj, Default::default()).unwrap();
        let mut got = Vec::new();
        d.read_to_end(&mut got).await.unwrap();
        assert_eq!(got, data);
    }
    eprintln!("legacy fixture read back by this build");
}

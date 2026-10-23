//! Explicit snapshot export and verified, read-only recovery. Recovery never
//! constructs an Sdk/indexer client, sweeps orphans, compacts, or updates metadata.
//!
//! A key stored behind a manifest (store.rs) is referenced by its manifest
//! object (`entry` absent, snapshot version 2). Its body is read from the
//! snapshot's hosts at recovery time and checked against the length and
//! SHA-256 in the manifest's sealed, signed metadata, so it is no more
//! exposed in the snapshot than any other key name.
//!
//! `restore` recovers EVERY key of a snapshot into a new directory (see restore_with for the integrity model).
use crate::store::{Entry, Index, Key, MAX_MANIFEST, Meta, MfRef, Store, parse_manifest, qkey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sia_storage::{
    AppKey, Builder, DownloadOptions, Host, HostQuery, RecoveryReader, SealedObject,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tokio::io::AsyncReadExt;
type Res<T> = Result<T, String>;
const MAX_SNAPSHOT: u64 = 64 * 1024 * 1024;
const MAX_OBJECTS: usize = 100_000;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    created_at: String,
    hosts: Vec<Host>,
    objects: BTreeMap<String, SealedObject>,
    // References select the exact resolved S3 keys without exposing their names.
    keys: Vec<KeyRef>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyRef {
    object: String,
    /// the entry's position in the object's metadata; absent for a manifest object
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entry: Option<usize>,
}
/// Manifest objects named by a snapshot, by key hash: (object id, signed metadata).
type Manifests = HashMap<String, (String, MfRef)>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn hash_arg(s: &str) -> Res<()> {
    if s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        Ok(())
    } else {
        Err("expected a lowercase SHA-256".into())
    }
}
fn bounded(path: &Path, max: u64) -> Res<Vec<u8>> {
    let mut out = Vec::new();
    File::open(path)
        .map_err(err)?
        .take(max + 1)
        .read_to_end(&mut out)
        .map_err(err)?;
    if out.len() as u64 > max {
        return Err("input exceeds size limit".into());
    }
    Ok(out)
}
fn key_file() -> Res<AppKey> {
    let path =
        std::env::var("SIA_RECOVERY_KEY_FILE").map_err(|_| "SIA_RECOVERY_KEY_FILE is required")?;
    let raw = bounded(Path::new(&path), 128)?;
    let text = std::str::from_utf8(&raw)
        .map_err(|_| "invalid recovery key")?
        .trim();
    let bytes: [u8; 32] = hex::decode(text)
        .map_err(|_| "invalid recovery key")?
        .try_into()
        .map_err(|_| "invalid recovery key")?;
    Ok(AppKey::import(bytes))
}
struct Pending {
    path: PathBuf,
    file: File,
}
impl Pending {
    fn new(destination: &Path) -> Res<Self> {
        if destination.exists() {
            return Err("destination already exists".into());
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(err)?;
        let path = destination
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!(".sia-recovery-{}", hex::encode(nonce)));
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(&path).map_err(err)?;
        Ok(Self { path, file })
    }
    fn commit(mut self, destination: &Path) -> Res<()> {
        self.file.flush().map_err(err)?;
        self.file.sync_all().map_err(err)?;
        // Atomic create without overwriting a file/symlink that appeared mid-read.
        fs::hard_link(&self.path, destination).map_err(err)?;
        Ok(())
    }
}
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
fn open_snapshot(raw: &[u8], expected: &str, key: &AppKey) -> Res<(Index, Vec<Host>, Manifests)> {
    hash_arg(expected)?;
    if raw.len() as u64 > MAX_SNAPSHOT || digest(raw) != expected {
        return Err("snapshot digest or size mismatch".into());
    }
    let snap: Snapshot = serde_json::from_slice(raw).map_err(err)?;
    if !(snap.version == 1 || snap.version == 2)
        || snap.objects.len() > MAX_OBJECTS
        || snap.keys.len() > MAX_OBJECTS
        || snap.hosts.len() > 10000
    {
        return Err("invalid snapshot limits/version".into());
    }
    let mut seen = HashSet::new();
    for host in &snap.hosts {
        if !seen.insert(host.public_key) {
            return Err("duplicate host identity".into());
        }
    }
    let mut idx = Index::default();
    for (id, sealed) in snap.objects {
        let obj = sealed.open(key).map_err(err)?;
        if obj.id().to_string() != id {
            return Err("object identity mismatch".into());
        }
        let meta: Meta = serde_json::from_slice(&obj.metadata).map_err(err)?;
        if !(meta.v == 1 || meta.v == 2) {
            return Err("unknown S3 metadata version".into());
        }
        idx.objs.insert(id, (obj, meta));
    }
    let mut manifests = Manifests::new();
    for r in snap.keys {
        let (_, m) = idx.objs.get(&r.object).ok_or("missing key object")?;
        match r.entry {
            Some(e) => {
                let entry = m.e.get(e).ok_or("missing key entry")?.clone();
                let kk = (entry.b.clone(), entry.k.clone());
                if idx.keys.insert(kk, Key { host: r.object, entry, manifest: false }).is_some() {
                    return Err("duplicate S3 key".into());
                }
            }
            None if snap.version == 2 => {
                let mf = m.mf.clone().ok_or("a manifest reference names an object that is not a manifest")?;
                if manifests.insert(mf.q.clone(), (r.object, mf)).is_some() {
                    return Err("duplicate S3 key".into());
                }
            }
            None => return Err("invalid snapshot limits/version".into()),
        }
    }
    for kk in idx.keys.keys() {
        if manifests.contains_key(&qkey(&kk.0, &kk.1)) {
            return Err("duplicate S3 key".into());
        }
    }
    for k in idx.keys.values() {
        let segs = idx.segments(k, 0, k.entry.s)?;
        let size = segs
            .iter()
            .try_fold(0u64, |n, (_, _, len)| n.checked_add(*len))
            .ok_or("segment size overflow")?;
        if size != k.entry.s {
            return Err("incomplete multipart key".into());
        }
    }
    Ok((idx, snap.hosts, manifests))
}
/// Serialize the resolved keys of a loaded store, with every object they need, sealed.
async fn snapshot_bytes(store: &Store, hosts: Vec<Host>, key: &AppKey) -> Res<Vec<u8>> {
    let idx = store.idx.lock().await;
    if !idx.unresolved.is_empty() {
        return Err("the indexer lists manifests whose bodies could not be read: refusing an incomplete snapshot".into());
    }
    if idx.objs.len() > MAX_OBJECTS || idx.keys.len() > MAX_OBJECTS {
        return Err("too many objects/keys".into());
    }
    let mut objects = BTreeMap::new();
    let mut keys = Vec::new();
    let mut version = 1;
    for k in idx.keys.values() {
        let (_, meta) = idx.objs.get(&k.host).ok_or("missing host object")?;
        let entry = if k.manifest {
            version = 2;
            None
        } else {
            Some(meta.e.iter().position(|e| e == &k.entry).ok_or("missing key entry")?)
        };
        keys.push(KeyRef { object: k.host.clone(), entry });
        for id in k.objects() {
            let (obj, _) = idx.objs.get(&id).ok_or("missing multipart object")?;
            objects.entry(id).or_insert_with(|| obj.seal(key));
        }
    }
    serde_json::to_vec(&Snapshot { version, created_at: chrono::Utc::now().to_rfc3339(), hosts, objects, keys }).map_err(err)
}
async fn export(indexer: &str, destination: &Path, key: AppKey) -> Res<()> {
    let sdk = Builder::new(indexer, crate::META)
        .map_err(err)?
        .connected(&key)
        .await
        .map_err(err)?
        .ok_or("app key not authorized")?;
    let store = Store::load(sdk.clone(), 0).await?; // read only; do not call boot/sweep
    let mut hosts = Vec::new();
    loop {
        let batch = sdk
            .hosts(HostQuery {
                offset: Some(hosts.len() as u64),
                limit: Some(500),
                ..Default::default()
            })
            .await
            .map_err(err)?;
        let done = batch.len() < 500;
        hosts.extend(batch);
        if hosts.len() > 10000 {
            return Err("too many hosts".into());
        }
        if done {
            break;
        }
    }
    let raw = snapshot_bytes(&store, hosts, &key).await?;
    let sha = digest(&raw);
    let (verified, _, manifests) = open_snapshot(&raw, &sha, &key)?;
    let mut pending = Pending::new(destination)?;
    pending.file.write_all(&raw).map_err(err)?;
    pending.commit(destination)?;
    println!(
        "{}",
        serde_json::json!({"snapshotSha256":sha,"snapshotBytes":raw.len(),"objects":verified.objs.len(),"keys":verified.keys.len() + manifests.len(),"manifestKeys":manifests.len(),"readOnlyExport":true})
    );
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn recover(
    snapshot: &Path,
    sha: &str,
    bucket: &str,
    name: &str,
    destination: &Path,
    expected_sha: &str,
    expected_size: u64,
    key: AppKey,
) -> Res<()> {
    recover_with(snapshot, sha, bucket, name, destination, expected_sha, expected_size, key, RecoveryReader::new).await
}
/// Read a manifest body from the snapshot's hosts and check it against its signed metadata.
async fn read_manifest(reader: &RecoveryReader, idx: &Index, id: &str, mf: &MfRef) -> Res<crate::store::Manifest> {
    let (obj, _) = idx.objs.get(id).ok_or("missing manifest object")?;
    if mf.n > MAX_MANIFEST || mf.n != obj.size() {
        return Err("manifest size does not match its metadata".into());
    }
    let mut stream = reader
        .download(obj, DownloadOptions { max_buffered_chunks: Some(2), ..Default::default() })
        .map_err(err)?;
    let mut raw = Vec::new();
    (&mut stream).take(MAX_MANIFEST + 1).read_to_end(&mut raw).await.map_err(err)?;
    parse_manifest(&raw, mf)
}
/// The key a manifest object names: its body read from the snapshot's hosts, checked against the signed metadata (length,
/// SHA-256, key hash), and its data objects present and complete.
async fn manifest_key(reader: &RecoveryReader, idx: &Index, id: &str, mf: &MfRef) -> Res<Key> {
    let man = read_manifest(reader, idx, id, mf).await?;
    let entry = Entry { b: man.b, k: man.k, s: man.s, t: man.t, m: mf.m, c: man.c, x: man.x, h: mf.h, i: mf.i.clone() };
    let k = Key { host: id.to_string(), entry, manifest: true };
    let total = k
        .data()
        .iter()
        .map(|x| idx.objs.get(x).map(|(o, _)| o.size()).ok_or("missing multipart object"))
        .try_fold(0u64, |n, s| s.and_then(|s| n.checked_add(s).ok_or("segment size overflow")))?;
    if (k.data().len() > 1 && total != k.entry.s) || (k.data().len() == 1 && total < k.entry.s) {
        return Err("incomplete multipart key".into());
    }
    Ok(k)
}
#[allow(clippy::too_many_arguments)]
async fn recover_with(
    snapshot: &Path,
    sha: &str,
    bucket: &str,
    name: &str,
    destination: &Path,
    expected_sha: &str,
    expected_size: u64,
    key: AppKey,
    make_reader: impl FnOnce(AppKey, Vec<Host>) -> RecoveryReader,
) -> Res<()> {
    hash_arg(expected_sha)?;
    let raw = bounded(snapshot, MAX_SNAPSHOT)?;
    let (idx, hosts, manifests) = open_snapshot(&raw, sha, &key)?;
    let reader = make_reader(key, hosts);
    let k = match idx.keys.get(&(bucket.into(), name.into())) {
        Some(k) => Key { host: k.host.clone(), entry: k.entry.clone(), manifest: false },
        None => {
            let (id, mf) = manifests.get(&qkey(bucket, name)).ok_or("key absent from snapshot")?;
            let k = manifest_key(&reader, &idx, id, mf).await?;
            if k.entry.b != bucket || k.entry.k != name {
                return Err("key absent from snapshot".into());
            }
            k
        }
    };
    if k.entry.s != expected_size {
        return Err("expected size differs from snapshot".into());
    }
    let segments = idx.segments(&k, 0, expected_size)?;
    let mut pending = Pending::new(destination)?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buf = vec![0u8; 256 * 1024];
    for (obj, offset, length) in segments {
        let mut stream = reader
            .download(
                &obj,
                DownloadOptions {
                    offset,
                    length: Some(length),
                    max_buffered_chunks: Some(2),
                    ..Default::default()
                },
            )
            .map_err(err)?;
        let mut read = 0u64;
        loop {
            let n = stream.read(&mut buf).await.map_err(err)?;
            if n == 0 {
                break;
            }
            read = read.checked_add(n as u64).ok_or("size overflow")?;
            if read > length {
                return Err("oversize segment".into());
            }
            hash.update(&buf[..n]);
            pending.file.write_all(&buf[..n]).map_err(err)?;
        }
        if read != length {
            return Err("truncated segment".into());
        }
        total += read;
    }
    if total != expected_size || hex::encode(hash.finalize()) != expected_sha {
        return Err("recovered file digest or size mismatch".into());
    }
    pending.commit(destination)?;
    println!(
        "{}",
        serde_json::json!({"verified":true,"bytes":total,"sha256":expected_sha,"indexerUsed":false,"writesToSia":false})
    );
    Ok(())
}
/// The longest restore deadline accepted (seconds).
const MAX_RESTORE_DEADLINE: u64 = 7 * 24 * 3600;
const MAX_EXPECTED: u64 = 64 * 1024 * 1024;
/// An operator-supplied record of independently known file hashes (optional).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Expected {
    format: String,
    keys: Vec<ExpectedKey>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedKey {
    bucket: String,
    key: String,
    bytes: u64,
    sha256: String,
}
const EXPECTED_FORMAT: &str = "sia-s3-recovery-expected/v1";
fn expected_inventory(path: &Path) -> Res<HashMap<(String, String), (u64, String)>> {
    let raw = bounded(path, MAX_EXPECTED)?;
    let e: Expected = serde_json::from_slice(&raw).map_err(|e| format!("expected inventory: {e}"))?;
    if e.format != EXPECTED_FORMAT || e.keys.len() > MAX_OBJECTS {
        return Err(format!("expected inventory: format must be {EXPECTED_FORMAT}, at most {MAX_OBJECTS} keys"));
    }
    let mut out = HashMap::new();
    for k in e.keys {
        hash_arg(&k.sha256).map_err(|e| format!("expected inventory: {e}"))?;
        if out.insert((k.bucket, k.key), (k.bytes, k.sha256)).is_some() {
            return Err("expected inventory: duplicate key".into());
        }
    }
    Ok(out)
}
/// The ETag check, from the signed metadata's ETag and the MD5s computed while streaming: a single-part ETag is the MD5
/// of the body; a multipart one is MD5(part MD5s)-N with one data object per part (the rule replica.rs's copy_version
/// uses). -> "md5" | "multipart-md5" | "unverifiable" (an ETag of another form, or N differing from the objects), or why it
/// differs. MD5 is a consistency check bound to signed metadata, not a collision-resistant independent hash.
fn etag_check(t: &str, whole: &[u8], parts: &[Vec<u8>]) -> Res<&'static str> {
    let hex32 = |x: &str| x.len() == 32 && x.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    if hex32(t) {
        return if hex::encode(whole) == t { Ok("md5") } else { Err("the body's MD5 differs from its signed ETag".into()) };
    }
    match t.split_once('-') {
        Some((h, count)) if hex32(h) && count.parse::<usize>().is_ok_and(|v| v > 0 && v.to_string() == count) => {
            if count.parse::<usize>().ok() != Some(parts.len()) {
                return Ok("unverifiable");
            }
            let mut m = md5::Md5::new();
            for p in parts {
                m.update(p);
            }
            if hex::encode(m.finalize()) == h { Ok("multipart-md5") } else { Err("the parts' MD5s differ from the signed multipart ETag".into()) }
        }
        _ => Ok("unverifiable"),
    }
}
/// One key's bytes into a pending (not yet visible) output: every segment read from the hosts by the SDK (verified against
/// the sealed object's commitments), size-exact. -> (pending, bytes, computed SHA-256, ETag check)
async fn restore_key(reader: &RecoveryReader, idx: &Index, k: &Key, destination: &Path) -> Res<(Pending, u64, String, &'static str)> {
    let segments = idx.segments(k, 0, k.entry.s)?;
    let mut pending = Pending::new(destination)?;
    let (mut sha, mut whole) = (Sha256::new(), md5::Md5::new());
    let mut parts = Vec::with_capacity(segments.len());
    let mut total = 0u64;
    let mut buf = vec![0u8; 256 * 1024];
    for (obj, offset, length) in segments {
        let mut stream = reader
            .download(&obj, DownloadOptions { offset, length: Some(length), max_buffered_chunks: Some(2), ..Default::default() })
            .map_err(err)?;
        let (mut part, mut read) = (md5::Md5::new(), 0u64);
        loop {
            let n = stream.read(&mut buf).await.map_err(err)?;
            if n == 0 {
                break;
            }
            read = read.checked_add(n as u64).ok_or("size overflow")?;
            if read > length {
                return Err("oversize segment".into());
            }
            sha.update(&buf[..n]);
            whole.update(&buf[..n]);
            part.update(&buf[..n]);
            pending.file.write_all(&buf[..n]).map_err(err)?;
        }
        if read != length {
            return Err("truncated segment".into());
        }
        total = total.checked_add(read).ok_or("size overflow")?;
        parts.push(part.finalize().to_vec());
    }
    if total != k.entry.s {
        return Err("recovered size differs from the signed metadata".into());
    }
    let etag = etag_check(&k.entry.t, &whole.finalize(), &parts)?;
    Ok((pending, total, hex::encode(sha.finalize()), etag))
}
/// A new, private directory: refused when the path exists in any form.
fn new_dir(path: &Path) -> Res<()> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(path).map_err(|e| format!("{}: {e} (restore writes only into a new directory)", path.display()))?;
    let m = fs::symlink_metadata(path).map_err(err)?;
    if !m.is_dir() || m.file_type().is_symlink() {
        return Err("the new output directory was replaced".into());
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn restore(snapshot: &Path, sha: &str, outdir: &Path, max_total: u64, deadline_secs: u64, expected: Option<&Path>, key: AppKey) -> Res<()> {
    restore_with(snapshot, sha, outdir, max_total, deadline_secs, expected, key, RecoveryReader::new, &|_| {}).await
}
/// WHOLE-SNAPSHOT RESTORE: every key of a snapshot (v1 inline keys, v2 manifest keys too) into a NEW directory.
///   - Before anything is written: the snapshot opens exactly as for `read` (external SHA-256, app-key-sealed and signed
///     metadata, duplicate and completeness refusals), then EVERY manifest body is read over RHP4 and checked against its
///     signed length/SHA-256/key hash; any failure, duplicate, an expected inventory that does not parse, or a total size
///     above `max_total` refuses the whole restore with nothing written.
///   - Each key: the SDK verifies every sector it reads against the sealed object; the size must equal the signed metadata;
///     the signed ETag's MD5 is checked when it has an MD5 form; the output's SHA-256 is COMPUTED. An independent SHA-256
///     is claimed only for keys an operator-supplied expected inventory lists (and must match).
///   - Bucket and key names stay data: files are `objects/NNNNNN.bin`, named by position; `inventory.json` maps each to its
///     bucket and key. Every file is created new and linked into place (never overwriting).
///   - Honest outcome: a key that fails, and every key the deadline did not reach, is listed; `complete` is true only when
///     every key was restored; an incomplete restore keeps its verified files and returns an error.
#[allow(clippy::too_many_arguments)]
async fn restore_with(
    snapshot: &Path,
    sha: &str,
    outdir: &Path,
    max_total: u64,
    deadline_secs: u64,
    expected: Option<&Path>,
    key: AppKey,
    make_reader: impl FnOnce(AppKey, Vec<Host>) -> RecoveryReader,
    before_commit: &dyn Fn(&Path),
) -> Res<()> {
    if deadline_secs == 0 || deadline_secs > MAX_RESTORE_DEADLINE {
        return Err(format!("deadline must be 1..={MAX_RESTORE_DEADLINE} seconds"));
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(deadline_secs);
    if outdir.symlink_metadata().is_ok() {
        return Err("the output directory already exists (restore writes only into a new directory)".into());
    }
    let expect = expected.map(expected_inventory).transpose()?;
    let raw = bounded(snapshot, MAX_SNAPSHOT)?;
    let (idx, hosts, manifests) = open_snapshot(&raw, sha, &key)?;
    let reader = make_reader(key, hosts);
    // every key, named and checked, before anything is written
    let mut keys: BTreeMap<(String, String), (Key, &'static str)> = BTreeMap::new();
    for (kk, k) in &idx.keys {
        keys.insert(kk.clone(), (Key { host: k.host.clone(), entry: k.entry.clone(), manifest: false }, "inline"));
    }
    let resolve = async {
        for (q, (id, mf)) in &manifests {
            let k = manifest_key(&reader, &idx, id, mf).await.map_err(|e| format!("manifest {}: {e}", &q[..8.min(q.len())]))?;
            if keys.insert((k.entry.b.clone(), k.entry.k.clone()), (k, "manifest")).is_some() {
                return Err::<(), String>("duplicate S3 key".into());
            }
        }
        Ok(())
    };
    tokio::time::timeout_at(deadline, resolve).await.map_err(|_| "the deadline passed while resolving the manifest keys: nothing written")??;
    let total = keys.values().try_fold(0u64, |n, (k, _)| n.checked_add(k.entry.s)).ok_or("size overflow")?;
    if total > max_total {
        return Err(format!("the snapshot holds {total} bytes, above the {max_total}-byte budget: nothing written"));
    }
    new_dir(outdir)?;
    let objects = outdir.join("objects");
    new_dir(&objects)?;
    let (mut done, mut failed, mut skipped) = (Vec::new(), Vec::new(), Vec::new());
    let mut restored = 0u64;
    for (n, ((b, name), (k, source))) in keys.iter().enumerate() {
        let file = format!("objects/{:06}.bin", n + 1);
        let id = serde_json::json!({"bucket": b, "key": name, "bytes": k.entry.s, "source": source});
        let want = expect.as_ref().and_then(|e| e.get(&(b.clone(), name.clone())));
        if want.is_some_and(|w| w.0 != k.entry.s) {
            failed.push(serde_json::json!({"key": id, "error": "the expected inventory names another size"}));
            continue;
        }
        if tokio::time::Instant::now() >= deadline {
            skipped.push(serde_json::json!({"key": id, "reason": "the deadline passed before this key"}));
            continue;
        }
        let dest = outdir.join(&file);
        let r = match tokio::time::timeout_at(deadline, restore_key(&reader, &idx, k, &dest)).await {
            Err(_) => Err("the deadline passed during this key".to_string()),
            Ok(r) => r,
        };
        let r = r.and_then(|(pending, bytes, sum, etag)| {
            if want.is_some_and(|w| w.1 != sum) {
                return Err("the SHA-256 differs from the expected inventory".to_string());
            }
            before_commit(&dest);
            pending.commit(&dest).map_err(|e| format!("output {file}: {e}"))?;
            Ok((bytes, sum, etag))
        });
        match r {
            Ok((bytes, sum, etag)) => {
                restored += bytes;
                done.push(serde_json::json!({"bucket": b, "key": name, "file": file, "bytes": bytes, "source": source,
                    "etag": k.entry.t, "etagCheck": etag, "outputSha256": sum,
                    "independentSha256": if want.is_some() { "matched" } else { "not-provided" },
                    "contentType": k.entry.c, "lastModified": k.entry.m}));
            }
            Err(e) => failed.push(serde_json::json!({"key": id, "error": e})),
        }
    }
    let absent: Vec<_> = expect.iter().flat_map(|e| e.keys()).filter(|kk| !keys.contains_key(*kk))
        .map(|(b, k)| serde_json::json!({"bucket": b, "key": k, "error": "listed in the expected inventory but absent from the snapshot"})).collect();
    let complete = failed.is_empty() && skipped.is_empty() && absent.is_empty();
    let report = serde_json::json!({
        "format": "sia-s3-recovery-restore/v1", "complete": complete, "snapshotSha256": sha,
        "keys": keys.len(), "restored": done.len(), "restoredBytes": restored, "totalBytes": total,
        "failed": failed, "notAttempted": skipped, "expectedButAbsent": absent, "files": done,
        "integrity": "bytes: SDK-verified RHP4 sector reads against the sealed, signed objects; size and ETag: signed metadata \
(etagCheck md5/multipart-md5 = verified, unverifiable = not checked); outputSha256: computed over the written bytes, \
independently matched only where independentSha256 is 'matched' (an operator-supplied expected inventory)",
        "indexerUsed": false, "writesToSia": false });
    let inv = outdir.join("inventory.json");
    let mut pending = Pending::new(&inv)?;
    pending.file.write_all(&serde_json::to_vec_pretty(&report).map_err(err)?).map_err(err)?;
    pending.commit(&inv)?;
    let summary = serde_json::json!({"complete": complete, "keys": keys.len(), "restored": done.len(), "failed": failed.len(),
        "notAttempted": skipped.len(), "expectedButAbsent": absent.len(), "restoredBytes": restored, "inventory": inv.display().to_string(),
        "indexerUsed": false, "writesToSia": false});
    println!("{summary}");
    if complete {
        Ok(())
    } else {
        Err(format!("restore incomplete: {} failed, {} not attempted, {} expected but absent; see {}", failed.len(), skipped.len(), absent.len(), inv.display()))
    }
}
pub async fn command(args: &[String]) -> Res<()> {
    let deadline = std::time::Duration::from_secs(600);
    match args {
        [op, indexer, out] if op == "export" => {
            tokio::time::timeout(deadline, export(indexer, Path::new(out), key_file()?))
                .await.map_err(|_| "snapshot export deadline exceeded")?
        }
        [op, snapshot, sha, bucket, name, out, expected_sha, size] if op == "read" => {
            let size = size.parse::<u64>().map_err(|_| "invalid expected size")?;
            tokio::time::timeout(deadline, recover(Path::new(snapshot), sha, bucket, name,
                Path::new(out), expected_sha, size, key_file()?))
                .await.map_err(|_| "recovery deadline exceeded")?
        }
        [op, snapshot, sha, out, max_bytes, deadline, rest @ ..] if op == "restore" && rest.len() <= 1 => {
            let max_bytes = max_bytes.parse::<u64>().map_err(|_| "invalid MAX_TOTAL_BYTES")?;
            let deadline = deadline.parse::<u64>().map_err(|_| "invalid DEADLINE_SECS")?;
            restore(Path::new(snapshot), sha, Path::new(out), max_bytes, deadline, rest.first().map(Path::new), key_file()?).await
        }
        _ => Err("usage: SIA_RECOVERY_KEY_FILE=... sia-s3 recovery export INDEXER SNAPSHOT | recovery read SNAPSHOT SHA256 BUCKET KEY OUTPUT EXPECTED_SHA256 EXPECTED_BYTES | recovery restore SNAPSHOT SHA256 NEW_OUTDIR MAX_TOTAL_BYTES DEADLINE_SECS [EXPECTED_INVENTORY]".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Entry;
    use sia_storage::{Object, UploadOptions, mock::MockNetwork};
    fn fixture(key: &AppKey) -> Snapshot {
        let meta = Meta {
            v: 1,
            e: vec![Entry {
                b: "ipfs".into(),
                k: "empty".into(),
                s: 0,
                t: String::new(),
                m: 1,
                c: None,
                x: vec![],
                h: 0,
                i: String::new(),
            }],
            ..Default::default()
        };
        let obj = Object::new(Some(serde_json::to_vec(&meta).unwrap()));
        let id = obj.id().to_string();
        Snapshot {
            version: 1,
            created_at: "test".into(),
            hosts: vec![],
            objects: BTreeMap::from([(id.clone(), obj.seal(key))]),
            keys: vec![KeyRef {
                object: id,
                entry: Some(0),
            }],
        }
    }
    #[test]
    fn snapshot_requires_external_digest_and_correct_key_and_signatures() {
        let key = AppKey::import([7; 32]);
        let snap = fixture(&key);
        let raw = serde_json::to_vec(&snap).unwrap();
        assert!(open_snapshot(&raw, &digest(&raw), &key).is_ok());
        assert!(open_snapshot(&raw, &"00".repeat(32), &key).is_err());
        assert!(open_snapshot(&raw, &digest(&raw), &AppKey::import([8; 32])).is_err());
        let mut altered = snap;
        altered
            .objects
            .values_mut()
            .next()
            .unwrap()
            .encrypted_metadata[0] ^= 1;
        let raw = serde_json::to_vec(&altered).unwrap();
        assert!(open_snapshot(&raw, &digest(&raw), &key).is_err());
    }
    #[test]
    fn duplicate_keys_missing_parts_and_unknown_versions_fail_closed() {
        let key = AppKey::import([7; 32]);
        let mut snap = fixture(&key);
        snap.keys.push(KeyRef {
            object: snap.keys[0].object.clone(),
            entry: Some(0),
        });
        let raw = serde_json::to_vec(&snap).unwrap();
        assert!(open_snapshot(&raw, &digest(&raw), &key).is_err());
        let mut snap = fixture(&key);
        snap.version = 3;
        let raw = serde_json::to_vec(&snap).unwrap();
        assert!(open_snapshot(&raw, &digest(&raw), &key).is_err());
        // a manifest reference only exists in version 2, and must name a manifest object
        for version in [1, 2] {
            let mut snap = fixture(&key);
            snap.version = version;
            snap.keys[0].entry = None;
            let raw = serde_json::to_vec(&snap).unwrap();
            assert!(open_snapshot(&raw, &digest(&raw), &key).is_err());
        }
        let mut snap = fixture(&key);
        let id = snap.keys[0].object.clone();
        let mut obj = snap.objects.remove(&id).unwrap().open(&key).unwrap();
        let mut meta: Meta = serde_json::from_slice(&obj.metadata).unwrap();
        meta.e[0].s = 5;
        meta.e[0].x = vec!["missing".into()];
        obj.metadata = serde_json::to_vec(&meta).unwrap();
        snap.objects.insert(id, obj.seal(&key));
        let raw = serde_json::to_vec(&snap).unwrap();
        assert!(open_snapshot(&raw, &digest(&raw), &key).is_err());
    }
    #[test]
    fn failed_and_racing_output_never_replaces_existing_data() {
        let dir = std::env::temp_dir().join(format!(
            "sia-recovery-test-{}",
            hex::encode({
                let mut n = [0u8; 16];
                getrandom::fill(&mut n).unwrap();
                n
            })
        ));
        fs::create_dir(&dir).unwrap();
        let out = dir.join("result");
        {
            let mut pending = Pending::new(&out).unwrap();
            pending.file.write_all(b"partial").unwrap();
        }
        assert!(!out.exists());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let mut pending = Pending::new(&out).unwrap();
        pending.file.write_all(b"verified").unwrap();
        fs::write(&out, b"other writer").unwrap();
        assert!(pending.commit(&out).is_err());
        assert_eq!(fs::read(&out).unwrap(), b"other writer");
        fs::remove_file(&out).unwrap();
        let mut pending = Pending::new(&out).unwrap();
        pending.file.write_all(b"verified").unwrap();
        pending.commit(&out).unwrap();
        assert_eq!(fs::read(&out).unwrap(), b"verified");
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn read_refuses_wrong_file_commitment_without_exposing_output() {
        let key=AppKey::import([7;32]);
        let mut nonce=[0u8;16];getrandom::fill(&mut nonce).unwrap();
        let dir=std::env::temp_dir().join(format!("sia-recovery-read-{}",hex::encode(nonce)));
        fs::create_dir(&dir).unwrap();let snapshot=dir.join("snapshot.json");let output=dir.join("result");
        let raw=serde_json::to_vec(&fixture(&key)).unwrap();fs::write(&snapshot,&raw).unwrap();
        assert!(recover(&snapshot,&digest(&raw),"ipfs","empty",&output,&"00".repeat(32),0,key.clone()).await.is_err());
        assert!(!output.exists());assert_eq!(fs::read_dir(&dir).unwrap().count(),1);
        assert!(recover(&snapshot,&digest(&raw),"ipfs","empty",&output,&digest(b""),1,key.clone()).await.is_err());
        recover(&snapshot,&digest(&raw),"ipfs","empty",&output,&digest(b""),0,key).await.unwrap();
        assert_eq!(fs::read(&output).unwrap(),b"");fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn real_erasure_coded_bytes_survive_discarding_the_indexer() {
        let net = MockNetwork::new();
        net.add_hosts(30);
        let key = AppKey::import([5; 32]);
        let sdk = net.sdk(key.clone()).await.unwrap();
        let bytes = vec![0xa7; 2 * 1024 * 1024 + 19];
        let object = sdk
            .upload(
                Object::default(),
                std::io::Cursor::new(bytes.clone()),
                UploadOptions {
                    data_shards: 10,
                    parity_shards: 20,
                    max_buffered_slabs: Some(1),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let hosts = sdk.hosts(HostQuery::default()).await.unwrap();
        let sealed = object.seal(&key);
        let reader = net.recovery_reader(key.clone(), hosts);
        drop(sdk);
        drop(net); // no indexer remains
        let restored = sealed.open(&key).unwrap();
        let mut stream = reader
            .download(
                &restored,
                DownloadOptions {
                    max_buffered_chunks: Some(2),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, bytes);
        let mut ranged = reader
            .download(
                &restored,
                DownloadOptions {
                    offset: 123,
                    length: Some(713),
                    max_buffered_chunks: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        out.clear();
        ranged.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, &bytes[123..836]);
    }

    #[tokio::test]
    async fn manifest_keys_recover_from_a_cold_snapshot_with_no_indexer() {
        use crate::store::{Opts, Placement};
        use std::rc::Rc;
        let net = MockNetwork::new();
        net.add_hosts(12);
        let key = AppKey::import([6; 32]);
        let sdk = net.sdk(key.clone()).await.unwrap();
        let store = Store::load_with(sdk.clone(), 8 << 20, Opts { shards: (3, 9), ..Default::default() }).await.unwrap();
        // 16 small parts: past what one metadata entry can list
        store.ensure_upload("u1", "ipfs", "big.bin", 0).await;
        let mut want = Vec::new();
        let mut body: Vec<u8> = Vec::new();
        for n in 1..=16u32 {
            let part = vec![n as u8; 777 + n as usize];
            body.extend(&part);
            want.push((n, store.upload_part("u1", n, Rc::from(part)).await.unwrap()));
        }
        let c = store.stage_complete("u1", &want).await.unwrap();
        assert!(matches!(c.placement, Placement::Manifest { .. }));
        store.commit_complete("u1", c, 1, 1_000, "w1").await.unwrap();
        // a key too long for metadata
        let long = format!("site/{}", "n".repeat(1000));
        let data = store.upload(Rc::from(&b"long-named"[..])).await.unwrap();
        let entry = Entry { b: "ipfs".into(), k: long.clone(), s: 10, t: "t".into(), m: 2, c: None, x: vec![], h: 2_000, i: "w2".into() };
        let p = store.stage_put(&data, &entry).await.unwrap();
        store.commit_put(data, p, entry, false).await.unwrap();

        let hosts = sdk.hosts(HostQuery::default()).await.unwrap();
        let raw = snapshot_bytes(&store, hosts, &key).await.unwrap();
        drop(store);
        drop(sdk);
        net.set_indexer_offline(true); // recovery must not need it
        let (_, _, manifests) = open_snapshot(&raw, &digest(&raw), &key).unwrap();
        assert_eq!(manifests.len(), 2);

        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).unwrap();
        let dir = std::env::temp_dir().join(format!("sia-recovery-manifest-{}", hex::encode(nonce)));
        fs::create_dir(&dir).unwrap();
        let snapshot = dir.join("snapshot.json");
        fs::write(&snapshot, &raw).unwrap();
        let sha = digest(&raw);
        let reader = |k: AppKey, h: Vec<Host>| net.recovery_reader(k, h);
        let out = dir.join("big");
        recover_with(&snapshot, &sha, "ipfs", "big.bin", &out, &digest(&body), body.len() as u64, key.clone(), reader).await.unwrap();
        assert_eq!(fs::read(&out).unwrap(), body);
        let out = dir.join("long");
        recover_with(&snapshot, &sha, "ipfs", &long, &out, &digest(b"long-named"), 10, key.clone(), reader).await.unwrap();
        assert_eq!(fs::read(&out).unwrap(), b"long-named");
        // a wrong file commitment, an absent key, or a key from another app is refused without output
        let out = dir.join("refused");
        assert!(recover_with(&snapshot, &sha, "ipfs", "big.bin", &out, &digest(b"x"), body.len() as u64, key.clone(), reader).await.is_err());
        assert!(recover_with(&snapshot, &sha, "ipfs", "absent", &out, &digest(b""), 0, key.clone(), reader).await.is_err());
        assert!(recover_with(&snapshot, &sha, "ipfs", "big.bin", &out, &digest(&body), body.len() as u64, AppKey::import([9; 32]), reader).await.is_err());
        assert!(!out.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    // ---- WHOLE-SNAPSHOT RESTORE (restore_with) ------------------------------------------------------------------------
    use std::rc::Rc;
    fn scratch(tag: &str) -> PathBuf {
        let mut n = [0u8; 16];
        getrandom::fill(&mut n).unwrap();
        let d = std::env::temp_dir().join(format!("sia-restore-{tag}-{}", hex::encode(n)));
        fs::create_dir(&d).unwrap();
        d
    }
    async fn put(store: &Store, b: &str, k: &str, body: &[u8], t: Option<String>) {
        let data = store.upload(Rc::from(body)).await.unwrap();
        let entry = Entry { b: b.into(), k: k.into(), s: body.len() as u64, t: t.unwrap_or_else(|| crate::store::md5_hex(body)), m: 1,
            c: Some("application/octet-stream".into()), x: vec![], h: 1_000, i: crate::store::new_wid() };
        let p = store.stage_put(&data, &entry).await.unwrap();
        store.commit_put(data, p, entry, false).await.unwrap();
    }
    /// -> whether the key was placed behind a manifest
    async fn multipart(store: &Store, uid: &str, b: &str, k: &str, parts: &[Vec<u8>]) -> bool {
        store.ensure_upload(uid, b, k, 0).await;
        let mut want = Vec::new();
        for (n, part) in parts.iter().enumerate() {
            want.push((n as u32 + 1, store.upload_part(uid, n as u32 + 1, Rc::from(part.clone())).await.unwrap()));
        }
        let c = store.stage_complete(uid, &want).await.unwrap();
        let manifest = matches!(c.placement, crate::store::Placement::Manifest { .. });
        store.commit_complete(uid, c, 1, 1_000, &crate::store::new_wid()).await.unwrap();
        manifest
    }
    /// keys whose names are hostile as paths: traversal, absolute, NUL, NFC/NFD look-alikes; a multipart key
    fn v1_keys() -> Vec<(&'static str, String, Vec<u8>)> {
        vec![
            ("ipfs", "pins/bafy1".into(), (0..3000u32).map(|i| (i % 251) as u8).collect()),
            ("ipfs", "../../etc/passwd".into(), b"traversal".to_vec()),
            ("site", "/abs/path".into(), b"".to_vec()),
            ("site", "a\u{0}b".into(), b"nul".to_vec()),
            ("site", "caf\u{e9}".into(), b"nfc".to_vec()),
            ("site", "cafe\u{301}".into(), b"nfd".to_vec()),
        ]
    }
    struct World { net: MockNetwork, key: AppKey, raw: Vec<u8>, want: BTreeMap<(String, String), Vec<u8>> }
    /// A store on a mock network, its snapshot, then the indexer is taken offline (restore must not need it).
    async fn world(manifests: bool, bad_etag: Option<(&str, &str)>) -> World {
        use crate::store::Opts;
        let net = MockNetwork::new();
        net.add_hosts(12);
        let key = AppKey::import([4; 32]);
        let sdk = net.sdk(key.clone()).await.unwrap();
        let store = Store::load_with(sdk.clone(), 8 << 20, Opts { shards: (3, 9), ..Default::default() }).await.unwrap();
        let mut want = BTreeMap::new();
        for (b, k, body) in v1_keys() {
            let t = bad_etag.filter(|(bb, kk)| *bb == b && *kk == k).map(|_| crate::store::md5_hex(b"other bytes"));
            put(&store, b, &k, &body, t).await;
            want.insert((b.to_string(), k), body);
        }
        let parts = vec![vec![1u8; 1500], vec![2u8; 1700], vec![3u8; 9]];
        assert!(!multipart(&store, "u0", "ipfs", "multi.bin", &parts).await, "a 3-part key stays inline (snapshot v1)");
        want.insert(("ipfs".into(), "multi.bin".into()), parts.concat());
        if manifests {
            let parts: Vec<Vec<u8>> = (1..=16u8).map(|n| vec![n; 700 + n as usize]).collect();
            assert!(multipart(&store, "u1", "ipfs", "big.bin", &parts).await, "16 parts need a manifest (snapshot v2)");
            want.insert(("ipfs".into(), "big.bin".into()), parts.concat());
            let long = format!("site/{}", "n".repeat(1000));
            put(&store, "site", &long, b"long-named", Some("t".into())).await;
            want.insert(("site".into(), long), b"long-named".to_vec());
        }
        let hosts = sdk.hosts(HostQuery::default()).await.unwrap();
        let raw = snapshot_bytes(&store, hosts, &key).await.unwrap();
        drop(store);
        drop(sdk);
        net.set_indexer_offline(true);
        World { net, key, raw, want }
    }
    fn inventory(out: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(out.join("inventory.json")).unwrap()).unwrap()
    }
    fn file_of(inv: &serde_json::Value, b: &str, k: &str) -> Option<serde_json::Value> {
        inv["files"].as_array().unwrap().iter().find(|f| f["bucket"] == b && f["key"] == k).cloned()
    }
    async fn run(w: &World, raw: &[u8], out: &Path, max: u64, secs: u64, expected: Option<&Path>, key: AppKey, hosts: bool, hook: &dyn Fn(&Path)) -> Res<()> {
        let dir = out.parent().unwrap();
        let snap = dir.join(format!("snapshot-{}.json", digest(raw)));
        if !snap.exists() {
            fs::write(&snap, raw).unwrap();
        }
        let net = &w.net;
        restore_with(&snap, &digest(raw), out, max, secs, expected, key, |k: AppKey, h: Vec<Host>| net.recovery_reader(k, if hosts { h } else { vec![] }), hook).await
    }

    #[tokio::test]
    async fn restore_v1_recovers_every_key_with_names_as_data_never_paths() {
        let w = world(false, None).await;
        let snap: Snapshot = serde_json::from_slice(&w.raw).unwrap();
        assert_eq!(snap.version, 1, "a snapshot without manifest keys is version 1 (what the pinned binary exports)");
        let dir = scratch("v1");
        let out = dir.join("restored");
        run(&w, &w.raw, &out, 1 << 30, 600, None, w.key.clone(), true, &|_| {}).await.unwrap();
        let inv = inventory(&out);
        assert_eq!(inv["complete"], true);
        assert_eq!(inv["restored"], w.want.len());
        for ((b, k), body) in &w.want {
            let f = file_of(&inv, b, k).unwrap_or_else(|| panic!("{b}/{k:?} missing"));
            assert_eq!(fs::read(out.join(f["file"].as_str().unwrap())).unwrap(), *body, "{b}/{k:?}");
            assert_eq!(f["outputSha256"], digest(body));
            assert_eq!(f["independentSha256"], "not-provided", "no independent hash is claimed without an expected inventory");
            assert_eq!(f["etagCheck"], if k == "multi.bin" { "multipart-md5" } else { "md5" });
        }
        // names never became paths: only objects/NNNNNN.bin and the inventory exist
        let mut names: Vec<String> = fs::read_dir(out.join("objects")).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, (1..=w.want.len()).map(|n| format!("{n:06}.bin")).collect::<Vec<_>>());
        assert_eq!(fs::read_dir(&out).unwrap().count(), 2);
        assert!(!dir.join("etc").exists() && !Path::new("/abs/path").exists());
        // a second restore into the same (now existing) directory is refused
        assert!(run(&w, &w.raw, &out, 1 << 30, 600, None, w.key.clone(), true, &|_| {}).await.unwrap_err().contains("already exists"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn restore_v2_resolves_every_manifest_key_over_rhp() {
        let w = world(true, None).await;
        let snap: Snapshot = serde_json::from_slice(&w.raw).unwrap();
        assert_eq!(snap.version, 2);
        let dir = scratch("v2");
        let out = dir.join("restored");
        run(&w, &w.raw, &out, 1 << 30, 600, None, w.key.clone(), true, &|_| {}).await.unwrap();
        let inv = inventory(&out);
        assert_eq!(inv["complete"], true);
        assert_eq!(inv["restored"], w.want.len());
        for ((b, k), body) in &w.want {
            let f = file_of(&inv, b, k).unwrap();
            assert_eq!(fs::read(out.join(f["file"].as_str().unwrap())).unwrap(), *body);
        }
        let big = file_of(&inv, "ipfs", "big.bin").unwrap();
        assert_eq!((big["source"].as_str(), big["etagCheck"].as_str()), (Some("manifest"), Some("multipart-md5")));
        let long = file_of(&inv, "site", &format!("site/{}", "n".repeat(1000))).unwrap();
        assert_eq!((long["source"].as_str(), long["etagCheck"].as_str()), (Some("manifest"), Some("unverifiable")), "a non-MD5 ETag is never reported verified");
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn restore_refuses_before_writing_anything() {
        let w = world(true, None).await;
        let dir = scratch("refuse");
        let out = dir.join("restored");
        let total: u64 = w.want.values().map(|b| b.len() as u64).sum();
        let none = |r: Res<()>, why: &str| { assert!(r.is_err(), "{why}"); assert!(!out.exists(), "{why}: something was written"); };
        none(run(&w, &w.raw, &out, 1 << 30, 600, None, AppKey::import([9; 32]), true, &|_| {}).await, "another app key");
        none(run(&w, &w.raw, &out, total - 1, 600, None, w.key.clone(), true, &|_| {}).await, "over the total budget");
        none(run(&w, &w.raw, &out, 1 << 30, 0, None, w.key.clone(), true, &|_| {}).await, "a zero deadline");
        let snap = dir.join("snapshot.json");
        fs::write(&snap, &w.raw).unwrap();
        none(restore_with(&snap, &"00".repeat(32), &out, 1 << 30, 600, None, w.key.clone(), |k, h| w.net.recovery_reader(k, h), &|_| {}).await, "a wrong snapshot hash");
        // a tampered sealed object
        let mut t: Snapshot = serde_json::from_slice(&w.raw).unwrap();
        t.objects.values_mut().next().unwrap().encrypted_metadata[0] ^= 1;
        none(run(&w, &serde_json::to_vec(&t).unwrap(), &out, 1 << 30, 600, None, w.key.clone(), true, &|_| {}).await, "a tampered sealed object");
        // a manifest whose signed body hash does not match (re-sealed with the app key: the signature holds, the body does not)
        let mut t: Snapshot = serde_json::from_slice(&w.raw).unwrap();
        let (_, _, mfs) = open_snapshot(&w.raw, &digest(&w.raw), &w.key).unwrap();
        let id = mfs.values().next().unwrap().0.clone();
        let mut obj = t.objects.remove(&id).unwrap().open(&w.key).unwrap();
        let mut meta: Meta = serde_json::from_slice(&obj.metadata).unwrap();
        meta.mf.as_mut().unwrap().z = "00".repeat(32);
        obj.metadata = serde_json::to_vec(&meta).unwrap();
        t.objects.insert(id, obj.seal(&w.key));
        let r = run(&w, &serde_json::to_vec(&t).unwrap(), &out, 1 << 30, 600, None, w.key.clone(), true, &|_| {}).await;
        assert!(r.as_ref().unwrap_err().contains("manifest"), "{r:?}");
        none(r, "a tampered manifest");
        // an expected inventory that repeats a key
        let exp = dir.join("expected.json");
        fs::write(&exp, br#"{"format":"sia-s3-recovery-expected/v1","keys":[{"bucket":"ipfs","key":"x","bytes":1,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"},{"bucket":"ipfs","key":"x","bytes":1,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"}]}"#).unwrap();
        none(run(&w, &w.raw, &out, 1 << 30, 600, Some(&exp), w.key.clone(), true, &|_| {}).await, "a duplicate in the expected inventory");
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn restore_reports_partial_failure_honestly() {
        let dir = scratch("partial");
        // the hosts are unreachable: every non-empty key fails, the empty one (no sector to read) is restored
        let w = world(false, None).await;
        let out = dir.join("no-hosts");
        let e = run(&w, &w.raw, &out, 1 << 30, 600, None, w.key.clone(), false, &|_| {}).await.unwrap_err();
        assert!(e.starts_with("restore incomplete"), "{e}");
        let inv = inventory(&out);
        assert_eq!(inv["complete"], false);
        assert_eq!(inv["failed"].as_array().unwrap().len(), w.want.len() - 1);
        assert_eq!(fs::read_dir(out.join("objects")).unwrap().count(), 1, "no partial or temporary file is left for a failed key");
        // a body whose MD5 differs from its signed ETag: refused, the others restored
        let w2 = world(false, Some(("site", "a\u{0}b"))).await;
        let out = dir.join("etag");
        assert!(run(&w2, &w2.raw, &out, 1 << 30, 600, None, w2.key.clone(), true, &|_| {}).await.is_err());
        let inv = inventory(&out);
        let failed = inv["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0]["key"]["key"], "a\u{0}b");
        assert!(failed[0]["error"].as_str().unwrap().contains("MD5"));
        assert_eq!(inv["restored"], w2.want.len() - 1);
        assert!(file_of(&inv, "site", "a\u{0}b").is_none());
        // an expected inventory: matched where it agrees, a failure where it does not, and a listed key that is absent
        let w = world(false, None).await;
        let exp = dir.join("expected.json");
        let body = &w.want[&("ipfs".to_string(), "pins/bafy1".to_string())];
        fs::write(&exp, serde_json::to_vec(&serde_json::json!({"format": "sia-s3-recovery-expected/v1", "keys": [
            {"bucket": "ipfs", "key": "pins/bafy1", "bytes": body.len(), "sha256": digest(body)},
            {"bucket": "site", "key": "caf\u{e9}", "bytes": 3, "sha256": digest(b"not it")},
            {"bucket": "ipfs", "key": "pins/absent", "bytes": 1, "sha256": digest(b"x")}]})).unwrap()).unwrap();
        let out = dir.join("expected");
        assert!(run(&w, &w.raw, &out, 1 << 30, 600, Some(&exp), w.key.clone(), true, &|_| {}).await.is_err());
        let inv = inventory(&out);
        assert_eq!(file_of(&inv, "ipfs", "pins/bafy1").unwrap()["independentSha256"], "matched");
        assert!(file_of(&inv, "site", "caf\u{e9}").is_none());
        assert!(inv["failed"][0]["error"].as_str().unwrap().contains("expected inventory"));
        assert_eq!(inv["expectedButAbsent"][0]["key"], "pins/absent");
        assert_eq!(file_of(&inv, "site", "cafe\u{301}").unwrap()["independentSha256"], "not-provided");
        // a file appearing at an output path mid-restore (a race) is never overwritten
        let out = dir.join("race");
        let hook = |p: &Path| { if p.ends_with("objects/000002.bin") { fs::write(p, b"someone else").unwrap(); } };
        assert!(run(&w, &w.raw, &out, 1 << 30, 600, None, w.key.clone(), true, &hook).await.is_err());
        assert_eq!(fs::read(out.join("objects/000002.bin")).unwrap(), b"someone else");
        let inv = inventory(&out);
        assert_eq!(inv["failed"].as_array().unwrap().len(), 1);
        assert_eq!(inv["restored"], w.want.len() - 1);
        // the deadline: what it does not reach is listed, never silently skipped
        let out = dir.join("deadline");
        let hook = |_: &Path| std::thread::sleep(std::time::Duration::from_millis(1100));
        assert!(run(&w, &w.raw, &out, 1 << 30, 1, None, w.key.clone(), true, &hook).await.is_err());
        let inv = inventory(&out);
        let (r, n) = (inv["restored"].as_u64().unwrap(), inv["notAttempted"].as_array().unwrap().len() as u64);
        assert!(r >= 1 && n >= 1 && r + n == w.want.len() as u64, "{inv}");
        fs::remove_dir_all(dir).unwrap();
    }
}

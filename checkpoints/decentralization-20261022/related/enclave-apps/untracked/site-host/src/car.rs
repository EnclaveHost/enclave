//! The release archive: a CARv1 of one UnixFS tree, read in place and trusted only block by block.
//!
//! The site-release tool (enclave repo scripts/site-release) writes it with kubo's exact `ipfs add -r --hidden
//! --cid-version 1` DAG: sha2-256, raw leaves, dag-pb directories, no HAMT shards. The CID, varint, dag-pb and UnixFS
//! codecs below follow enclave-apps/s3-ipfs-adapter/src/ipfs.rs (same specs, same pinned parameters), reduced to
//! decoding.
//!
//! Nothing in the archive is believed because it is in the archive. The index only says where a block claiming a CID
//! starts; `Car::block` re-hashes those bytes against the CID on EVERY read. Walking from the pinned root, a lookup
//! therefore serves only bytes that hash up to that root: a flipped byte, a swapped block or a forged index entry
//! surfaces as `Error::Integrity`, never as content.
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub const CODEC_RAW: u64 = 0x55;
pub const CODEC_DAG_PB: u64 = 0x70;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// The archive is not the strict CARv1 shape this app reads.
    Format(&'static str),
    /// Bytes do not hash to the CID that names them (or a block the DAG needs is absent).
    Integrity(String),
    /// A UnixFS shape this app refuses: HAMT shards, symlinks, metadata nodes, unknown codecs.
    Unsupported(&'static str),
}

// ---- CID ------------------------------------------------------------------------------------------------------------

/// A CIDv1 with a sha2-256 multihash, the only kind a site release contains.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Cid {
    pub codec: u64,
    pub digest: [u8; 32],
}

impl Cid {
    pub fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(36);
        out.push(0x01);
        varint(&mut out, self.codec);
        out.push(0x12);
        out.push(0x20);
        out.extend_from_slice(&self.digest);
        out
    }

    /// Multibase base32 ("b…"), the form every release tool prints.
    pub fn to_base32(&self) -> String {
        let mut s = String::with_capacity(60);
        s.push('b');
        base32_into(&self.bytes(), &mut s);
        s
    }

    pub fn parse(s: &str) -> Option<Cid> {
        let bytes = base32_decode(s.strip_prefix('b')?)?;
        let (cid, used) = cid_prefix(&bytes)?;
        if used != bytes.len() {
            return None;
        }
        Some(cid)
    }
}

/// A binary CID at the start of `b` -> (cid, bytes used). Only CIDv1 + sha2-256 + raw/dag-pb.
fn cid_prefix(b: &[u8]) -> Option<(Cid, usize)> {
    let (version, n) = varint_read(b)?;
    if version != 1 {
        return None;
    }
    let (codec, m) = varint_read(b.get(n..)?)?;
    if codec != CODEC_RAW && codec != CODEC_DAG_PB {
        return None;
    }
    let p = n + m;
    if b.len() < p + 34 || b[p] != 0x12 || b[p + 1] != 0x20 {
        return None;
    }
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&b[p + 2..p + 34]);
    Some((Cid { codec, digest }, p + 34))
}

// ---- varint / base32 ------------------------------------------------------------------------------------------------

pub fn varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

/// An unsigned LEB128 varint, minimally encoded (a padded encoding would give one value two spellings).
pub fn varint_read(buf: &[u8]) -> Option<(u64, usize)> {
    let mut v: u64 = 0;
    for (i, &b) in buf.iter().enumerate().take(10) {
        if i == 9 && b > 1 {
            return None;
        }
        v |= u64::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            if i > 0 && b == 0 {
                return None;
            }
            return Some((v, i + 1));
        }
    }
    None
}

const B32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

fn base32_into(data: &[u8], out: &mut String) {
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in data {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((acc >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((acc << (5 - bits)) & 0x1f) as usize] as char);
    }
}

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'a'..=b'z' => c - b'a',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None,
        };
        acc = (acc << 5) | u32::from(v);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    if bits >= 5 || (bits > 0 && (acc & ((1 << bits) - 1)) != 0) {
        return None;
    }
    Some(out)
}

// ---- CARv1 ----------------------------------------------------------------------------------------------------------

/// The archive, indexed by CID. `bytes` is the embedded archive; nothing is copied.
pub struct Car<'a> {
    bytes: &'a [u8],
    pub root: Cid,
    index: HashMap<Cid, (usize, usize)>,
}

/// The only header a release CAR has: dag-cbor {"roots": [CID], "version": 1}, keys in that canonical order.
fn parse_header(h: &[u8]) -> Result<Cid, Error> {
    const PREFIX: &[u8] = b"\xa2\x65roots\x81\xd8\x2a";
    let rest = h.strip_prefix(PREFIX).ok_or(Error::Format("CAR header is not {roots:[cid],version:1}"))?;
    // a CBOR byte string: 0x58 <len> (len < 256), holding 0x00 (the identity multibase) + the binary CID
    if rest.len() < 2 || rest[0] != 0x58 {
        return Err(Error::Format("CAR root is not a CBOR byte string"));
    }
    let len = rest[1] as usize;
    let body = rest.get(2..2 + len).ok_or(Error::Format("CAR root is truncated"))?;
    if body.first() != Some(&0x00) {
        return Err(Error::Format("CAR root lacks the identity multibase prefix"));
    }
    let (cid, used) = cid_prefix(&body[1..]).ok_or(Error::Format("CAR root is not a CIDv1 sha2-256"))?;
    if used != len - 1 {
        return Err(Error::Format("CAR root has trailing bytes"));
    }
    if &rest[2 + len..] != b"\x67version\x01" {
        return Err(Error::Format("CAR header is not {roots:[cid],version:1}"));
    }
    Ok(cid)
}

impl<'a> Car<'a> {
    /// Index the archive. Structure only: hashes are checked on every `block` read.
    pub fn open(bytes: &'a [u8]) -> Result<Car<'a>, Error> {
        let (hlen, n) = varint_read(bytes).ok_or(Error::Format("CAR header length"))?;
        let hend = n.checked_add(hlen as usize).filter(|&e| e <= bytes.len()).ok_or(Error::Format("CAR header length"))?;
        let root = parse_header(&bytes[n..hend])?;
        let mut index = HashMap::new();
        let mut p = hend;
        while p < bytes.len() {
            let (slen, n) = varint_read(&bytes[p..]).ok_or(Error::Format("CAR section length"))?;
            let start = p + n;
            let end = start.checked_add(slen as usize).filter(|&e| e <= bytes.len()).ok_or(Error::Format("CAR section overruns the archive"))?;
            let (cid, used) = cid_prefix(&bytes[start..end]).ok_or(Error::Format("CAR section CID"))?;
            // a CID that appears twice is a CAR this app does not need to understand
            if index.insert(cid, (start + used, end)).is_some() {
                return Err(Error::Format("CAR repeats a block"));
            }
            p = end;
        }
        if !index.contains_key(&root) {
            return Err(Error::Integrity(format!("the root block {} is absent", root.to_base32())));
        }
        Ok(Car { bytes, root, index })
    }

    /// The bytes of block `cid`, re-hashed against it on every read.
    pub fn block(&self, cid: &Cid) -> Result<&'a [u8], Error> {
        let &(s, e) = self.index.get(cid).ok_or_else(|| Error::Integrity(format!("block {} is absent", cid.to_base32())))?;
        let b = &self.bytes[s..e];
        let d: [u8; 32] = Sha256::digest(b).into();
        if d != cid.digest {
            return Err(Error::Integrity(format!("block {} does not hash to its CID", cid.to_base32())));
        }
        Ok(b)
    }

    pub fn block_count(&self) -> usize {
        self.index.len()
    }
}

// ---- dag-pb + UnixFS ------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Link {
    pub cid: Cid,
    pub name: String,
}

/// Decode a dag-pb PBNode strictly: Links (field 2) and Data (field 1), nothing else.
fn dagpb_decode(mut buf: &[u8]) -> Result<(Vec<Link>, Vec<u8>), Error> {
    let bad = Error::Format("malformed dag-pb node");
    let mut links = Vec::new();
    let mut data = Vec::new();
    while !buf.is_empty() {
        let (key, n) = varint_read(buf).ok_or(Error::Format("malformed dag-pb node"))?;
        buf = &buf[n..];
        if key != 0x0a && key != 0x12 {
            return Err(bad);
        }
        let (len, n) = varint_read(buf).ok_or(Error::Format("malformed dag-pb node"))?;
        buf = &buf[n..];
        let len = len as usize;
        if buf.len() < len {
            return Err(bad);
        }
        let (payload, rest) = buf.split_at(len);
        buf = rest;
        if key == 0x0a {
            data = payload.to_vec();
        } else {
            links.push(decode_link(payload)?);
        }
    }
    Ok((links, data))
}

fn decode_link(mut buf: &[u8]) -> Result<Link, Error> {
    let bad = || Error::Format("malformed dag-pb link");
    let (mut cid, mut name) = (None, None);
    while !buf.is_empty() {
        let (key, n) = varint_read(buf).ok_or_else(bad)?;
        buf = &buf[n..];
        match key {
            0x0a | 0x12 => {
                let (len, n) = varint_read(buf).ok_or_else(bad)?;
                buf = &buf[n..];
                let len = len as usize;
                if buf.len() < len {
                    return Err(bad());
                }
                if key == 0x0a {
                    let (c, used) = cid_prefix(&buf[..len]).ok_or(Error::Unsupported("a link CID that is not CIDv1 sha2-256 raw/dag-pb"))?;
                    if used != len {
                        return Err(bad());
                    }
                    cid = Some(c);
                } else {
                    name = Some(String::from_utf8(buf[..len].to_vec()).map_err(|_| Error::Format("a link name is not UTF-8"))?);
                }
                buf = &buf[len..];
            }
            0x18 => {
                let (_, n) = varint_read(buf).ok_or_else(bad)?;
                buf = &buf[n..];
            }
            _ => return Err(bad()),
        }
    }
    Ok(Link { cid: cid.ok_or_else(bad)?, name: name.unwrap_or_default() })
}

/// UnixFS Data -> (Type, filesize). Exactly the fields the release importer writes (Type 1, filesize 3, blocksizes 4,
/// all varints); anything else is refused. Only Directory(1) and File(2) are accepted: HAMTShard(5), Symlink(4),
/// Metadata(3) and Raw(0) wrappers are refused rather than interpreted.
fn unixfs(data: &[u8]) -> Result<(u64, Option<u64>), Error> {
    let bad = || Error::Format("malformed UnixFS data");
    let (mut ty, mut size) = (None, None);
    let mut buf = data;
    while !buf.is_empty() {
        let (key, n) = varint_read(buf).ok_or_else(bad)?;
        buf = &buf[n..];
        if key & 7 != 0 || !matches!(key >> 3, 1 | 3 | 4) {
            return Err(Error::Unsupported("a UnixFS field the release importer never writes"));
        }
        let (v, n) = varint_read(buf).ok_or_else(bad)?;
        buf = &buf[n..];
        match key >> 3 {
            1 => ty = Some(v),
            3 => size = Some(v),
            _ => {}
        }
    }
    match ty {
        Some(1) | Some(2) => Ok((ty.unwrap(), size)),
        Some(5) => Err(Error::Unsupported("a HAMT-sharded directory")),
        Some(4) => Err(Error::Unsupported("a symlink")),
        _ => Err(Error::Unsupported("a UnixFS node that is neither a file nor a directory")),
    }
}

/// What a name resolves to inside the tree.
#[derive(Debug, Clone)]
pub enum Node {
    Dir(Vec<Link>),
    File(Cid),
}

impl<'a> Car<'a> {
    /// What `cid` is. A raw CID is a whole file by its codec alone: its bytes are hashed when they are read
    /// (`read_file`), not here, so walking the tree costs only its directory blocks. Anything dag-pb is hashed here.
    pub fn node(&self, cid: &Cid) -> Result<Node, Error> {
        if cid.codec == CODEC_RAW {
            if !self.index.contains_key(cid) {
                return Err(Error::Integrity(format!("block {} is absent", cid.to_base32())));
            }
            return Ok(Node::File(*cid));
        }
        let (links, data) = dagpb_decode(self.block(cid)?)?;
        match unixfs(&data)? {
            (1, _) => {
                // kubo writes directory links sorted by name, unique and non-empty; anything else is not its DAG
                for w in links.windows(2) {
                    if w[0].name.as_bytes() >= w[1].name.as_bytes() {
                        return Err(Error::Format("directory links are not strictly sorted"));
                    }
                }
                if links.iter().any(|l| l.name.is_empty() || l.name == "." || l.name == ".." || l.name.contains('/')) {
                    return Err(Error::Format("a directory entry has an unusable name"));
                }
                Ok(Node::Dir(links))
            }
            _ => Ok(Node::File(*cid)),
        }
    }

    /// The tree entry at `segments` below the root (already validated path segments).
    pub fn lookup(&self, segments: &[&str]) -> Result<Option<Node>, Error> {
        let mut cur = self.node(&self.root)?;
        for seg in segments {
            let links = match &cur {
                Node::Dir(l) => l,
                Node::File(_) => return Ok(None),
            };
            let next = match links.iter().find(|l| l.name == *seg) {
                Some(l) => l.cid,
                None => return Ok(None),
            };
            cur = self.node(&next)?;
        }
        Ok(Some(cur))
    }

    /// A file's bytes in order: raw leaves verbatim; a dag-pb file node is its children in order, and its declared
    /// filesize must equal what they hold.
    pub fn read_file(&self, cid: &Cid, out: &mut Vec<u8>) -> Result<(), Error> {
        self.read_file_depth(cid, out, 0)
    }

    fn read_file_depth(&self, cid: &Cid, out: &mut Vec<u8>, depth: usize) -> Result<(), Error> {
        if depth > 16 {
            return Err(Error::Format("a file DAG deeper than any real release"));
        }
        if cid.codec == CODEC_RAW {
            out.extend_from_slice(self.block(cid)?);
            return Ok(());
        }
        let (links, data) = dagpb_decode(self.block(cid)?)?;
        match unixfs(&data)? {
            (2, size) => {
                let before = out.len();
                for l in &links {
                    self.read_file_depth(&l.cid, out, depth + 1)?;
                }
                if size.map_or(true, |s| s != (out.len() - before) as u64) {
                    return Err(Error::Integrity(format!("file {} holds a different size than it declares", cid.to_base32())));
                }
                Ok(())
            }
            _ => Err(Error::Format("a file's child is a directory")),
        }
    }
}

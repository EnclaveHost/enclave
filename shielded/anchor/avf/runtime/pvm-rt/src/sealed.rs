//! The browser channel's VM side (PVM-CPU.md, "The browser channel"; LAB): HTTP requests sealed to the VM's app key.
//!
//! A page cannot see a TLS peer's certificate, so it cannot pin the VM's TLS key. Instead it verifies v2 evidence itself
//! (web/pvm-verify.js) -- the app key below, vouched for by the attested transport key under the page's own nonce -- and
//! encrypts each request to that key (web/pvm-sealed.js). Only this process holds the private half: it is made here, never
//! leaves, and dies with the server.
//!
//! - HPKE (RFC 9180) base mode, DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM;
//!   info = LABEL " request" || 0x00 || HDR || AppID || RuntimeID, aad = the evidence nonce;
//! - a request is opened only under a nonce this VM answered with evidence ([`SealedKey::admit_nonce`]), for [`WINDOW`]
//!   after the answer and at most [`MAX_PER_NONCE`] times, and each (nonce, enc) only once: a replayed request is refused
//!   before it runs. When the window closes the nonce is forgotten and refused, so the replay memory is bounded by time;
//! - the response as in Oblivious HTTP (RFC 9458 section 4.4): secret = Export(LABEL " response", 16), a fresh 16-byte
//!   response nonce, salt = enc || response nonce, HKDF-SHA256 to an AES-128-GCM key and nonce;
//! - frames: in, `u32 len || nonce(32) || HDR(7) || enc(32) || ct`; out, `0x00 || response nonce || ct`, or `0x01 || reason`
//!   (unauthenticated: a hint; the page re-fetches evidence on any refusal and never re-sends a ciphertext).

use hpke::kem::X25519HkdfSha256;
use hpke::{aead::AesGcm128, kdf::HkdfSha256, Deserializable, Kem as _, OpModeR, Serializable};
use ring::rand::{SecureRandom, SystemRandom};
use ring::{aead, hkdf};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const LABEL: &str = "enclave-pvm-sealed-http/v1";
/// key_id 0, KEM 0x0020 DHKEM(X25519, HKDF-SHA256), KDF 0x0001 HKDF-SHA256, AEAD 0x0001 AES-128-GCM: the whole response
/// sealed at once
pub const HDR: [u8; 7] = [0x00, 0x00, 0x20, 0x00, 0x01, 0x00, 0x01];
/// key_id 1, the same key and suite: the response STREAMED in chunks (draft-ietf-ohai-chunked-ohttp-08's response
/// format). The key id is inside the HPKE info, so a carrier that flips the mode gets a request that does not open.
pub const HDR_CHUNKED: [u8; 7] = [0x01, 0x00, 0x20, 0x00, 0x01, 0x00, 0x01];
/// Streamed responses: at most this many plaintext bytes per chunk, this many chunks, this many bytes in all.
pub const CHUNK_PLAINTEXT: usize = 16 << 10;
pub const MAX_CHUNKS: u64 = 1 << 20;
/// How long after an evidence answer its nonce admits sealed requests, and how many (the v2 format's constants).
pub const WINDOW: Duration = Duration::from_secs(600);
pub const MAX_PER_NONCE: u32 = 256;
pub const MAX_REQUEST: usize = 1 << 20;
pub const MAX_RESPONSE: usize = 16 << 20;
/// Nonces remembered at once (the payload answers at most 120 per session; this is a second bound).
const MAX_NONCES: usize = 1024;
const HEAD: usize = 32 + 7 + 32;

type Kem = X25519HkdfSha256;

struct Window {
    at: Instant,
    used: u32,
    encs: HashSet<[u8; 32]>,
}

/// The VM's app key and the nonces it may be used under.
pub struct SealedKey {
    sk: <Kem as hpke::Kem>::PrivateKey,
    pub public: [u8; 32],
    info: Vec<u8>,
    info_chunked: Vec<u8>,
    nonces: Mutex<HashMap<[u8; 32], Window>>,
}

/// An opened request: the HTTP/1.1 bytes, and what its response is sealed under.
pub struct Opened {
    pub request: Vec<u8>,
    enc: [u8; 32],
    secret: [u8; 16],
    pub nonce: [u8; 32],
    /// the page asked for a streamed response (key id 1)
    pub chunked: bool,
}

/// Never prints the request or the secret.
impl std::fmt::Debug for Opened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Opened({} bytes)", self.request.len())
    }
}
impl Drop for Opened {
    fn drop(&mut self) {
        self.secret.iter_mut().for_each(|b| *b = 0);
    }
}

struct Len(usize);
impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

impl SealedKey {
    /// A fresh key for this app and runtime (the info every request is sealed under).
    pub fn generate(app_id: &[u8; 32], runtime_id: &[u8; 32]) -> SealedKey {
        let (sk, pk) = Kem::gen_keypair();
        Self::with(sk, pk, app_id, runtime_id)
    }
    /// A given private key (tests: the cross-language vector).
    pub fn from_secret(sk: &[u8; 32], app_id: &[u8; 32], runtime_id: &[u8; 32]) -> Result<SealedKey, String> {
        let sk = <Kem as hpke::Kem>::PrivateKey::from_bytes(sk).map_err(|e| format!("app key: {e:?}"))?;
        let pk = Kem::sk_to_pk(&sk);
        Ok(Self::with(sk, pk, app_id, runtime_id))
    }
    fn with(sk: <Kem as hpke::Kem>::PrivateKey, pk: <Kem as hpke::Kem>::PublicKey, app_id: &[u8; 32], runtime_id: &[u8; 32]) -> SealedKey {
        let mut public = [0u8; 32];
        public.copy_from_slice(&pk.to_bytes());
        let info_for = |label: &str, hdr: &[u8; 7]| {
            let mut info = label.as_bytes().to_vec();
            info.push(0);
            info.extend_from_slice(hdr);
            info.extend_from_slice(app_id);
            info.extend_from_slice(runtime_id);
            info
        };
        SealedKey {
            sk,
            public,
            info: info_for(&format!("{LABEL} request"), &HDR),
            info_chunked: info_for(&format!("{LABEL} chunked request"), &HDR_CHUNKED),
            nonces: Mutex::new(HashMap::new()),
        }
    }

    /// This VM answered `nonce` with evidence (which carried this key): requests under it are admitted for the window.
    pub fn admit_nonce(&self, nonce: &[u8; 32]) {
        self.admit_nonce_at(nonce, Instant::now())
    }
    pub fn admit_nonce_at(&self, nonce: &[u8; 32], now: Instant) {
        let mut m = self.nonces.lock().unwrap_or_else(|p| p.into_inner());
        m.retain(|_, w| now.duration_since(w.at) < WINDOW);
        if m.len() >= MAX_NONCES {
            return; // the oldest stay until they expire; a flood of evidence requests cannot evict a live window
        }
        m.entry(*nonce).or_insert(Window { at: now, used: 0, encs: HashSet::new() });
    }

    /// Open one request (the frame's body, without the length). Every refusal is a reason the page may see.
    pub fn open(&self, body: &[u8]) -> Result<Opened, String> {
        self.open_at(body, Instant::now())
    }
    pub fn open_at(&self, body: &[u8], now: Instant) -> Result<Opened, String> {
        if body.len() < HEAD + 16 || body.len() > MAX_REQUEST {
            return Err("not a sealed request (size)".into());
        }
        let (nonce, rest) = body.split_at(32);
        let (hdr, rest) = rest.split_at(7);
        let (enc, ct) = rest.split_at(32);
        let chunked = match hdr {
            h if h == HDR => false,
            h if h == HDR_CHUNKED => true,
            _ => return Err("unsupported key id or suite".into()),
        };
        let nonce: [u8; 32] = nonce.try_into().expect("32");
        let enc: [u8; 32] = enc.try_into().expect("32");
        // one lock across check, open and record: a replay cannot race its original
        let mut m = self.nonces.lock().unwrap_or_else(|p| p.into_inner());
        let w = match m.get_mut(&nonce) {
            None => return Err("unknown evidence nonce: fetch fresh evidence (the key rotates with each boot)".into()),
            Some(w) if now.duration_since(w.at) >= WINDOW => {
                m.remove(&nonce);
                return Err("the evidence nonce's window has closed: fetch fresh evidence".into());
            }
            Some(w) => w,
        };
        if w.encs.contains(&enc) {
            return Err("replayed request: refused before it runs".into());
        }
        if w.used >= MAX_PER_NONCE {
            return Err("this evidence nonce's request budget is spent: fetch fresh evidence".into());
        }
        let encapped = <Kem as hpke::Kem>::EncappedKey::from_bytes(&enc).map_err(|_| "cannot open (bad key share)".to_string())?;
        let info = if chunked { &self.info_chunked } else { &self.info };
        let mut ctx = hpke::setup_receiver::<AesGcm128, HkdfSha256, Kem>(&OpModeR::Base, &self.sk, &encapped, info)
            .map_err(|_| "cannot open (key agreement failed)".to_string())?;
        let request = ctx.open(ct, &nonce).map_err(|_| "cannot open: not sealed to this VM's app key for this app, runtime and nonce".to_string())?;
        let mut secret = [0u8; 16];
        let label = if chunked { format!("{LABEL} chunked response") } else { format!("{LABEL} response") };
        ctx.export(label.as_bytes(), &mut secret).map_err(|_| "export failed".to_string())?;
        w.encs.insert(enc);
        w.used += 1;
        Ok(Opened { request, enc, secret, nonce, chunked })
    }

    /// Seal a response for an opened request, under a fresh response nonce (or a given one: tests).
    pub fn seal_response(o: &Opened, response: &[u8], response_nonce: Option<[u8; 16]>) -> Result<Vec<u8>, String> {
        let rn = match response_nonce {
            Some(n) => n,
            None => {
                let mut n = [0u8; 16];
                SystemRandom::new().fill(&mut n).map_err(|_| "no randomness".to_string())?;
                n
            }
        };
        if o.chunked {
            return Err("a chunked request is answered with ChunkSealer".into());
        }
        let (k, iv) = response_keys(o, &rn)?;
        let mut out = Vec::with_capacity(1 + 16 + response.len() + 16);
        out.push(0);
        out.extend_from_slice(&rn);
        let mut buf = response.to_vec();
        k.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(iv), aead::Aad::empty(), &mut buf).map_err(|_| "seal".to_string())?;
        out.extend_from_slice(&buf);
        Ok(out)
    }
}

/// The response key and base nonce for an opened request under a response nonce (RFC 9458 4.4; chunked: the same
/// derivation under the chunked export label).
fn response_keys(o: &Opened, rn: &[u8; 16]) -> Result<(aead::LessSafeKey, [u8; 12]), String> {
    let mut salt = o.enc.to_vec();
    salt.extend_from_slice(rn);
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(&o.secret);
    let (mut key, mut iv) = ([0u8; 16], [0u8; 12]);
    prk.expand(&[b"key"], Len(16)).and_then(|k| k.fill(&mut key)).map_err(|_| "hkdf".to_string())?;
    prk.expand(&[b"nonce"], Len(12)).and_then(|k| k.fill(&mut iv)).map_err(|_| "hkdf".to_string())?;
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &key).map_err(|_| "aead key".to_string())?);
    key.iter_mut().for_each(|b| *b = 0);
    Ok((k, iv))
}

/// QUIC variable-length integer (RFC 9000 section 16), the chunk length prefix.
pub fn varint(v: u64, out: &mut Vec<u8>) {
    match v {
        0..=63 => out.push(v as u8),
        64..=16383 => out.extend_from_slice(&((v as u16) | 0x4000).to_be_bytes()),
        16384..=1073741823 => out.extend_from_slice(&((v as u32) | 0x8000_0000).to_be_bytes()),
        _ => out.extend_from_slice(&(v | 0xc000_0000_0000_0000).to_be_bytes()),
    }
}

/// Chunk types (SEALED-STREAMING.md): data, the authenticated end (FIN), an authenticated in-stream error (ABORT).
pub const CHUNK_DATA: u8 = 0x00;
pub const CHUNK_FIN: u8 = 0x01;
pub const CHUNK_ABORT: u8 = 0x02;
pub const CHUNK_AAD_LABEL: &[u8] = b"enclave-pvm-sealed-chunk-v1";

/// A streamed response (SEALED-STREAMING.md; the key schedule and nonce construction of draft-ietf-ohai-chunked-ohttp-08,
/// typed framing): the header `0x00 || response nonce(16)`, then chunks `type || varint(len) || ct`, chunk i sealed with
/// AES-128-GCM under nonce = base XOR be96(i) and aad = CHUNK_AAD_LABEL || evidence nonce || response nonce || be64(i) ||
/// type. Exactly one FIN or ABORT ends it. A reordered, duplicated, dropped, spliced or altered chunk fails at the page;
/// a stream cut short has no FIN; bytes after FIN are refused.
pub struct ChunkSealer {
    key: aead::LessSafeKey,
    base: [u8; 12],
    nonce: [u8; 32],
    rn: [u8; 16],
    counter: u64,
    pub bytes: u64,
}

impl ChunkSealer {
    /// The stream's header and its sealer, under a fresh response nonce (or a given one: tests).
    pub fn start(o: &Opened, response_nonce: Option<[u8; 16]>) -> Result<(Vec<u8>, ChunkSealer), String> {
        if !o.chunked {
            return Err("not a chunked request".into());
        }
        let rn = match response_nonce {
            Some(n) => n,
            None => {
                let mut n = [0u8; 16];
                SystemRandom::new().fill(&mut n).map_err(|_| "no randomness".to_string())?;
                n
            }
        };
        let (key, base) = response_keys(o, &rn)?;
        let mut head = vec![0u8];
        head.extend_from_slice(&rn);
        Ok((head, ChunkSealer { key, base, nonce: o.nonce, rn, counter: 0, bytes: 0 }))
    }
    pub fn chunks(&self) -> u64 {
        self.counter
    }
    fn seal(&mut self, kind: u8, pt: &[u8]) -> Result<Vec<u8>, String> {
        if self.counter >= MAX_CHUNKS {
            return Err("too many chunks".into());
        }
        let ok = match kind {
            CHUNK_DATA => !pt.is_empty() && pt.len() <= CHUNK_PLAINTEXT,
            CHUNK_FIN => pt.len() <= CHUNK_PLAINTEXT,
            CHUNK_ABORT => pt.len() <= 256,
            _ => false,
        };
        if !ok || self.bytes + pt.len() as u64 > MAX_RESPONSE as u64 {
            return Err("chunk size out of range".into());
        }
        let mut n = self.base;
        for (i, b) in self.counter.to_be_bytes().iter().enumerate() {
            n[4 + i] ^= b;
        }
        let mut aad = CHUNK_AAD_LABEL.to_vec();
        aad.extend_from_slice(&self.nonce);
        aad.extend_from_slice(&self.rn);
        aad.extend_from_slice(&self.counter.to_be_bytes());
        aad.push(kind);
        self.counter += 1;
        let mut buf = pt.to_vec();
        self.key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(n), aead::Aad::from(&aad[..]), &mut buf).map_err(|_| "seal".to_string())?;
        let mut out = Vec::with_capacity(buf.len() + 9);
        out.push(kind);
        varint(buf.len() as u64, &mut out);
        out.extend_from_slice(&buf);
        self.bytes += pt.len() as u64;
        Ok(out)
    }
    /// A data chunk (1..=CHUNK_PLAINTEXT bytes of plaintext).
    pub fn chunk(&mut self, pt: &[u8]) -> Result<Vec<u8>, String> {
        self.seal(CHUNK_DATA, pt)
    }
    /// The authenticated end (possibly empty plaintext): nothing may follow it.
    pub fn finish(mut self, pt: &[u8]) -> Result<Vec<u8>, String> {
        self.seal(CHUNK_FIN, pt)
    }
    /// An authenticated in-stream error: the stream ends, failed, and the page knows the VM said so.
    pub fn abort(mut self, why: &str) -> Result<Vec<u8>, String> {
        let b = why.as_bytes();
        self.seal(CHUNK_ABORT, &b[..b.len().min(256)])
    }
}

/// A refusal frame: 0x01 || reason.
pub fn refusal(why: &str) -> Vec<u8> {
    let mut v = vec![1u8];
    v.extend_from_slice(why.as_bytes());
    v
}

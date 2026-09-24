// The browser channel's VM side (src/sealed.rs, httpd.rs serve_sealed_fd), on the host: the page's bytes (the
// cross-language vector written by web/pvm-sealed.js) open here and the response seals to exactly what the page expects;
// a request opens only under an admitted nonce, once, within the window and the budget, and only for this app, runtime and
// key; and a sealed request through a socketpair reaches the real component (enclave-apps' ggml-probe) and comes back
// sealed, with no plaintext on the wire.
use hpke::kem::X25519HkdfSha256;
use hpke::{aead::AesGcm128, kdf::HkdfSha256, Deserializable, OpModeS, Serializable};
use pvm_rt::httpd::HttpServer;
use pvm_rt::nn::NnEngine;
use pvm_rt::sealed::{SealedKey, HDR, LABEL, MAX_PER_NONCE, WINDOW};
use pvm_rt::NnModel;
use std::io::{Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn arr(s: &str) -> [u8; 32] {
    unhex(s).try_into().unwrap()
}
/// One string field of the vector file (flat JSON of strings; the escapes it uses: \r \n \" \\).
fn field(json: &str, key: &str) -> String {
    let at = json.find(&format!("\"{key}\": \"")).unwrap_or_else(|| panic!("no {key}")) + key.len() + 5;
    let mut out = String::new();
    let mut it = json[at..].chars();
    while let Some(c) = it.next() {
        match c {
            '"' => return out,
            '\\' => out.push(match it.next().unwrap() {
                'r' => '\r',
                'n' => '\n',
                c => c,
            }),
            c => out.push(c),
        }
    }
    panic!("unterminated {key}")
}

#[test]
fn the_pages_vector_opens_here_and_the_response_seals_to_the_pages_bytes() {
    let v = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sealed-vectors.json")).unwrap();
    let k = SealedKey::from_secret(&arr(&field(&v, "skR")), &arr(&field(&v, "appId")), &arr(&field(&v, "runtimeId"))).unwrap();
    assert_eq!(k.public.to_vec(), unhex(&field(&v, "pkR")));
    let frame = unhex(&field(&v, "frame"));
    assert_eq!(u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize, frame.len() - 4);
    let body = &frame[4..];
    // not yet admitted: refused
    assert!(k.open(body).unwrap_err().contains("unknown evidence nonce"));
    k.admit_nonce(&arr(&field(&v, "nonce")));
    let o = k.open(body).unwrap();
    assert_eq!(String::from_utf8(o.request.clone()).unwrap(), field(&v, "request"));
    let rn: [u8; 16] = unhex(&field(&v, "responseNonce")).try_into().unwrap();
    let sealed = SealedKey::seal_response(&o, field(&v, "response").as_bytes(), Some(rn)).unwrap();
    assert_eq!(sealed, unhex(&field(&v, "sealedResponse")), "the VM's response bytes are the page's");
    // the same bytes again: a replay, refused before anything runs
    assert!(k.open(body).unwrap_err().contains("replayed"));
}

/// A page's side in Rust (the test's own sender): seal `req` to `pk` under this app/runtime/nonce.
fn seal_to(pk: &[u8; 32], app: &[u8; 32], rid: &[u8; 32], nonce: &[u8; 32], req: &[u8]) -> (Vec<u8>, [u8; 32], [u8; 16]) {
    let mut info = format!("{LABEL} request").into_bytes();
    info.push(0);
    info.extend_from_slice(&HDR);
    info.extend_from_slice(app);
    info.extend_from_slice(rid);
    let pkr = <X25519HkdfSha256 as hpke::Kem>::PublicKey::from_bytes(pk).unwrap();
    let (enc, mut ctx) = hpke::setup_sender::<AesGcm128, HkdfSha256, X25519HkdfSha256>(&OpModeS::Base, &pkr, &info).unwrap();
    let ct = ctx.seal(req, nonce).unwrap();
    let mut secret = [0u8; 16];
    ctx.export(format!("{LABEL} response").as_bytes(), &mut secret).unwrap();
    let enc: [u8; 32] = enc.to_bytes().as_slice().try_into().unwrap();
    let mut body = nonce.to_vec();
    body.extend_from_slice(&HDR);
    body.extend_from_slice(&enc);
    body.extend_from_slice(&ct);
    (body, enc, secret)
}
/// Open the VM's answer as the page does (ring: HKDF-SHA256, AES-128-GCM).
fn open_answer(enc: &[u8; 32], secret: &[u8; 16], answer: &[u8]) -> Result<Vec<u8>, String> {
    use ring::{aead, hkdf};
    struct L(usize);
    impl hkdf::KeyType for L {
        fn len(&self) -> usize {
            self.0
        }
    }
    if answer.first() == Some(&1) {
        return Err(String::from_utf8_lossy(&answer[1..]).into_owned());
    }
    let (rn, ct) = answer[1..].split_at(16);
    let mut salt = enc.to_vec();
    salt.extend_from_slice(rn);
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(secret);
    let (mut key, mut iv) = ([0u8; 16], [0u8; 12]);
    prk.expand(&[b"key"], L(16)).unwrap().fill(&mut key).unwrap();
    prk.expand(&[b"nonce"], L(12)).unwrap().fill(&mut iv).unwrap();
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &key).unwrap());
    let mut buf = ct.to_vec();
    let pt = k.open_in_place(aead::Nonce::assume_unique_for_key(iv), aead::Aad::empty(), &mut buf).map_err(|_| "does not open".to_string())?;
    Ok(pt.to_vec())
}

#[test]
fn admission_window_budget_replay_and_context() {
    let (app, rid) = ([1u8; 32], [2u8; 32]);
    let k = SealedKey::generate(&app, &rid);
    let (n1, n2) = ([3u8; 32], [4u8; 32]);
    let t0 = Instant::now();
    k.admit_nonce_at(&n1, t0);
    let (b, _, _) = seal_to(&k.public, &app, &rid, &n1, b"GET / HTTP/1.1\r\n\r\n");
    assert!(k.open_at(&b, t0).is_ok());
    assert!(k.open_at(&b, t0).unwrap_err().contains("replayed"));
    // another app or runtime in the page's info, another VM's key: cannot open (and the nonce's budget is not spent)
    let (b, _, _) = seal_to(&k.public, &[9u8; 32], &rid, &n1, b"x");
    assert!(k.open_at(&b, t0).unwrap_err().contains("cannot open"));
    let (b, _, _) = seal_to(&k.public, &app, &[9u8; 32], &n1, b"x");
    assert!(k.open_at(&b, t0).unwrap_err().contains("cannot open"));
    let other = SealedKey::generate(&app, &rid);
    let (b, _, _) = seal_to(&other.public, &app, &rid, &n1, b"x");
    assert!(k.open_at(&b, t0).unwrap_err().contains("cannot open"));
    // the nonce is the AAD: a carrier that moves a request to another admitted nonce breaks it
    k.admit_nonce_at(&n2, t0);
    let (mut b, _, _) = seal_to(&k.public, &app, &rid, &n1, b"x");
    b[..32].copy_from_slice(&n2);
    assert!(k.open_at(&b, t0).unwrap_err().contains("cannot open"));
    // one flipped ciphertext byte, a wrong suite, a short frame
    let (mut b, _, _) = seal_to(&k.public, &app, &rid, &n1, b"x");
    let last = b.len() - 1;
    b[last] ^= 1;
    assert!(k.open_at(&b, t0).unwrap_err().contains("cannot open"));
    let (mut b, _, _) = seal_to(&k.public, &app, &rid, &n1, b"x");
    b[32 + 6] = 2;
    assert!(k.open_at(&b, t0).unwrap_err().contains("suite"));
    assert!(k.open_at(&[0u8; 40], t0).unwrap_err().contains("size"));
    // the window closes: refused, and the nonce is forgotten
    let (b, _, _) = seal_to(&k.public, &app, &rid, &n2, b"late");
    assert!(k.open_at(&b, t0 + WINDOW).unwrap_err().contains("window has closed"));
    assert!(k.open_at(&b, t0 + WINDOW).unwrap_err().contains("unknown evidence nonce"));
    // the budget: MAX_PER_NONCE requests per nonce (the first above counted), then refused
    for _ in 1..MAX_PER_NONCE {
        let (b, _, _) = seal_to(&k.public, &app, &rid, &n1, b"x");
        k.open_at(&b, t0).unwrap();
    }
    let (b, _, _) = seal_to(&k.public, &app, &rid, &n1, b"x");
    assert!(k.open_at(&b, t0).unwrap_err().contains("budget"));
}

struct Mock;
impl NnEngine for Mock {
    fn n_vocab(&self) -> usize {
        152_000
    }
    fn n_ctx(&self) -> usize {
        4096
    }
    fn tokenize(&self, t: &[u8]) -> Result<Vec<i32>, String> {
        Ok(t.iter().map(|b| *b as i32).collect())
    }
    fn piece(&self, id: i32) -> Result<Vec<u8>, String> {
        Ok(id.to_string().into_bytes())
    }
    fn reset(&self) -> Result<(), String> {
        Ok(())
    }
    fn decode(&self, _ids: &[i32], logits: &mut [f32]) -> Result<(), String> {
        logits.iter_mut().for_each(|l| *l = 0.0);
        logits[7] = 1.0;
        Ok(())
    }
}

#[test]
fn a_sealed_request_reaches_the_component_and_comes_back_sealed() {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/bundles/ggml-probe.wasm");
    let bytes = std::fs::read(p).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&bytes).into();
    let rid = [5u8; 32];
    let notes = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let n2 = notes.clone();
    let mut s = HttpServer::open(&bytes, &d, 256 << 20, Duration::from_secs(30),
        Some(NnModel { name: "mock-1".into(), engine: Arc::new(Mock) }),
        Some(Box::new(move |b: &[u8]| n2.lock().unwrap().push(String::from_utf8_lossy(b).into_owned()))))
    .unwrap();
    let pk = s.enable_sealed(&d, &rid);
    let s = Arc::new(s);
    let nonce = [6u8; 32];
    assert!(s.sealed_admit_nonce(&nonce));
    let one = |body: &[u8]| -> Vec<u8> {
        let (mut client, srv_end) = UnixStream::pair().unwrap();
        let s2 = s.clone();
        let fd = srv_end.into_raw_fd();
        let t = std::thread::spawn(move || unsafe { s2.serve_sealed_fd(fd) }.is_ok());
        client.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        client.write_all(body).unwrap();
        let mut answer = Vec::new();
        client.read_to_end(&mut answer).unwrap();
        assert!(t.join().unwrap());
        answer
    };
    let req = b"GET /?graph=mock-1&steps=3 HTTP/1.1\r\nhost: pvm-app\r\nconnection: close\r\n\r\n";
    let (body, enc, secret) = seal_to(&pk, &d, &rid, &nonce, req);
    assert!(!body.windows(5).any(|w| w == b"graph"), "no plaintext on the wire");
    let answer = one(&body);
    assert!(!answer.windows(6).any(|w| w == b"tokens"), "no plaintext on the way back");
    let resp = String::from_utf8(open_answer(&enc, &secret, &answer).unwrap()).unwrap();
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    assert!(resp.contains("\"tokens\""), "{resp}");
    assert_eq!(s.requests(), 1);
    // the same bytes again: refused before the component runs
    let again = one(&body);
    assert!(open_answer(&enc, &secret, &again).unwrap_err().contains("replayed"));
    assert_eq!(s.requests(), 1);
    // a nonce the VM never answered
    let (body, enc, secret) = seal_to(&pk, &d, &rid, &[8u8; 32], req);
    assert!(open_answer(&enc, &secret, &one(&body)).unwrap_err().contains("unknown evidence nonce"));
    assert_eq!(s.requests(), 1);
    let n = notes.lock().unwrap().join("\n");
    assert!(n.contains("SEALED served") && n.contains("SEALED refused: replayed"), "{n}");
    assert!(!n.contains("graph=mock"), "no plaintext in the notes: {n}");
}

// ---- streamed responses (SEALED-STREAMING.md) ----
use pvm_rt::sealed::{ChunkSealer, CHUNK_AAD_LABEL, HDR_CHUNKED};

/// The JSON string array `parts` of the stream vector (flat strings; the escapes \r \n \" \\).
fn parts(json: &str) -> Vec<String> {
    let at = json.find("\"parts\": [").unwrap() + 10;
    let mut out = vec![];
    let mut it = json[at..].chars();
    let mut cur: Option<String> = None;
    while let Some(c) = it.next() {
        match (c, cur.as_mut()) {
            (']', None) => return out,
            ('"', None) => cur = Some(String::new()),
            ('"', Some(_)) => out.push(cur.take().unwrap()),
            ('\\', Some(s)) => s.push(match it.next().unwrap() {
                'r' => '\r',
                'n' => '\n',
                c => c,
            }),
            (c, Some(s)) => s.push(c),
            _ => {}
        }
    }
    panic!("unterminated parts")
}

#[test]
fn the_pages_stream_vector_opens_here_and_the_stream_seals_to_the_pages_bytes() {
    let v = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/sealed-stream-vectors.json")).unwrap();
    let k = SealedKey::from_secret(&arr(&field(&v, "skR")), &arr(&field(&v, "appId")), &arr(&field(&v, "runtimeId"))).unwrap();
    let frame = unhex(&field(&v, "frame"));
    assert_eq!(&frame[4 + 32..4 + 39], &HDR_CHUNKED);
    k.admit_nonce(&arr(&field(&v, "nonce")));
    let o = k.open(&frame[4..]).unwrap();
    assert!(o.chunked);
    assert_eq!(String::from_utf8(o.request.clone()).unwrap(), field(&v, "request"));
    let rn: [u8; 16] = unhex(&field(&v, "responseNonce")).try_into().unwrap();
    let ps = parts(&v);
    let (head, mut s) = ChunkSealer::start(&o, Some(rn)).unwrap();
    let mut stream = head.clone();
    for p in &ps {
        stream.extend(s.chunk(p.as_bytes()).unwrap());
    }
    stream.extend(s.finish(&[]).unwrap());
    assert_eq!(stream, unhex(&field(&v, "stream")), "the VM's stream is the page's, byte for byte");
    let (head2, mut a) = ChunkSealer::start(&o, Some(rn)).unwrap();
    let mut aborted = head2;
    aborted.extend(a.chunk(ps[0].as_bytes()).unwrap());
    aborted.extend(a.chunk(ps[1].as_bytes()).unwrap());
    aborted.extend(a.abort(&field(&v, "abortReason")).unwrap());
    assert_eq!(aborted, unhex(&field(&v, "aborted")));
    // a whole-mode sealing of a chunked request, and chunk-size misuse, are refused
    assert!(SealedKey::seal_response(&o, b"x", Some(rn)).is_err());
    let (_, mut m) = ChunkSealer::start(&o, Some(rn)).unwrap();
    assert!(m.chunk(&[]).is_err(), "an empty data chunk");
    assert!(m.chunk(&vec![0u8; pvm_rt::sealed::CHUNK_PLAINTEXT + 1]).is_err(), "an oversized chunk");
}

/// The page's side of a stream, in Rust (tests): open chunk by chunk, strictly in order; Ok((plaintext, "fin"|"abort")).
fn read_stream(enc: &[u8; 32], secret: &[u8; 16], nonce: &[u8; 32], s: &[u8]) -> Result<(Vec<u8>, String), String> {
    use ring::{aead, hkdf};
    struct L(usize);
    impl hkdf::KeyType for L {
        fn len(&self) -> usize {
            self.0
        }
    }
    if s.first() == Some(&1) {
        return Err(format!("refused: {}", String::from_utf8_lossy(&s[1..])));
    }
    if s.len() < 17 || s[0] != 0 {
        return Err("truncated before any chunk".into());
    }
    let rn = &s[1..17];
    let mut salt = enc.to_vec();
    salt.extend_from_slice(rn);
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, &salt).extract(secret);
    let (mut key, mut base) = ([0u8; 16], [0u8; 12]);
    prk.expand(&[b"key"], L(16)).unwrap().fill(&mut key).unwrap();
    prk.expand(&[b"nonce"], L(12)).unwrap().fill(&mut base).unwrap();
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &key).unwrap());
    let (mut p, mut i, mut out) = (17usize, 0u64, Vec::new());
    while p < s.len() {
        let t = s[p];
        let vl = 1usize << (s[p + 1] >> 6);
        let mut len = (s[p + 1] & 0x3f) as usize;
        for q in 1..vl {
            len = len * 256 + s[p + 1 + q] as usize;
        }
        let start = p + 1 + vl;
        if start + len > s.len() {
            return Err(format!("truncated inside chunk {i}"));
        }
        let mut n = base;
        for (q, b) in i.to_be_bytes().iter().enumerate() {
            n[4 + q] ^= b;
        }
        let mut aad = CHUNK_AAD_LABEL.to_vec();
        aad.extend_from_slice(nonce);
        aad.extend_from_slice(rn);
        aad.extend_from_slice(&i.to_be_bytes());
        aad.push(t);
        let mut buf = s[start..start + len].to_vec();
        let pt = k.open_in_place(aead::Nonce::assume_unique_for_key(n), aead::Aad::from(&aad[..]), &mut buf).map_err(|_| format!("chunk {i} does not open"))?;
        p = start + len;
        i += 1;
        match t {
            0 => out.extend_from_slice(pt),
            1 | 2 => {
                if p != s.len() {
                    return Err("bytes after the end".into());
                }
                if t == 1 {
                    out.extend_from_slice(pt);
                }
                return Ok((out, if t == 1 { "fin".into() } else { format!("abort: {}", String::from_utf8_lossy(pt)) }));
            }
            _ => return Err("unknown type".into()),
        }
    }
    Err(format!("truncated after {i} chunks: no FIN"))
}

/// A model engine whose every decode takes `ms` and is counted (to see a cancelled stream stop decoding).
struct Slow(std::sync::atomic::AtomicUsize, u64);
impl NnEngine for Slow {
    fn n_vocab(&self) -> usize {
        152_000
    }
    fn n_ctx(&self) -> usize {
        4096
    }
    fn tokenize(&self, t: &[u8]) -> Result<Vec<i32>, String> {
        Ok(t.iter().map(|b| *b as i32).collect())
    }
    fn piece(&self, id: i32) -> Result<Vec<u8>, String> {
        Ok(id.to_string().into_bytes())
    }
    fn reset(&self) -> Result<(), String> {
        Ok(())
    }
    fn decode(&self, _ids: &[i32], logits: &mut [f32]) -> Result<(), String> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::thread::sleep(Duration::from_millis(self.1));
        logits.iter_mut().for_each(|l| *l = 0.0);
        logits[7] = 1.0;
        Ok(())
    }
}

/// A page's chunked request in Rust (tests): (body, enc, secret) under the chunked info and export label.
fn seal_chunked(pk: &[u8; 32], app: &[u8; 32], rid: &[u8; 32], nonce: &[u8; 32], req: &[u8]) -> (Vec<u8>, [u8; 32], [u8; 16]) {
    let mut info = format!("{LABEL} chunked request").into_bytes();
    info.push(0);
    info.extend_from_slice(&HDR_CHUNKED);
    info.extend_from_slice(app);
    info.extend_from_slice(rid);
    let pkr = <X25519HkdfSha256 as hpke::Kem>::PublicKey::from_bytes(pk).unwrap();
    let (enc, mut ctx) = hpke::setup_sender::<AesGcm128, HkdfSha256, X25519HkdfSha256>(&OpModeS::Base, &pkr, &info).unwrap();
    let ct = ctx.seal(req, nonce).unwrap();
    let mut secret = [0u8; 16];
    ctx.export(format!("{LABEL} chunked response").as_bytes(), &mut secret).unwrap();
    let enc: [u8; 32] = enc.to_bytes().as_slice().try_into().unwrap();
    let mut body = nonce.to_vec();
    body.extend_from_slice(&HDR_CHUNKED);
    body.extend_from_slice(&enc);
    body.extend_from_slice(&ct);
    (body, enc, secret)
}

#[test]
fn a_streamed_request_reaches_the_component_streams_back_sealed_and_a_cancel_stops_the_decode() {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/bundles/stream-probe.wasm");
    let bytes = std::fs::read(p).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&bytes).into();
    let rid = [5u8; 32];
    let engine = Arc::new(Slow(std::sync::atomic::AtomicUsize::new(0), 20));
    let notes = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let n2 = notes.clone();
    let mut s = HttpServer::open(&bytes, &d, 256 << 20, Duration::from_secs(60),
        Some(NnModel { name: "mock-1".into(), engine: engine.clone() }),
        Some(Box::new(move |b: &[u8]| n2.lock().unwrap().push(String::from_utf8_lossy(b).into_owned()))))
    .unwrap();
    let pk = s.enable_sealed(&d, &rid);
    let s = Arc::new(s);
    let nonce = [6u8; 32];
    s.sealed_admit_nonce(&nonce);
    let connect = |body: &[u8]| {
        let (mut client, srv_end) = UnixStream::pair().unwrap();
        let s2 = s.clone();
        let fd = srv_end.into_raw_fd();
        let t = std::thread::spawn(move || unsafe { s2.serve_sealed_fd(fd) }.is_ok());
        client.write_all(&(body.len() as u32).to_be_bytes()).unwrap();
        client.write_all(body).unwrap();
        (client, t)
    };
    // whole: 5 tokens, every line arrives, FIN
    let (body, enc, secret) = seal_chunked(&pk, &d, &rid, &nonce, b"GET /?graph=mock-1&steps=5 HTTP/1.1\r\nhost: pvm-app\r\nconnection: close\r\n\r\n");
    let (mut c, t) = connect(&body);
    let mut all = Vec::new();
    c.read_to_end(&mut all).unwrap();
    assert!(t.join().unwrap());
    assert!(!all.windows(6).any(|w| w == b"\"token"), "no plaintext on the wire");
    let (pt, how) = read_stream(&enc, &secret, &nonce, &all).unwrap();
    assert_eq!(how, "fin");
    let text = String::from_utf8(pt).unwrap();
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    assert_eq!(text.matches("\"token\":").count(), 5, "{text}");
    assert!(text.contains("\"done\":true"), "{text}");
    // truncation: the same stream cut before its FIN does not read as complete
    assert!(read_stream(&enc, &secret, &nonce, &all[..all.len() - 3]).unwrap_err().contains("truncated"));
    // cancel: 256 tokens asked, the page reads the header and a few chunks and goes; the decode stops
    let before = engine.0.load(std::sync::atomic::Ordering::Relaxed);
    let (body, _, _) = seal_chunked(&pk, &d, &rid, &nonce, b"GET /?graph=mock-1&steps=256 HTTP/1.1\r\nhost: pvm-app\r\nconnection: close\r\n\r\n");
    let (mut c, t) = connect(&body);
    let mut first = [0u8; 600];
    c.read_exact(&mut first).unwrap();
    drop(c);
    let t0 = std::time::Instant::now();
    assert!(t.join().unwrap());
    let decoded = engine.0.load(std::sync::atomic::Ordering::Relaxed) - before;
    assert!(decoded < 64, "a cancelled stream stops decoding (decoded {decoded} of 256)");
    assert!(t0.elapsed() < Duration::from_secs(3), "and ends promptly");
    let n = notes.lock().unwrap().join("\n");
    assert!(n.contains(" fin after ") && n.contains(" cancelled after "), "{n}");
    assert!(!n.contains("graph=mock"), "no plaintext in the notes: {n}");
}

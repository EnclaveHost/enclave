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

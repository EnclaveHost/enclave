//! A sibling VM's Android protected-VM attestation, verified INSIDE this VM (PVM-CPU.md "Slots by share"). The relay's
//! verifier (relay/avf-verify.mjs) is the reference; this is the same policy for the one decision a VM makes about another:
//! whether it is a VM of this very build, in protected mode, that asked for exactly this challenge -- before this VM hands it
//! the host's proof key.
//!
//!   1. the chain links leaf -> ... -> a self-signed root whose SHA-256 is one of Google's attestation roots (pinned here, as
//!      the relay pins them); every signature verifies under its issuer's key (never SHA-1); every cert above the leaf is a CA;
//!   2. the leaf's AVF extension (1.3.6.1.4.1.11129.2.1.29.1): the attestationChallenge equals ours, isVmSecure is true, and
//!      every APK component is signed by OUR authority and one of them carries OUR code hash (this VM's own, read from its own
//!      attestation: a sibling runs the identical build);
//!   3. validity dates are NOT checked: a VM's clock is the host's, and freshness is the challenge -- a nonce this VM chose for
//!      this one request and the requester's one-time key.
use sha2::{Digest, Sha256};
use x509_parser::prelude::*;

pub const AVF_EXTENSION_OID: &str = "1.3.6.1.4.1.11129.2.1.29.1";
/// Google's attestation roots, SHA-256 of the DER certificate (relay/avf-verify.mjs GOOGLE_ATTESTATION_ROOT_SHA256).
pub const GOOGLE_ROOTS: [&str; 2] = [
    "cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc",
    "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0",
];
const MAX_CERTS: usize = 8;
const MAX_CERT_BYTES: usize = 64 << 10;

/// What a verified leaf says.
#[derive(Debug, Clone, PartialEq)]
pub struct Attested {
    pub code_hash: Vec<u8>,
    pub authority_hash: Vec<u8>,
    pub is_vm_secure: bool,
    pub challenge: Vec<u8>,
}

#[derive(Debug)]
struct Component {
    name: String,
    code_hash: Vec<u8>,
    authority_hash: Vec<u8>,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---- a DER walker for the AVF structure (the relay's, ported) ----
fn tlv(b: &[u8], off: usize, limit: usize) -> Result<(u8, usize, usize), String> {
    if off + 2 > limit {
        return Err("truncated DER".into());
    }
    let tag = b[off];
    let mut len = b[off + 1] as usize;
    let mut hdr = 2;
    if len & 0x80 != 0 {
        let n = len & 0x7f;
        if n == 0 || n > 3 || off + 2 + n > limit {
            return Err("unsupported DER length".into());
        }
        len = 0;
        for i in 0..n {
            len = (len << 8) | b[off + 2 + i] as usize;
        }
        if len < 0x80 {
            return Err("non-minimal DER length".into());
        }
        hdr += n;
    }
    let body = off + hdr;
    if body + len > limit {
        return Err("DER value overruns".into());
    }
    Ok((tag, body, body + len))
}
fn children(b: &[u8], start: usize, end: usize, cap: usize) -> Result<Vec<(u8, usize, usize)>, String> {
    let mut out = Vec::new();
    let mut o = start;
    while o < end {
        let t = tlv(b, o, end)?;
        out.push(t);
        if out.len() > cap {
            return Err("too many DER children".into());
        }
        o = t.2;
    }
    Ok(out)
}

fn parse_extension(v: &[u8]) -> Result<(Vec<u8>, bool, Vec<Component>), String> {
    let (tag, s, e) = tlv(v, 0, v.len())?;
    if tag != 0x30 || e != v.len() {
        return Err("AttestationExtension is not an exact SEQUENCE".into());
    }
    let f = children(v, s, e, 4)?;
    // three fields, or four with an EMPTY trailing SEQUENCE (real Pixel 10 chains, test/fixtures/avf)
    if !(f.len() == 3 || (f.len() == 4 && f[3].0 == 0x30 && f[3].1 == f[3].2)) {
        return Err("AttestationExtension shape is not the known one".into());
    }
    let (chal, sec, comps) = (f[0], f[1], f[2]);
    if chal.0 != 0x04 || sec.0 != 0x01 || comps.0 != 0x30 || sec.2 - sec.1 != 1 {
        return Err("AttestationExtension fields malformed".into());
    }
    let secure = match v[sec.1] {
        0xff => true,
        0x00 => false,
        _ => return Err("non-DER BOOLEAN".into()),
    };
    let mut out = Vec::new();
    for c in children(v, comps.1, comps.2, 256)? {
        if c.0 != 0x30 {
            return Err("VmComponent is not a SEQUENCE".into());
        }
        let k = children(v, c.1, c.2, 4)?;
        if k.len() != 4 || k[0].0 != 0x0c || k[1].0 != 0x02 || k[2].0 != 0x04 || k[3].0 != 0x04 {
            return Err("VmComponent malformed".into());
        }
        let name = std::str::from_utf8(&v[k[0].1..k[0].2]).map_err(|_| "component name is not UTF-8".to_string())?;
        if name.is_empty() || name.len() > 1024 || name.chars().any(|ch| ch.is_control()) {
            return Err("invalid component name".into());
        }
        out.push(Component { name: name.to_string(), code_hash: v[k[2].1..k[2].2].to_vec(), authority_hash: v[k[3].1..k[3].2].to_vec() });
    }
    Ok((v[chal.1..chal.2].to_vec(), secure, out))
}

/// The leaf's AVF extension, read (no chain check): for this VM's OWN attestation, to learn its code and authority hashes.
pub fn read_leaf(leaf_der: &[u8]) -> Result<Attested, String> {
    let (_, cert) = X509Certificate::from_der(leaf_der).map_err(|e| format!("leaf: {e}"))?;
    let ext = cert
        .extensions()
        .iter()
        .find(|x| x.oid.to_id_string() == AVF_EXTENSION_OID)
        .ok_or("the leaf carries no AVF attestation extension")?;
    let (challenge, is_vm_secure, comps) = parse_extension(ext.value)?;
    let apk = comps.iter().find(|c| c.name.to_ascii_lowercase().contains("apk")).ok_or("no APK component")?;
    Ok(Attested { code_hash: apk.code_hash.clone(), authority_hash: apk.authority_hash.clone(), is_vm_secure, challenge })
}

/// Verify a sibling's chain (DER certificates, any order) for `challenge`, against this VM's own code and authority hashes.
/// `roots`: the pinned root fingerprints (GOOGLE_ROOTS in production; a test CA's in tests).
pub fn verify_sibling(chain: &[Vec<u8>], challenge: &[u8], code_hash: &[u8], authority_hash: &[u8], roots: &[[u8; 32]]) -> Result<Attested, String> {
    if chain.len() < 2 || chain.len() > MAX_CERTS {
        return Err(format!("the chain has {} certificates", chain.len()));
    }
    if chain.iter().any(|c| c.len() > MAX_CERT_BYTES) {
        return Err("a certificate exceeds the size limit".into());
    }
    let certs: Vec<X509Certificate> = chain
        .iter()
        .map(|d| X509Certificate::from_der(d).map(|(_, c)| c).map_err(|e| format!("unparseable certificate: {e}")))
        .collect::<Result<_, _>>()?;
    // order: the leaf is the one that issued nothing; then follow issuers (by name and signature)
    let issued_by = |c: &X509Certificate, i: &X509Certificate| c.issuer() == i.subject() && c.verify_signature(Some(i.public_key())).is_ok();
    let leaves: Vec<usize> = (0..certs.len()).filter(|&i| !(0..certs.len()).any(|j| j != i && issued_by(&certs[j], &certs[i]))).collect();
    if leaves.len() != 1 {
        return Err(format!("the chain has {} leaves", leaves.len()));
    }
    let mut order = vec![leaves[0]];
    while order.len() < certs.len() {
        let cur = *order.last().unwrap();
        match (0..certs.len()).find(|&j| j != cur && !order.contains(&j) && issued_by(&certs[cur], &certs[j])) {
            Some(j) => order.push(j),
            None => break,
        }
    }
    if order.len() != certs.len() {
        return Err("the chain does not link up".into());
    }
    // 1. a pinned, self-signed root
    let root = &certs[*order.last().unwrap()];
    let fp: [u8; 32] = Sha256::digest(&chain[*order.last().unwrap()]).into();
    if !roots.contains(&fp) {
        return Err(format!("root {} is not a pinned Google attestation root", hex(&fp)));
    }
    if root.issuer() != root.subject() || root.verify_signature(None).is_err() {
        return Err("the root is not self-signed".into());
    }
    // every link: no SHA-1, a valid signature (checked by issued_by), a CA above the leaf
    for (n, &i) in order.iter().enumerate() {
        let alg = certs[i].signature_algorithm.algorithm.to_id_string();
        if alg == "1.2.840.113549.1.1.5" || alg == "1.2.840.10045.4.1" {
            return Err(format!("certificate {n} is signed with SHA-1"));
        }
        if n > 0 {
            let ca = certs[i].basic_constraints().ok().flatten().map(|b| b.value.ca).unwrap_or(false);
            if !ca {
                return Err(format!("certificate {n} is not a CA"));
            }
        }
    }
    // 2. the leaf: our challenge, a secure VM, our build signed by our authority
    let leaf_der = &chain[order[0]];
    let (_, leaf) = X509Certificate::from_der(leaf_der).map_err(|e| e.to_string())?;
    let ext = leaf.extensions().iter().find(|x| x.oid.to_id_string() == AVF_EXTENSION_OID).ok_or("the leaf carries no AVF attestation extension")?;
    let (got_challenge, secure, comps) = parse_extension(ext.value)?;
    if got_challenge != challenge {
        return Err("the attestationChallenge is not ours".into());
    }
    if !secure {
        return Err("isVmSecure=false: a DICE link is debuggable or unverified".into());
    }
    let apks: Vec<&Component> = comps.iter().filter(|c| c.name.to_ascii_lowercase().contains("apk")).collect();
    if apks.is_empty() {
        return Err("no APK component".into());
    }
    if let Some(s) = apks.iter().find(|c| c.authority_hash != authority_hash) {
        return Err(format!("APK component {:?} is signed by another authority", s.name));
    }
    let anchor = apks.iter().find(|c| c.code_hash == code_hash).ok_or("no APK component carries this VM's own code hash: another build")?;
    Ok(Attested { code_hash: anchor.code_hash.clone(), authority_hash: anchor.authority_hash.clone(), is_vm_secure: secure, challenge: got_challenge })
}

/// The pinned Google roots as bytes.
pub fn google_roots() -> Vec<[u8; 32]> {
    GOOGLE_ROOTS
        .iter()
        .map(|h| {
            let mut o = [0u8; 32];
            for i in 0..32 {
                o[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).expect("pinned hex");
            }
            o
        })
        .collect()
}

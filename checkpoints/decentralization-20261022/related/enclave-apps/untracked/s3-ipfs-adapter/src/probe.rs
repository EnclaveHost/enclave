//! The trustless-gateway DEDICATED PROBE PATH (specs.ipfs.tech/http-gateways/trustless-gateway, "Dedicated Probe
//! Paths"): `GET|HEAD /ipfs/bafkqaaa`, the identity CID of the empty block. For a block request (`?format=raw` or
//! `Accept: application/vnd.ipld.raw`) it MUST answer 200 with an empty body; for a CAR request, 200 and a CAR whose
//! header `roots` is `bafkqaaa` (the identity block MAY be skipped).
//!
//! This is what makes the advertised HTTP provider usable at all: boxo's HTTP retrieval (bitswap/network/httpnet, used
//! by Rainbow - ipfs.io, dweb.link, trustless-gateway.link - and by Kubo's `HTTPRetrieval`) "connects" to a provider by
//! sending exactly `HEAD /ipfs/bafkqaaa?format=raw` with `Accept: application/vnd.ipld.raw` (then GET), and only an
//! endpoint answering 200/204 is ever sent a block request. Without this the adapter answers 400 (the CID is not one it
//! mints), the client puts the host in cooldown, and the site's only HTTP provider is never used.
//!
//! Dependency-free and pure, so it is unit-tested on its own (`rustc --test src/probe.rs`).

/// The identity empty CID, as the probe names it.
pub const PROBE_CID: &str = "bafkqaaa";
/// Its binary form: CIDv1, raw (0x55), identity multihash (0x00), digest length 0.
pub const PROBE_CID_BYTES: [u8; 4] = [0x01, 0x55, 0x00, 0x00];

pub struct ProbeAnswer {
    pub status: u16,
    pub reason: &'static str,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

/// The answer for `/ipfs/<cid>[/<subpath>]` when `<cid>` is the probe CID; `None` for every other CID (the normal
/// gateway path handles it, unchanged). `format` is the `?format=` value, `accept` the Accept header.
pub fn probe_answer(cid: &str, subpath: &str, format: Option<&str>, accept: &str) -> Option<ProbeAnswer> {
    if cid != PROBE_CID {
        return None;
    }
    if !subpath.trim_matches('/').is_empty() {
        // the empty raw block has no links: any path below it is absent
        return Some(ProbeAnswer { status: 404, reason: "Not Found", content_type: "application/json", body: b"{\"error\":\"no such path\"}".to_vec() });
    }
    let car = match format {
        Some("car") => true,
        Some(_) => false,
        None => accept.contains("application/vnd.ipld.car") && !accept.contains("application/vnd.ipld.raw"),
    };
    if car {
        return Some(ProbeAnswer { status: 200, reason: "OK", content_type: "application/vnd.ipld.car; version=1", body: car_header_probe() });
    }
    let raw = matches!(format, Some("raw")) || (format.is_none() && accept.contains("application/vnd.ipld.raw"));
    // a raw block request: the empty block; a web request: the empty file the same block is
    Some(ProbeAnswer { status: 200, reason: "OK", content_type: if raw { "application/vnd.ipld.raw" } else { "application/octet-stream" }, body: Vec::new() })
}

/// CARv1 header with `roots: [bafkqaaa]`: varint length + dag-cbor {"roots": [tag42(0x00 ‖ cid)], "version": 1},
/// canonically ordered keys (the same encoding as ipfs::car_header, for the identity CID). No block section.
pub fn car_header_probe() -> Vec<u8> {
    let mut cbor = vec![0xa2, 0x65];
    cbor.extend_from_slice(b"roots");
    cbor.extend_from_slice(&[0x81, 0xd8, 0x2a, 0x45, 0x00]);  // array(1), tag(42), bytes(5), multibase identity prefix
    cbor.extend_from_slice(&PROBE_CID_BYTES);
    cbor.push(0x67);
    cbor.extend_from_slice(b"version");
    cbor.push(0x01);
    let mut out = vec![cbor.len() as u8];                     // < 0x80: a one-byte varint
    out.extend_from_slice(&cbor);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The base32 multibase form of the binary CID is the probe string boxo sends.
    #[test]
    fn probe_cid_text_is_the_identity_empty_cid() {
        const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
        let mut bits = 0u32;
        let mut n = 0u32;
        let mut s = String::from("b");
        for &b in &PROBE_CID_BYTES {
            bits = (bits << 8) | b as u32;
            n += 8;
            while n >= 5 { n -= 5; s.push(ALPHABET[((bits >> n) & 31) as usize] as char); }
        }
        if n > 0 { s.push(ALPHABET[((bits << (5 - n)) & 31) as usize] as char); }
        assert_eq!(s, PROBE_CID);
    }

    /// boxo httpnet connectToURL: `HEAD|GET /ipfs/bafkqaaa?format=raw`, `Accept: application/vnd.ipld.raw` -> 200, empty.
    #[test]
    fn the_exact_boxo_probe_gets_200_and_an_empty_raw_block() {
        for format in [Some("raw"), None] {
            let a = probe_answer("bafkqaaa", "", format, "application/vnd.ipld.raw").unwrap();
            assert_eq!((a.status, a.content_type, a.body.len()), (200, "application/vnd.ipld.raw", 0), "{format:?}");
        }
    }

    #[test]
    fn a_car_probe_is_a_header_rooted_at_bafkqaaa() {
        for (format, accept) in [(Some("car"), ""), (None, "application/vnd.ipld.car")] {
            let a = probe_answer("bafkqaaa", "", format, accept).unwrap();
            assert_eq!((a.status, a.content_type), (200, "application/vnd.ipld.car; version=1"));
            // varint(len) + {"roots":[tag42(00 01 55 00 00)],"version":1}
            let mut want = vec![0xa2, 0x65, b'r', b'o', b'o', b't', b's', 0x81, 0xd8, 0x2a, 0x45, 0x00, 0x01, 0x55, 0x00, 0x00,
                                0x67, b'v', b'e', b'r', b's', b'i', b'o', b'n', 0x01];
            want.insert(0, want.len() as u8);
            assert_eq!(a.body, want);
        }
    }

    #[test]
    fn a_web_request_is_the_empty_file_and_a_path_below_it_is_absent() {
        let a = probe_answer("bafkqaaa", "", None, "text/html").unwrap();
        assert_eq!((a.status, a.body.len()), (200, 0));
        assert_eq!(probe_answer("bafkqaaa", "index.html", Some("raw"), "").unwrap().status, 404);
        assert_eq!(probe_answer("bafkqaaa", "/", Some("raw"), "").unwrap().status, 200);
    }

    /// Every other CID - including other identity CIDs, which the spec lets a gateway refuse - is left to the
    /// gateway's normal path, byte for byte as before.
    #[test]
    fn every_other_cid_is_untouched() {
        for cid in ["bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou", "bafkqaaaa", "bafkqabqa", "BAFKQAAA", "", "bafkqaa"] {
            assert!(probe_answer(cid, "", Some("raw"), "application/vnd.ipld.raw").is_none(), "{cid}");
        }
    }
}

//! `witness-check --chain-id <id> --signer <address>`: a local, offline verifier for an execution-witness gateway.
//!
//! One JSON request per stdin line, one JSON answer per stdout line, in order. No network access, no state beyond the
//! pinned signer and chain id; every check is `helios_opstack::witness_check` (Helios's own verification):
//!
//!   {"id":1,"op":"head","commitment":{"data":"0x..","signature":{..}}}
//!       -> {"id":1,"ok":true,"blockHash":..,"parentHash":..,"number":..,"timestamp":..,"stateRoot":..}
//!   {"id":2,"op":"getProof","blockHash":..,"stateRoot":..,"params":[address,[keys],blockHash],"result":{..}}
//!       -> {"id":2,"ok":true,"address":..,"codeHash":..}
//!   {"id":3,"op":"getCode","blockHash":..,"stateRoot":..,"params":[address,blockHash],"result":"0x..","account":{..}}
//!       -> {"id":3,"ok":true}
//!   {"id":4,"op":"exportHeader","commitment":{..}}  or  {"id":4,"op":"exportHeader","object":"0x<snappy gossip object>"}
//!       -> {"id":4,"ok":true,"head":{verified head},"header":{canonical RPC header},"commitment":{..}}
//!       (with "synthetic":true: TEST FIXTURES ONLY, the rebuilt header even if it does not hash to the signed block
//!       hash, plus "signedBlockHash" and "signedHashMatches"; the gateway never sends this)
//!   {"id":5,"op":"header","header":{untrusted header JSON},"expectHash":"0x..","child":{"number","timestamp","parentHash"}|null}
//!       -> {"id":5,"ok":true,"blockHash":..,"parentHash":..,"number":..,"timestamp":..,"stateRoot":..}
//!   any failure -> {"id":..,"ok":false,"error":"..."}
//!
//! A line longer than MAX_LINE bytes is answered with an error (id null) and skipped without being buffered.
use std::io::{BufRead, Write};

use alloy::primitives::{Address, B256};
use clap::Parser;
use eyre::{eyre, Result};
use serde_json::{json, Value};

use helios_opstack::witness_check::{
    canonical_head, rebuild_header, verify_get_code, verify_get_proof, verify_head, verify_header,
    Child,
};
use helios_opstack::SequencerCommitment;

const MAX_LINE: usize = 48 << 20;
const MAX_OBJECT: usize = 16 << 20;

#[derive(Parser)]
struct Cli {
    #[clap(long)]
    chain_id: u64,
    #[clap(long)]
    signer: Address,
}

fn field<T: serde::de::DeserializeOwned>(req: &Value, name: &str) -> Result<T> {
    serde_json::from_value(
        req.get(name)
            .cloned()
            .ok_or_else(|| eyre!("missing {name}"))?,
    )
    .map_err(|e| eyre!("invalid {name}: {e}"))
}

fn answer(cli: &Cli, req: &Value) -> Result<Value> {
    let params = || -> Result<Vec<Value>> { field(req, "params") };
    let result = || {
        req.get("result")
            .cloned()
            .ok_or_else(|| eyre!("missing result"))
    };
    match req.get("op").and_then(Value::as_str) {
        Some("head") => {
            let commitment: SequencerCommitment = field(req, "commitment")?;
            Ok(serde_json::to_value(verify_head(
                &commitment,
                cli.signer,
                cli.chain_id,
            )?)?)
        }
        Some("getProof") => {
            let (root, hash): (B256, B256) = (field(req, "stateRoot")?, field(req, "blockHash")?);
            let proof = verify_get_proof(root, hash, &params()?, &result()?)?;
            Ok(json!({ "address": proof.address, "codeHash": proof.code_hash }))
        }
        Some("getCode") => {
            let (root, hash): (B256, B256) = (field(req, "stateRoot")?, field(req, "blockHash")?);
            let account = req
                .get("account")
                .cloned()
                .ok_or_else(|| eyre!("missing account"))?;
            verify_get_code(root, hash, &params()?, &result()?, &account)?;
            Ok(json!({}))
        }
        Some("exportHeader") => {
            let commitment: SequencerCommitment = match req.get("object") {
                // a raw gossip object (snappy, as B's listener stores it): the declared decompressed size is
                // checked before anything is allocated (Base's MAX_DECOMPRESSED_ENVELOPE_BYTES is the same idea)
                Some(_) => {
                    let object: alloy::primitives::Bytes = field(req, "object")?;
                    if snap::raw::decompress_len(&object)? > MAX_OBJECT {
                        return Err(eyre!("gossip object too large"));
                    }
                    SequencerCommitment::new(&object)?
                }
                None => field(req, "commitment")?,
            };
            if req.get("synthetic") == Some(&Value::Bool(true)) {
                // TEST FIXTURES ONLY: report the rebuilt header and whether it hashes to the signed block hash
                let (head, header, signed) = rebuild_header(&commitment, cli.signer, cli.chain_id)?;
                let matches = header.hash == signed;
                return Ok(
                    json!({ "head": head, "header": header, "commitment": commitment, "synthetic": true,
                    "signedBlockHash": signed, "signedHashMatches": matches }),
                );
            }
            let (head, header) = canonical_head(&commitment, cli.signer, cli.chain_id)?;
            Ok(json!({ "head": head, "header": header, "commitment": commitment }))
        }
        Some("header") => {
            let header = req
                .get("header")
                .cloned()
                .ok_or_else(|| eyre!("missing header"))?;
            let child: Option<Child> = field(req, "child")?;
            Ok(serde_json::to_value(verify_header(
                &header,
                field(req, "expectHash")?,
                child,
                cli.chain_id,
            )?)?)
        }
        Some("version") => Ok(
            json!({ "version": env!("CARGO_PKG_VERSION"), "chainId": cli.chain_id, "signer": cli.signer }),
        ),
        _ => Err(eyre!("unknown op")),
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut out = std::io::stdout().lock();
    let mut line = Vec::new();
    loop {
        line.clear();
        let mut overflow = false;
        // bounded line read: never buffer more than MAX_LINE bytes of one request
        loop {
            let buf = input.fill_buf()?;
            if buf.is_empty() {
                if line.is_empty() && !overflow {
                    return Ok(());
                }
                break;
            }
            let (chunk, done) = match buf.iter().position(|b| *b == b'\n') {
                Some(i) => (&buf[..i], i + 1),
                None => (buf, buf.len()),
            };
            if !overflow && line.len() + chunk.len() <= MAX_LINE {
                line.extend_from_slice(chunk);
            } else {
                overflow = true;
                line.clear();
            }
            let newline = done > chunk.len();
            input.consume(done);
            if newline {
                break;
            }
        }
        let reply = if overflow {
            json!({ "id": null, "ok": false, "error": "request line too long" })
        } else if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        } else {
            match serde_json::from_slice::<Value>(&line) {
                Err(e) => json!({ "id": null, "ok": false, "error": format!("parse error: {e}") }),
                Ok(req) => {
                    let id = req.get("id").cloned().unwrap_or(Value::Null);
                    match answer(&cli, &req) {
                        Ok(Value::Object(mut m)) => {
                            m.insert("id".into(), id);
                            m.insert("ok".into(), Value::Bool(true));
                            Value::Object(m)
                        }
                        Ok(_) => unreachable!("answers are objects"),
                        Err(e) => {
                            json!({ "id": id, "ok": false, "error": format!("{e:#}").chars().take(300).collect::<String>() })
                        }
                    }
                }
            }
        };
        serde_json::to_writer(&mut out, &reply)?;
        out.write_all(b"\n")?;
        out.flush()?;
    }
}

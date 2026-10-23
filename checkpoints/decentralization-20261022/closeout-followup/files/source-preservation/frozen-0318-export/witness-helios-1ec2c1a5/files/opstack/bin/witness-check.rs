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
//!   any failure -> {"id":..,"ok":false,"error":"..."}
//!
//! A line longer than MAX_LINE bytes is answered with an error (id null) and skipped without being buffered.
use std::io::{BufRead, Write};

use alloy::primitives::{Address, B256};
use clap::Parser;
use eyre::{eyre, Result};
use serde_json::{json, Value};

use helios_opstack::witness_check::{verify_get_code, verify_get_proof, verify_head};
use helios_opstack::SequencerCommitment;

const MAX_LINE: usize = 48 << 20;

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

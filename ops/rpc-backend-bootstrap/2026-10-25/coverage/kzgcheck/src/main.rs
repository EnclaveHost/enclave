//! Recomputes L1 commitments with the exact crates base v1.5.1 pins (c-kzg 2.1.8, alloy 2.4.1).
//!
//! `kzgcheck [blob]`: each stdin line is one 0x-prefixed EIP-4844 blob (131072 bytes, hex); each stdout
//! line is `OK 0x<48-byte commitment>` or `ERR <reason>`. Uses c-kzg's embedded mainnet trusted setup.
//!
//! `kzgcheck block`: each stdin line is `{"block": <eth_getBlockByNumber(n, true)>, "receipts":
//! <eth_getBlockReceipts(n)>}`; each stdout line is `OK {"hash", "transactionsRoot", "receiptsRoot",
//! "txHashes"}` computed from the consensus encodings (keccak header hash, 2718 trie roots), or `ERR <reason>`.
//! The caller compares these with the values the RPC claimed.
//!
//! Input is bounded per line; an over-long line is consumed and reported, never buffered whole.

use std::io::{self, BufRead, Read, Write};

use alloy_consensus::{
    proofs::{calculate_receipt_root, calculate_transaction_root},
    TxEnvelope,
};
use alloy_rpc_types_eth::{Block, BlockTransactions, Transaction, TransactionReceipt};
use c_kzg::{ethereum_kzg_settings, Blob, BYTES_PER_BLOB};

const BLOB_LINE_LEN: usize = 2 + 2 * BYTES_PER_BLOB;
const BLOCK_LINE_MAX: usize = 64 << 20;

fn commit(line: &[u8]) -> Result<String, String> {
    if line.len() != BLOB_LINE_LEN || !line.starts_with(b"0x") {
        return Err(format!("blob line must be 0x + {} hex chars", 2 * BYTES_PER_BLOB));
    }
    let bytes = hex::decode(&line[2..]).map_err(|e| format!("hex: {e}"))?;
    let blob = Blob::from_bytes(&bytes).map_err(|e| format!("blob: {e:?}"))?;
    let commitment = ethereum_kzg_settings(0)
        .blob_to_kzg_commitment(&blob)
        .map_err(|e| format!("kzg: {e:?}"))?;
    Ok(format!("0x{}", hex::encode(commitment.to_bytes().into_inner())))
}

#[derive(serde::Deserialize)]
struct BlockItem {
    block: Block<Transaction>,
    receipts: Vec<TransactionReceipt>,
}

fn block_roots(line: &[u8]) -> Result<String, String> {
    let item: BlockItem = serde_json::from_slice(line).map_err(|e| format!("json: {e}"))?;
    let header = item.block.header;
    let txs: Vec<TxEnvelope> = match item.block.transactions {
        BlockTransactions::Full(txs) => txs.into_iter().map(|t| t.into_inner()).collect(),
        BlockTransactions::Hashes(h) if h.is_empty() => Vec::new(),
        _ => return Err("block must carry full transaction objects".into()),
    };
    let tx_hashes: Vec<_> = txs.iter().map(|t| *t.tx_hash()).collect();
    let receipts: Vec<_> =
        item.receipts.into_iter().map(|r| r.into_primitives_receipt().inner).collect();
    let out = serde_json::json!({
        "hash": header.inner.hash_slow(),
        "transactionsRoot": calculate_transaction_root(&txs),
        "receiptsRoot": calculate_receipt_root(&receipts),
        "txHashes": tx_hashes,
    });
    Ok(out.to_string())
}

fn serve(max: usize, f: fn(&[u8]) -> Result<String, String>) -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = (&mut input).take(max as u64 + 1).read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
        } else if n > max {
            // Discard the rest of the over-long line without holding it.
            let mut sink = Vec::new();
            loop {
                sink.clear();
                let m = (&mut input).take(1 << 16).read_until(b'\n', &mut sink)?;
                if m == 0 || sink.last() == Some(&b'\n') {
                    break;
                }
            }
            writeln!(out, "ERR line too long")?;
            out.flush()?;
            continue;
        }
        match f(&buf) {
            Ok(v) => writeln!(out, "OK {v}")?,
            Err(e) => writeln!(out, "ERR {}", e.replace('\n', " "))?,
        }
        out.flush()?;
    }
    Ok(())
}

fn main() -> io::Result<()> {
    match std::env::args().nth(1).as_deref() {
        None | Some("blob") => serve(BLOB_LINE_LEN, commit),
        Some("block") => serve(BLOCK_LINE_MAX, block_roots),
        Some(other) => {
            eprintln!("unknown mode {other}; use blob|block");
            std::process::exit(2)
        }
    }
}

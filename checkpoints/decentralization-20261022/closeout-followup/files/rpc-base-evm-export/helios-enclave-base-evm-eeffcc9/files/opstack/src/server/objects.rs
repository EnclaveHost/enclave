//! Commitment source: a directory of write-once Base v4 gossip envelopes, `<sha256>.v4.snappy`, written by an external
//! listener built on the maintained base/base `base-consensus-gossip` crate (enclave-base-unsafe-head/v1; rpc-peer-audit
//! head-listener). Each file is `snappy(signature(65) || parentBeaconRoot(32) || SSZ payload)`, exactly what
//! `SequencerCommitment::new` decodes from gossip. Files are untrusted: the name must be the content's sha256, and the
//! commitment must recover to the pinned signer for the pinned chain, or the file is skipped.
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use alloy::primitives::Address;
use eyre::{bail, Result};
use sha2::{Digest, Sha256};
use tokio::{sync::mpsc::Sender, time::sleep};
use tracing::warn;

use crate::SequencerCommitment;

const SUFFIX: &str = ".v4.snappy";
const MAX_OBJECT_BYTES: u64 = 4 * 1024 * 1024;

/// Read and verify one object file.
pub fn read_object(path: &Path, signer: Address, chain_id: u64) -> Result<SequencerCommitment> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_suffix(SUFFIX))
        .ok_or_else(|| eyre::eyre!("not a {SUFFIX} object"))?;
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.len() > MAX_OBJECT_BYTES {
        bail!("object is not a regular file of at most {MAX_OBJECT_BYTES} bytes");
    }
    let bytes = std::fs::read(path)?;
    if hex::encode(Sha256::digest(&bytes)) != name {
        bail!("object name is not its content sha256");
    }
    let commitment = SequencerCommitment::new(&bytes)?;
    commitment.verify(signer, chain_id)?;
    Ok(commitment)
}

/// Poll `dir` for new objects and send every verified commitment (each file at most once).
pub fn start(dir: PathBuf, signer: Address, chain_id: u64, sender: Sender<SequencerCommitment>) {
    tokio::spawn(async move {
        let mut seen = HashSet::new();
        loop {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_owned)
                    else {
                        continue;
                    };
                    if !name.ends_with(SUFFIX) || !seen.insert(name.clone()) {
                        continue;
                    }
                    match read_object(&path, signer, chain_id) {
                        Ok(commitment) => {
                            if sender.send(commitment).await.is_err() {
                                return;
                            }
                        }
                        Err(e) => warn!(target: "helios::opstack", "skipped object {name}: {e}"),
                    }
                }
            }
            sleep(Duration::from_millis(250)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::{address, b256};

    use crate::types::ExecutionPayload;

    // A REAL Base mainnet unsafe-block gossip object (block 52965074), captured 2026-10-23 by the rpc-peer-audit
    // head-listener (base-consensus-gossip @ base/base 5476069f) and accepted there by BlockHandler::block_valid.
    const OBJECT: &str = "ec197b9f01acd9b93c900014b5b16142183fc77b559e0e0a727687d171e3e467.v4.snappy";
    const BASE_SIGNER: Address = address!("Af6E19BE0F9cE7f8afd49a1824851023A8249e8a");

    fn data() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data")
    }

    #[test]
    fn a_real_base_gossip_object_verifies_against_the_base_signer() {
        let commitment = read_object(&data().join(OBJECT), BASE_SIGNER, 8453).expect("verifies");
        let payload = ExecutionPayload::try_from(&commitment).expect("V4 payload decodes");
        assert_eq!(payload.block_number, 52965074);
        assert_eq!(payload.block_hash, b256!("39aa5527e39d83183030676fd86b70a2ce3fa9d0896e7cfbe19a272d80e9e172"));
        assert_eq!(payload.state_root, b256!("c42be07080537d7551a617343a34317e95923c32e1f160dbd66f36df5c46efd6"));
        assert_eq!(payload.timestamp, 1792719495);
    }

    #[test]
    fn wrong_signer_chain_name_or_bytes_are_refused() {
        let real = data().join(OBJECT);
        assert!(read_object(&real, Address::repeat_byte(0x11), 8453).is_err(), "wrong signer");
        assert!(read_object(&real, BASE_SIGNER, 10).is_err(), "wrong chain");
        let dir = std::env::temp_dir().join(format!("objects-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = std::fs::read(&real).unwrap();
        let misnamed = dir.join(format!("{}{SUFFIX}", "00".repeat(32)));
        std::fs::write(&misnamed, &bytes).unwrap();
        assert!(read_object(&misnamed, BASE_SIGNER, 8453).is_err(), "name is not the content hash");
        let mut flipped = bytes.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 1;
        let renamed = dir.join(format!("{}{SUFFIX}", hex::encode(Sha256::digest(&flipped))));
        std::fs::write(&renamed, &flipped).unwrap();
        assert!(read_object(&renamed, BASE_SIGNER, 8453).is_err(), "tampered object, correctly renamed");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

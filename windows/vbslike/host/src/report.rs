//! The document the Windows launcher signs for a partition, and the key that signs it. PORTABLE in
//! shape: `reportData` is exactly the 64 bytes isolation/contract defines (bind || app ID), built by
//! the monitor INSIDE the partition from its own table; this launcher only vouches that it loaded that
//! app ID into that partition, and signs. On SEV-SNP the PSP plays this role and its signature covers
//! the launch measurement; here the launcher's Ed25519 key does, and the document says which image
//! and kernel it launched. A verifier that trusts this key learns which app, which key and which nonce,
//! and nothing about the host: README.md states the trust.
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

pub use crate::contract::{FORMAT_HYPERV as FORMAT, TIER_HYPERV as TIER};
pub const SIGN_DOMAIN: &[u8] = b"vbslike-report-v1\n";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Platform {
    pub os: String,
    pub hypervisor: String,
    pub partition: String, // "hcs-child-partition"
    pub isolation: String, // what the HCS document asked for
    #[serde(rename = "hostExcluded")]
    pub host_excluded: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LauncherId {
    pub key: String, // base64 Ed25519 public key (32 bytes)
    #[serde(rename = "startedMs")]
    pub started_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PartitionId {
    #[serde(rename = "vmId")]
    pub vm_id: String,
    #[serde(rename = "guestImageSha256")]
    pub guest_image_sha256: String,
    /// The host-supplied kernel, on a path where the host supplies one. OMITTED on the UEFI path:
    /// there the guest boots from a medium and no kernel file is handed in, so filling this would
    /// state an identity the boot never used (enclave-99's UEFI review).
    #[serde(rename = "kernelSha256", skip_serializing_if = "String::is_empty", default)]
    pub kernel_sha256: String,
    pub vcpus: u64,
    #[serde(rename = "memMiB")]
    pub mem_mib: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DomainId {
    pub label: String,
    #[serde(rename = "appSha256")]
    pub app_sha256: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReportDoc {
    pub format: String,
    pub tier: String,
    pub platform: Platform,
    pub launcher: LauncherId,
    pub partition: PartitionId,
    pub domain: DomainId,
    #[serde(rename = "reportData")]
    pub report_data: String, // hex(64)
    pub boundary: String,
    #[serde(rename = "issuedMs")]
    pub issued_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SignedReport {
    pub doc: ReportDoc,
    pub sig: String, // base64 Ed25519 over SIGN_DOMAIN || canonical(doc)
}

pub struct LauncherKey {
    sk: SigningKey,
    pub started_ms: u64,
}

impl LauncherKey {
    pub fn mint() -> LauncherKey {
        LauncherKey { sk: SigningKey::generate(&mut rand_core::OsRng), started_ms: crate::util::unix_ms() }
    }
    pub fn public_b64(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(self.sk.verifying_key().as_bytes())
    }
    pub fn sign(&self, doc: &ReportDoc) -> SignedReport {
        let bytes = crate::contract::canonical(doc);
        let sig = self.sk.sign(&[SIGN_DOMAIN, &bytes].concat());
        SignedReport { doc: doc.clone(), sig: base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()) }
    }
}

#[allow(dead_code)]
pub fn verify(pub_b64: &str, r: &SignedReport) -> bool {
    let Ok(pk) = base64::engine::general_purpose::STANDARD.decode(pub_b64) else { return false };
    let Ok(pk) = <[u8; 32]>::try_from(pk.as_slice()) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    let Ok(sig) = base64::engine::general_purpose::STANDARD.decode(&r.sig) else { return false };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig) else { return false };
    vk.verify(&[SIGN_DOMAIN, &crate::contract::canonical(&r.doc)].concat(), &sig).is_ok()
}

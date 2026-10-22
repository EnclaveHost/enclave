//! Writer fencing (work/storage-writer-fencing-proposal.md; wire contract work/storage-fencing-implementation-interface.txt
//! v3): which instance may write, and how it proves it at every indexer.
//!
//! Every process draws a fresh 16-byte instance id. Its ballot is `gen || counter || iid`, where:
//!   - gen comes from the WRITER AUTHORITY fact the release delivered (the lease it was released under, or the owner's
//!     cold recovery), never from the instance itself;
//!   - counter is one above any installed fence of the same gen.
//! The ballot is installed on each listed indexer before that indexer is read. Every mutation carries the token and
//! the indexer's receipt (the SDK adds them), and the indexer applies a mutation only if both equal what it holds.
//! Every answer to a client waits for a confirmation round, started after the request arrived, that sees our fence on
//! W voters.
//!
//! What this assumes, and refuses without (fail closed):
//!   - A1 indexers are fail-stop and enforce the fence;
//!   - A2 a RUNNING instance cannot be duplicated with its memory (a clone holding our credential would be accepted as
//!     us). This is a property of the runtime, so `instanceIsolation` must name one. Runtimes with no recorded evidence
//!     are refused unless the operator explicitly accepts the risk.
//!     A clone made BEFORE our raise is caught: indexers issue a fresh receipt per install, and an equal token is never
//!     installed twice.
//!   - A3 the instance runs this code. A holder of the app key outside it has full authority over the data by design
//!     (that is the owner's authority, distinct from a host replaying or duplicating an instance).

use sia_storage::fence::FenceToken;

/// Generation layout: the authority source in the top 16 bits (below the sign bit), the source's value below.
pub const GEN_SHIFT: u32 = 48;
pub const GEN_LEASE16: u64 = 16;
pub const GEN_LEASE17: u64 = 17;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FenceMode {
    /// the pre-fencing single-writer behaviour: no fence, no `sf`, no confirmation. Exactly one writer is the
    /// operator's responsibility. An indexer that holds a fence refuses every unfenced mutation, so an unfenced
    /// instance stops rather than write a fenced account.
    Off,
    /// fenced (the default)
    Required,
}

/// Who may preempt the current writer: the fact the release delivered (interface v3 section 5).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Authority {
    /// rev 17 ledger: `leaseOf(id).generation` of the lease the secrets were released under
    Lease17 { chain_id: u64, ledger: String, deployment: String, generation: u64 },
    /// live rev 16 ledger: the finalized `Claimed` log of that lease
    Lease16 { chain_id: u64, ledger: String, deployment: String, claim_block: u64, claim_logenindex: u64 },
    /// the owner's cold recovery: the highest installed gen (preempts the current holder, never a later lease)
    OwnerCold,
}

impl Authority {
    /// The gen this authority fixes (None: owner cold recovery, decided from what is installed).
    pub fn fixed_gen(&self) -> Option<u64> {
        match self {
            Authority::Lease17 { generation, .. } => Some((GEN_LEASE17 << GEN_SHIFT) | generation),
            Authority::Lease16 { claim_block, claim_logenindex, .. } => Some((GEN_LEASE16 << GEN_SHIFT) | (claim_block << 16) | claim_logenindex),
            Authority::OwnerCold => None,
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Authority::Lease17 { chain_id, ledger, deployment, generation } => format!("lease17 chain {chain_id} ledger {ledger} deployment {deployment} generation {generation}"),
            Authority::Lease16 { chain_id, ledger, deployment, claim_block, claim_logenindex } => {
                format!("lease16 chain {chain_id} ledger {ledger} deployment {deployment} claim {claim_block}/{claim_logenindex}")
            }
            Authority::OwnerCold => "owner-cold".into(),
        }
    }

    /// Strict parse of the JSON fact. Unknown sources, missing or extra fields, and out-of-range values are refused.
    pub fn parse(v: &serde_json::Value) -> Result<Authority, String> {
        let o = v.as_object().ok_or("writerAuthority must be a JSON object")?;
        let src = o.get("source").and_then(|s| s.as_str()).ok_or("writerAuthority.source is required")?;
        let allowed: &[&str] = match src {
            "lease17" => &["source", "chainId", "ledger", "deployment", "generation"],
            "lease16" => &["source", "chainId", "ledger", "deployment", "claimBlock", "claimLogIndex"],
            "owner-cold" => &["source"],
            other => return Err(format!("writerAuthority.source {other:?} is not lease17, lease16 or owner-cold")),
        };
        if let Some(extra) = o.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(format!("writerAuthority has an unknown field {extra:?}"));
        }
        let u = |k: &str| o.get(k).and_then(|x| x.as_u64()).ok_or(format!("writerAuthority.{k} must be an unsigned integer"));
        let hexs = |k: &str, len: usize| -> Result<String, String> {
            let s = o.get(k).and_then(|x| x.as_str()).ok_or(format!("writerAuthority.{k} is required"))?;
            let h = s.strip_prefix("0x").ok_or(format!("writerAuthority.{k} must start with 0x"))?;
            if h.len() != len || !h.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err(format!("writerAuthority.{k} must be 0x and {len} hex digits"));
            }
            Ok(s.to_ascii_lowercase())
        };
        Ok(match src {
            "lease17" => {
                let generation = u("generation")?;
                if generation == 0 || generation >> GEN_SHIFT != 0 {
                    return Err("writerAuthority.generation must be in 1..2^48 (0 means never claimed)".into());
                }
                Authority::Lease17 { chain_id: u("chainId")?, ledger: hexs("ledger", 40)?, deployment: hexs("deployment", 64)?, generation }
            }
            "lease16" => {
                let (claim_block, claim_logenindex) = (u("claimBlock")?, u("claimLogIndex")?);
                if claim_block == 0 || claim_block >> 32 != 0 || claim_logenindex >> 16 != 0 {
                    return Err("writerAuthority.claimBlock must be in 1..2^32 and claimLogIndex below 2^16".into());
                }
                Authority::Lease16 { chain_id: u("chainId")?, ledger: hexs("ledger", 40)?, deployment: hexs("deployment", 64)?, claim_block, claim_logenindex }
            }
            _ => Authority::OwnerCold,
        })
    }
}

/// The runtime an instance runs in, for the no-clone assumption A2.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Isolation {
    Snp,
    Tdx,
    Vbs,
    /// an owner-run process (cold recovery): the owner asserts there is no duplicate
    OwnerProcess,
}

impl Isolation {
    pub fn parse(s: &str) -> Result<Isolation, String> {
        match s {
            "snp" => Ok(Isolation::Snp),
            "tdx" => Ok(Isolation::Tdx),
            "vbs" => Ok(Isolation::Vbs),
            "owner-process" => Ok(Isolation::OwnerProcess),
            other => Err(format!("instanceIsolation {other:?} is not snp, tdx, vbs or owner-process")),
        }
    }

    /// The recorded no-clone evidence for this runtime (None: none recorded). This is what this workspace has
    /// examined, not a property of the hardware in general.
    pub fn evidence(&self) -> Option<&'static str> {
        match self {
            Isolation::OwnerProcess => Some("owner assertion (owner authority): no duplicate process"),
            // VBS type 1: Save-VM was refused once (isolation/m3/VBS-ISOLATION.md, enclave-d1), which the repo itself
            // records as "not evidence of isolation"; the VBS report did not verify (E2: no report).
            Isolation::Vbs => None,
            // SNP / TDX: guest memory is encrypted per VM, but the host's save/restore, migration and snapshot paths
            // for these guests (and how guest randomness is seeded after one) have not been examined here.
            Isolation::Snp | Isolation::Tdx => None,
        }
    }
}

/// The fencing configuration and its fail-closed check.
#[derive(Clone, Debug)]
pub struct FencePolicy {
    pub mode: FenceMode,
    pub authority: Option<Authority>,
    pub isolation: Option<Isolation>,
    /// the operator accepts running on a runtime without recorded no-clone evidence (reported on /healthz)
    pub accept_unevidenced_isolation: bool,
}

impl Default for FencePolicy {
    fn default() -> Self {
        FencePolicy { mode: FenceMode::Required, authority: None, isolation: None, accept_unevidenced_isolation: false }
    }
}

impl FencePolicy {
    /// Ok(warnings) if a fenced instance may start, Err(reason) otherwise. Off mode always passes (and warns).
    pub fn check(&self) -> Result<Vec<String>, String> {
        if self.mode == FenceMode::Off {
            return Ok(vec!["UNFENCED: single-writer discipline required (writerFence off)".into()]);
        }
        let mut warn = Vec::new();
        let Some(auth) = &self.authority else {
            return Err("writer fencing needs a writerAuthority fact (lease17, lease16 or owner-cold); none was delivered".into());
        };
        let Some(iso) = self.isolation else {
            return Err("writer fencing needs instanceIsolation (snp, tdx, vbs or owner-process); none was delivered".into());
        };
        if matches!(auth, Authority::OwnerCold) != (iso == Isolation::OwnerProcess) {
            return Err("owner-cold authority goes with instanceIsolation owner-process, and only with it".into());
        }
        match iso.evidence() {
            Some(e) => warn.push(format!("isolation {iso:?}: {e}")),
            None if self.accept_unevidenced_isolation => {
                warn.push(format!("isolation risk accepted: no recorded no-clone evidence for {iso:?} (acceptUnevidencedIsolation)"))
            }
            None => {
                return Err(format!(
                    "instanceIsolation {iso:?} has no recorded no-clone evidence; refusing to run fenced (set acceptUnevidencedIsolation only with that evidence or an explicit risk decision)"
                ));
            }
        }
        Ok(warn)
    }
}

/// A fresh instance id for this process, from the runtime's randomness (WASI random in the guest; the OS natively).
pub fn fresh_iid() -> [u8; 16] {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("instance randomness");
    b
}

/// The ballot to raise: `gen` from the authority (owner cold: the highest installed gen), counter one above every
/// installed fence of that gen, and `floor_counter` (a re-ballot after a refusal) if higher. Err if an installed
/// fence has a HIGHER gen (a later lease holds it: this instance is stale and must not preempt).
pub fn choose_ballot(auth: &Authority, installed: &[FenceToken], iid: [u8; 16], floor_counter: u64) -> Result<FenceToken, String> {
    let top_gen = installed.iter().map(|t| t.generation()).max();
    let generation = match auth.fixed_gen() {
        Some(g) => {
            if let Some(t) = top_gen.filter(|t| *t > g) {
                return Err(format!("a fence of a later authority (gen {t:#x}) is installed; this instance (gen {g:#x}) is stale and does not preempt it"));
            }
            g
        }
        None => top_gen.unwrap_or(0),
    };
    let counter = installed.iter().filter(|t| t.generation() == generation).map(|t| t.counter() + 1).max().unwrap_or(1).max(floor_counter);
    FenceToken::new(generation, counter, iid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_facts_parse_strictly_and_order_lease17_above_lease16() {
        let a17 = Authority::parse(&serde_json::json!({"source":"lease17","chainId":8453,"ledger":format!("0x{}", "a".repeat(40)),"deployment":format!("0x{}", "b".repeat(64)),"generation":3})).unwrap();
        let a16 = Authority::parse(&serde_json::json!({"source":"lease16","chainId":8453,"ledger":format!("0x{}", "a".repeat(40)),"deployment":format!("0x{}", "b".repeat(64)),"claimBlock":40_000_000u64,"claimLogIndex":7})).unwrap();
        assert!(a17.fixed_gen().unwrap() > a16.fixed_gen().unwrap(), "a rev 17 lease outranks every rev 16 claim");
        assert!(Authority::parse(&serde_json::json!({"source":"lease17","chainId":1,"ledger":"0x00","deployment":"0x00","generation":1})).is_err());
        assert!(Authority::parse(&serde_json::json!({"source":"lease17","chainId":1,"ledger":format!("0x{}", "a".repeat(40)),"deployment":format!("0x{}", "b".repeat(64)),"generation":0})).is_err(), "generation 0 = never claimed");
        assert!(Authority::parse(&serde_json::json!({"source":"lease17","chainId":1,"ledger":format!("0x{}", "a".repeat(40)),"deployment":format!("0x{}", "b".repeat(64)),"generation":1u64 << 48})).is_err());
        assert!(Authority::parse(&serde_json::json!({"source":"owner-cold","generation":99})).is_err(), "no extra fields: an owner cannot name a gen");
        assert!(Authority::parse(&serde_json::json!({"source":"self"})).is_err());
        assert_eq!(Authority::parse(&serde_json::json!({"source":"owner-cold"})).unwrap(), Authority::OwnerCold);
    }

    #[test]
    fn the_policy_fails_closed() {
        let lease = Authority::Lease17 { chain_id: 1, ledger: "0x".into(), deployment: "0x".into(), generation: 1 };
        let p = |a: Option<Authority>, i: Option<Isolation>, acc: bool| FencePolicy { mode: FenceMode::Required, authority: a, isolation: i, accept_unevidenced_isolation: acc };
        assert!(p(None, Some(Isolation::OwnerProcess), false).check().is_err(), "no authority");
        assert!(p(Some(lease.clone()), None, false).check().is_err(), "no isolation");
        assert!(p(Some(lease.clone()), Some(Isolation::Snp), false).check().is_err(), "SNP without evidence");
        assert!(p(Some(lease.clone()), Some(Isolation::Vbs), false).check().is_err(), "VBS without evidence");
        assert!(p(Some(lease.clone()), Some(Isolation::Tdx), true).check().unwrap()[0].contains("risk accepted"));
        assert!(p(Some(lease.clone()), Some(Isolation::OwnerProcess), false).check().is_err(), "a lease instance is not an owner process");
        assert!(p(Some(Authority::OwnerCold), Some(Isolation::Snp), true).check().is_err(), "owner-cold only as an owner process");
        assert!(p(Some(Authority::OwnerCold), Some(Isolation::OwnerProcess), false).check().is_ok());
        let off = FencePolicy { mode: FenceMode::Off, ..FencePolicy::default() };
        assert!(off.check().unwrap()[0].starts_with("UNFENCED"));
    }

    #[test]
    fn ballots_never_preempt_a_later_lease_and_owner_cold_stays_in_the_installed_gen() {
        let iid = [7; 16];
        let lease = |g| Authority::Lease17 { chain_id: 1, ledger: "0x".into(), deployment: "0x".into(), generation: g };
        let g5 = (GEN_LEASE17 << GEN_SHIFT) | 5;
        let installed = [FenceToken::new(g5, 4, [1; 16]).unwrap(), FenceToken::new(g5, 9, [2; 16]).unwrap()];
        let b = choose_ballot(&lease(5), &installed, iid, 0).unwrap();
        assert_eq!((b.generation(), b.counter(), b.iid()), (g5, 10, iid));
        assert!(choose_ballot(&lease(4), &installed, iid, 0).is_err(), "an older lease never preempts");
        let b6 = choose_ballot(&lease(6), &installed, iid, 0).unwrap();
        assert_eq!((b6.generation(), b6.counter()), ((GEN_LEASE17 << GEN_SHIFT) | 6, 1));
        let cold = choose_ballot(&Authority::OwnerCold, &installed, iid, 0).unwrap();
        assert_eq!((cold.generation(), cold.counter()), (g5, 10), "owner cold: same gen, one above");
        assert!(cold < b6, "a later lease still preempts the owner's cold instance");
        assert_eq!(choose_ballot(&lease(5), &installed, iid, 12).unwrap().counter(), 12, "a re-ballot floor");
    }

    /// Cross-implementation vectors (indexd-fence R5 "indexd/fence/v3"). The first two are the Go side's own
    /// TestFenceHashVector (work/storage-real-indexd/indexd-fence/api/app/fence_test.go); all were also computed
    /// independently with Python hashlib.blake2b(digest_size=32) over the R5 byte layout.
    #[test]
    fn fencing_wire_vectors_match_indexd_fence_r5() {
        use sia_storage::fence::{FenceCredential, FenceReceipt, request_hash_vector};
        let go = FenceCredential {
            token: FenceToken::new(0x11000000000001, 2, [0xab; 16]).unwrap(),
            receipt: FenceReceipt(core::array::from_fn(|i| i as u8)),
        };
        assert_eq!(go.query_value(), "00110000000000010000000000000002abababababababababababababababab000102030405060708090a0b0c0d0e0f");
        let zeros = format!("http://127.0.0.1:9980/objects/{}", "00".repeat(32));
        assert_eq!(hex::encode(request_hash_vector("DELETE", &zeros, None, 1_800_000_000, Some(&go))), "b5c8721ea350ef87236c6d59480911958af7a04ad178b08ca5a7e528ae2465f6");
        assert_eq!(hex::encode(request_hash_vector("DELETE", &zeros, Some(&[]), 1_800_000_000, Some(&go))), "b5c8721ea350ef87236c6d59480911958af7a04ad178b08ca5a7e528ae2465f6", "no body = empty body");
        assert_eq!(hex::encode(request_hash_vector("POST", "http://127.0.0.1:9980/objects", Some(br#"{"fence":"x"}"#), 1_800_000_000, Some(&go))), "82f6b75413afadd113a9bbec03a55df1079cc46708367d922bd1b5edc7cfc360");
        let token = FenceToken::new(0x11000000000005, 3, core::array::from_fn(|i| i as u8)).unwrap();
        let cred = FenceCredential { token, receipt: FenceReceipt([0xa5; 16]) };
        let h = |m, u, b, c| hex::encode(request_hash_vector(m, u, b, 1_800_000_000, c));
        // without a credential: unchanged 0.6.0 raw form
        assert_eq!(h("DELETE", "https://indexer.example/objects/abc", None, None), "4ef2dfb47e93f848a5c756a23fbec977cab421a91ce7de239561e161d0708a19");
        assert_eq!(h("DELETE", "https://indexer.example/objects/abc", None, Some(&cred)), "a9506e4b19c2884c0a4ce6f309c81ee661cd3ab9cbdfb58a278885ee7abbfe0d");
        assert_eq!(h("POST", "https://indexer.example:9980/api/objects", Some(br#"{"x":1}"#), Some(&cred)), "b4f047e5e1862db23bdc779a8ef673220a0cc3a6795a1e38ae41900dd83f1f04");
        // the R1 raw v2 form no longer matches (indexd-fence refuses it with 401)
        assert_ne!(h("DELETE", "https://indexer.example/objects/abc", None, Some(&cred)), "db00a3be728daa1cc37609532e00562d1b4964e1b78b5867963ee3ffbf54c0d2");
    }

    #[test]
    fn every_process_draws_a_fresh_instance_id() {
        let ids: std::collections::HashSet<[u8; 16]> = (0..64).map(|_| fresh_iid()).collect();
        assert_eq!(ids.len(), 64);
    }
}

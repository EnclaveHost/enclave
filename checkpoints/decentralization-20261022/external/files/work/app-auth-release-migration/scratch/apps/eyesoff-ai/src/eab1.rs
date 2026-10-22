//! EAB1 - Enclave Account Binding snapshot: carrying an Enclave ACCOUNT (acct_…) across the retirement of the Enclave
//! identity issuer, with no issuer afterwards (protocol: work/app-auth-release-migration/PROTOCOL-EAB1.md).
//!
//! WHY. An account id is random and the account -> credentials map (its wallets, its passkeys) exists only in the relay's
//! account store; an EST1 names no credential. Once the issuer is gone nothing public ties an old account to anyone. So
//! the issuer acts ONCE, at cutover: it commits every account's credentials into a Merkle tree of SALTED leaves and signs
//! the root (the same platform key apps already pin for EST1). Owners pin {cutover, root, leaves} in each deployment's
//! on-chain config. Each account receives a private BUNDLE: its id, its per-account salt, its credentials and their
//! Merkle paths.
//!
//! WHAT THIS FILE DECIDES. Given the pinned snapshot and a bundle, which account the bundle names and which credentials
//! it provably committed at cutover. The app then requires a FRESH signature from one of those credentials (wallet.rs
//! Act::Link over this exact bundle: an EOA, a deployed or a counterfactual contract wallet) and makes its ordinary link.
//!
//! WHAT A FORMER ISSUER CAN DO AFTER CUTOVER: nothing here. Every leaf is under the pinned root; a new or changed binding
//! is a different root, which no deployment pins. (What it could do BEFORE cutover - put a wrong binding into the
//! snapshot - is the one historical trust this needs, the same trust every EST1 it ever minted carried.)
//!
//! PRIVACY. Leaves are keccak over (cutover, account, kind, credential, a 32-byte per-account secret salt), so the
//! published root and tree reveal no account, no credential and no pairing; only the bundle holder can show one.
//!
//! Shared verbatim by eyesoff-ai and jot (like wallet.rs, a copy per crate).

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

/// The account-proof prefix: `EAB1.<base64url(the bundle's exact JSON bytes)>`.
pub const PREFIX: &str = "EAB1.";
/// A bundle is a header-sized credential: an account has a handful of credentials, each with a path of at most 64 nodes.
pub const MAX_BUNDLE_BYTES: usize = 48 * 1024;
const MAX_CREDENTIALS: usize = 32;
const MAX_PATH: usize = 64;
const LEAF_TAG: &[u8] = b"EAB1-leaf";

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn hex32(s: &str) -> Option<[u8; 32]> {
    let s = s.strip_prefix("0x")?;
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}
fn lp(v: &[u8]) -> Vec<u8> {
    let mut out = (v.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(v);
    out
}
fn is_cutover_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
/// acct_ + 24 lowercase hex: exactly what relay/store.js rid("acct_") mints.
pub fn is_account(s: &str) -> bool {
    s.len() == 29 && s.starts_with("acct_") && s[5..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn is_wallet(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// p256:<x 64 hex>:<y 64 hex>:<credential id, base64url> - a relay passkey's public key (RP enclave.host).
fn is_passkey(s: &str) -> bool {
    let p: Vec<&str> = s.split(':').collect();
    p.len() == 4 && p[0] == "p256" && [p[1], p[2]].iter().all(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        && !p[3].is_empty() && p[3].len() <= 512 && p[3].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A leaf: keccak256(0x00 ‖ "EAB1-leaf" ‖ lp(cutover) ‖ lp(account) ‖ lp(kind) ‖ lp(value) ‖ salt). The 0x00 / 0x01
/// prefixes keep a leaf from ever being read as an inner node.
pub fn leaf(cutover: &str, account: &str, kind: &str, value: &str, salt: &[u8; 32]) -> [u8; 32] {
    keccak(&[&[0u8], LEAF_TAG, &lp(cutover.as_bytes()), &lp(account.as_bytes()), &lp(kind.as_bytes()), &lp(value.as_bytes()), salt])
}
/// An inner node: keccak256(0x01 ‖ min(a, b) ‖ max(a, b)) - sorted pairs, so a path is just the siblings.
pub fn node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (l, r) = if a <= b { (a, b) } else { (b, a) };
    keccak(&[&[1u8], l, r])
}
pub fn root_of(leaf: [u8; 32], path: &[[u8; 32]]) -> [u8; 32] {
    path.iter().fold(leaf, |acc, s| node(&acc, s))
}

/// The text the issuer signs (EIP-191 personal_sign) once, at cutover. It never starts "EST1.", so no EST1 verifier can
/// ever read it as a sign-in.
pub fn statement(cutover: &str, root: &[u8; 32], leaves: u64, accounts: u64, issued_at: &str) -> String {
    format!("EAB1 account binding snapshot\nCutover: {cutover}\nRoot: 0x{}\nLeaves: {leaves}\nAccounts: {accounts}\nIssued At: {issued_at}", hex(root))
}

fn recover(message: &str, sig: &[u8]) -> Option<String> {
    if sig.len() != 65 {
        return None;
    }
    let mut h = Keccak256::new();
    h.update(format!("\x19Ethereum Signed Message:\n{}", message.len()).as_bytes());
    h.update(message.as_bytes());
    let hash: [u8; 32] = h.finalize().into();
    let v = match sig[64] {
        27 | 28 => sig[64] - 27,
        b @ (0 | 1) => b,
        _ => return None,
    };
    let vk = VerifyingKey::recover_from_prehash(&hash, &Signature::from_slice(&sig[..64]).ok()?, RecoveryId::try_from(v).ok()?).ok()?;
    let point = vk.to_encoded_point(false);
    Some(format!("0x{}", hex(&keccak(&[&point.as_bytes()[1..]])[12..])))
}

/// The `migration` block of an app config: the snapshot this deployment honours, pinned by its owner.
///   { "cutover": "<id>", "root": "0x<64>", "leaves": N, "accounts": M, "issued_at": "<rfc3339>",
///     "signer": "0x<40>", "signature": "0x<130>" }
/// `signer` + `signature` are checked at parse when present: the statement must recover to the signer the owner pinned
/// (the platform SSO key), so a typo in `root` is caught before anyone migrates, not after.
#[derive(Clone, Debug, PartialEq)]
pub struct Pin {
    pub cutover: String,
    pub root: [u8; 32],
    pub leaves: u64,
    /// PASSKEY RECOVERY: the original EnclaveCreditVault factory and its implementation (`vault_factory`), as the owner
    /// pinned them from Enclave's address book. With it, a committed P-256 passkey proves its account through the vault
    /// that passkey controls - the factory's deterministic vaultFor(x, y), derived HERE, never taken from a request.
    pub vault: Option<VaultPin>,
}

/// The original credit-vault factory: CREATE2 clones (EIP-1167) of `implementation`, salted by keccak256(abi.encode(x, y))
/// of the vault's ROOT passkey (contracts/EnclaveCreditVault.sol, EnclaveCreditVaultFactory). The vault answers ERC-1271
/// only for a WebAuthn assertion by one of its active keys, signed from the factory's pinned origin.
#[derive(Clone, Debug, PartialEq)]
pub struct VaultPin {
    pub factory: [u8; 20],
    pub implementation: [u8; 20],
}

fn hex20(s: &str) -> Option<[u8; 20]> {
    let s = s.strip_prefix("0x")?;
    if s.len() != 40 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// vaultFor(x, y) exactly as EnclaveCreditVaultFactory computes it:
/// keccak256(0xff ‖ factory ‖ keccak256(abi.encode(x, y)) ‖ keccak256(EIP-1167 clone code of implementation))[12..]
pub fn vault_for(v: &VaultPin, x: &[u8; 32], y: &[u8; 32]) -> String {
    let salt = keccak(&[x, y]);
    let mut code = Vec::with_capacity(55);
    code.extend_from_slice(&[0x3d, 0x60, 0x2d, 0x80, 0x60, 0x0a, 0x3d, 0x39, 0x81, 0xf3, 0x36, 0x3d, 0x3d, 0x37, 0x3d, 0x3d, 0x3d, 0x36, 0x3d, 0x73]);
    code.extend_from_slice(&v.implementation);
    code.extend_from_slice(&[0x5a, 0xf4, 0x3d, 0x82, 0x80, 0x3e, 0x90, 0x3d, 0x91, 0x60, 0x2b, 0x57, 0xfd, 0x5b, 0xf3]);
    let addr = keccak(&[&[0xff], &v.factory, &salt, &keccak(&[&code])]);
    format!("0x{}", hex(&addr[12..]))
}

/// (x, y) of a committed passkey value p256:<x>:<y>:<credId>
fn passkey_xy(value: &str) -> Option<([u8; 32], [u8; 32])> {
    let p: Vec<&str> = value.split(':').collect();
    Some((hex32(&format!("0x{}", p.get(1)?))?, hex32(&format!("0x{}", p.get(2)?))?))
}

impl Pin {
    pub fn parse(v: &serde_json::Value) -> Result<Pin, String> {
        let o = v.as_object().ok_or("migration must be an object")?;
        for k in o.keys() {
            if !["cutover", "root", "leaves", "accounts", "issued_at", "signer", "signature", "vault_factory"].contains(&k.as_str()) {
                return Err(format!("migration: unknown key {k}"));
            }
        }
        let s = |k: &str| o.get(k).and_then(|x| x.as_str());
        let cutover = s("cutover").filter(|c| is_cutover_id(c)).ok_or("migration.cutover: 1..64 of a-z 0-9 -")?.to_string();
        let root = s("root").and_then(hex32).ok_or("migration.root: 0x + 64 hex")?;
        let leaves = o.get("leaves").and_then(|x| x.as_u64()).filter(|n| *n >= 1).ok_or("migration.leaves: a positive count")?;
        match (s("signer"), s("signature")) {
            (None, None) => {}
            (Some(signer), Some(sig)) => {
                let accounts = o.get("accounts").and_then(|x| x.as_u64()).ok_or("migration.accounts is needed to check the signature")?;
                let issued = s("issued_at").ok_or("migration.issued_at is needed to check the signature")?;
                let sig = sig.strip_prefix("0x").filter(|h| h.len() == 130 && h.bytes().all(|b| b.is_ascii_hexdigit())).ok_or("migration.signature: 0x + 130 hex")?;
                let bytes: Vec<u8> = (0..65).map(|i| u8::from_str_radix(&sig[2 * i..2 * i + 2], 16).unwrap()).collect();
                let text = statement(&cutover, &root, leaves, accounts, issued);
                if recover(&text, &bytes).as_deref() != Some(signer.to_ascii_lowercase().as_str()) {
                    return Err("migration: the snapshot statement is not signed by migration.signer".into());
                }
            }
            _ => return Err("migration: signer and signature go together".into()),
        }
        let vault = match o.get("vault_factory") {
            None | Some(serde_json::Value::Null) => None,
            Some(v) => {
                let f = |k: &str| v.get(k).and_then(|x| x.as_str()).and_then(hex20);
                let (Some(factory), Some(implementation)) = (f("address"), f("implementation")) else {
                    return Err("migration.vault_factory: {address, implementation}, each 0x + 40 hex".into());
                };
                if v.as_object().is_some_and(|m| m.keys().any(|k| k != "address" && k != "implementation")) {
                    return Err("migration.vault_factory: unknown key".into());
                }
                Some(VaultPin { factory, implementation })
            }
        };
        Ok(Pin { cutover, root, leaves, vault })
    }
}

/// An opened, verified bundle: the account, and the credentials it provably committed at cutover.
#[derive(Clone, Debug, PartialEq)]
pub struct Bundle {
    pub account: String,
    /// lowercase 0x addresses (EOA or contract wallets)
    pub wallets: Vec<String>,
    /// p256:<x>:<y>:<credId> - the account's committed passkeys
    pub passkeys: Vec<String>,
    /// the vault each committed passkey controls under the pinned factory (empty without `vault_factory`): addresses a
    /// passkey proves through, by a WebAuthn assertion from the vault's pinned origin (ERC-1271, or ERC-6492 before the
    /// vault exists) - see PROTOCOL-EAB1.md §3a
    pub vaults: Vec<String>,
}

/// Open an `EAB1.<base64url(json)>` credential against the pinned snapshot. EVERY credential's path must reach the
/// pinned root: a bundle with one corrupted entry is refused whole, never partly believed.
pub fn open(pin: &Pin, cred: &str) -> Result<Bundle, String> {
    let bad = |m: &str| format!("account migration file: {m}");
    if cred.len() > PREFIX.len() + (MAX_BUNDLE_BYTES * 4).div_ceil(3) {
        return Err(bad("too large"));
    }
    let b64 = cred.strip_prefix(PREFIX).ok_or_else(|| bad("not an EAB1 migration file"))?;
    let raw = URL_SAFE_NO_PAD.decode(b64).map_err(|_| bad("not base64url"))?;
    let v: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| bad("not JSON"))?;
    let o = v.as_object().ok_or_else(|| bad("not an object"))?;
    for k in o.keys() {
        if !["v", "kind", "cutover", "root", "account", "salt", "credentials"].contains(&k.as_str()) {
            return Err(bad(&format!("unknown key {k}")));
        }
    }
    if o.get("v").and_then(|x| x.as_u64()) != Some(1) || o.get("kind").and_then(|x| x.as_str()) != Some("EAB1-bundle") {
        return Err(bad("unsupported version"));
    }
    let s = |k: &str| o.get(k).and_then(|x| x.as_str()).unwrap_or("");
    if s("cutover") != pin.cutover {
        return Err(bad("made for another cutover than this deployment pins"));
    }
    if hex32(s("root")) != Some(pin.root) {
        return Err(bad("made for another snapshot root than this deployment pins"));
    }
    let account = s("account").to_string();
    if !is_account(&account) {
        return Err(bad("names no Enclave account"));
    }
    let salt = hex32(s("salt")).ok_or_else(|| bad("malformed salt"))?;
    let creds = o.get("credentials").and_then(|x| x.as_array()).ok_or_else(|| bad("no credentials"))?;
    if creds.is_empty() || creds.len() > MAX_CREDENTIALS {
        return Err(bad("credential count out of range"));
    }
    let mut out = Bundle { account, wallets: Vec::new(), passkeys: Vec::new(), vaults: Vec::new() };
    for c in creds {
        let c = c.as_object().ok_or_else(|| bad("malformed credential"))?;
        if c.keys().any(|k| !["kind", "value", "path"].contains(&k.as_str())) {
            return Err(bad("malformed credential"));
        }
        let kind = c.get("kind").and_then(|x| x.as_str()).unwrap_or("");
        let value = c.get("value").and_then(|x| x.as_str()).unwrap_or("");
        match kind {
            "wallet" if is_wallet(value) => {}
            "passkey" if is_passkey(value) => {}
            _ => return Err(bad("malformed credential")),
        }
        let path = c.get("path").and_then(|x| x.as_array()).ok_or_else(|| bad("malformed proof path"))?;
        if path.len() > MAX_PATH {
            return Err(bad("proof path too long"));
        }
        let path: Vec<[u8; 32]> = path.iter().map(|p| p.as_str().and_then(hex32)).collect::<Option<_>>().ok_or_else(|| bad("malformed proof path"))?;
        if root_of(leaf(&pin.cutover, &out.account, kind, value, &salt), &path) != pin.root {
            return Err(bad("a credential is not in the pinned snapshot (corrupted or forged)"));
        }
        let list = if kind == "wallet" { &mut out.wallets } else { &mut out.passkeys };
        if list.contains(&value.to_string()) {
            return Err(bad("duplicate credential"));
        }
        list.push(value.to_string());
    }
    if let Some(v) = &pin.vault {
        for pk in &out.passkeys {
            let (x, y) = passkey_xy(pk).ok_or_else(|| bad("malformed credential"))?;
            out.vaults.push(vault_for(v, &x, &y));
        }
    }
    if out.wallets.is_empty() && out.vaults.is_empty() {
        return Err(bad(if out.passkeys.is_empty() {
            "commits no credential this deployment can check"
        } else {
            "commits only passkeys, and this deployment pins no passkey-vault factory (migration.vault_factory) to check them"
        }));
    }
    Ok(out)
}

/// The account `cred` names, when `wallet` (the address that will sign, lowercase 0x) is one it committed: a wallet the
/// account had at cutover, or the vault (under the pinned factory) of a passkey it had. The caller still requires that
/// address's own fresh signature - for a vault, the contract's WebAuthn check of an active key at its pinned origin.
pub fn account_for(pin: &Pin, cred: &str, wallet: &str) -> Result<String, String> {
    let b = open(pin, cred)?;
    let w = wallet.to_ascii_lowercase();
    if !b.wallets.contains(&w) && !b.vaults.contains(&w) {
        return Err("this wallet is not one the account migration file commits: sign with a wallet the account had at cutover, or with its passkey's vault".into());
    }
    Ok(b.account)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A tiny snapshot built the way tools/eab1.mjs builds one, for request-level tests.
    pub struct Snap {
        pub pin: Pin,
        pub bundles: Vec<(String, String)>, // (account, EAB1 credential)
    }
    pub fn snapshot(cutover: &str, accounts: &[(&str, [u8; 32], Vec<(&str, &str)>)]) -> Snap {
        let mut leaves: Vec<([u8; 32], usize, usize)> = Vec::new();
        for (ai, (acct, salt, creds)) in accounts.iter().enumerate() {
            for (ci, (k, v)) in creds.iter().enumerate() {
                leaves.push((leaf(cutover, acct, k, v, salt), ai, ci));
            }
        }
        leaves.sort();
        // levels of the tree; an odd node is carried up unchanged
        let mut levels = vec![leaves.iter().map(|l| l.0).collect::<Vec<_>>()];
        while levels.last().unwrap().len() > 1 {
            let l = levels.last().unwrap();
            levels.push(l.chunks(2).map(|c| if c.len() == 2 { node(&c[0], &c[1]) } else { c[0] }).collect());
        }
        let root = levels.last().unwrap()[0];
        let path_of = |mut i: usize| {
            let mut p = Vec::new();
            for l in &levels[..levels.len() - 1] {
                let s = i ^ 1;
                if s < l.len() {
                    p.push(format!("0x{}", hex(&l[s])));
                }
                i /= 2;
            }
            p
        };
        let mut bundles = Vec::new();
        for (ai, (acct, salt, creds)) in accounts.iter().enumerate() {
            let cs: Vec<serde_json::Value> = creds.iter().enumerate().map(|(ci, (k, v))| {
                let i = leaves.iter().position(|l| l.1 == ai && l.2 == ci).unwrap();
                serde_json::json!({ "kind": k, "value": v, "path": path_of(i) })
            }).collect();
            let j = serde_json::json!({ "v": 1, "kind": "EAB1-bundle", "cutover": cutover, "root": format!("0x{}", hex(&root)),
                                        "account": acct, "salt": format!("0x{}", hex(salt)), "credentials": cs });
            bundles.push((acct.to_string(), format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(j.to_string()))));
        }
        Snap { pin: Pin { cutover: cutover.into(), root, leaves: leaves.len() as u64, vault: None }, bundles }
    }
    const A1: &str = "acct_0e64d1897f10b32d3a1bc84e";
    const A2: &str = "acct_99aa11bb22cc33dd44ee55ff";
    const W1: &str = "0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025";
    const W2: &str = "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf";
    const W3: &str = "0x6813eb9362372eef6200f3b1dbc3f819671cba69";
    fn snap() -> Snap {
        snapshot("enclave-test-cutover", &[
            (A1, [1u8; 32], vec![("wallet", W1), ("passkey", PK)]),
            (A2, [2u8; 32], vec![("wallet", W2)]),
            ("acct_aaaaaaaaaaaaaaaaaaaaaaaa", [3u8; 32], vec![("wallet", W3)]),
        ])
    }
    const PK: &str = "p256:1111111111111111111111111111111111111111111111111111111111111111:2222222222222222222222222222222222222222222222222222222222222222:Y3JlZC1pZC0x";

    #[test]
    fn a_bundle_proves_its_own_account_and_wallets_only() {
        let s = snap();
        let b = open(&s.pin, &s.bundles[0].1).unwrap();
        assert_eq!(b, Bundle { account: A1.into(), wallets: vec![W1.into()], passkeys: vec![PK.to_string()], vaults: vec![] });
        assert_eq!(account_for(&s.pin, &s.bundles[0].1, W1).unwrap(), A1);
        assert_eq!(account_for(&s.pin, &s.bundles[0].1, &W1.to_ascii_uppercase().replace("0X", "0x")).unwrap(), A1);
        // another account's wallet, presented with this bundle
        assert!(account_for(&s.pin, &s.bundles[0].1, W2).unwrap_err().contains("not one the account migration file commits"));
        assert_eq!(account_for(&s.pin, &s.bundles[1].1, W2).unwrap(), A2);
    }

    fn edit(cred: &str, f: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut v: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&cred[PREFIX.len()..]).unwrap()).unwrap();
        f(&mut v);
        format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(v.to_string()))
    }

    /// Every way to move a binding is a root the deployment does not pin.
    #[test]
    fn a_bundle_cannot_be_redirected_forged_or_corrupted() {
        let s = snap();
        let b0 = &s.bundles[0].1;
        let cases: Vec<(&str, String)> = vec![
            ("another account", edit(b0, |v| v["account"] = serde_json::json!(A2))),
            ("another wallet", edit(b0, |v| v["credentials"][0]["value"] = serde_json::json!(W3))),
            ("another salt", edit(b0, |v| v["salt"] = serde_json::json!(format!("0x{}", "09".repeat(32))))),
            ("a dropped path node", edit(b0, |v| { v["credentials"][0]["path"].as_array_mut().unwrap().pop(); })),
            ("a flipped path node", edit(b0, |v| { let p = v["credentials"][0]["path"][0].as_str().unwrap().to_string();
                v["credentials"][0]["path"][0] = serde_json::json!(format!("{}{}", &p[..65], if p.ends_with('0') { "1" } else { "0" })); })),
            ("another cutover", edit(b0, |v| v["cutover"] = serde_json::json!("enclave-other"))),
            ("another root", edit(b0, |v| v["root"] = serde_json::json!(format!("0x{}", "ab".repeat(32))))),
            ("a corrupted passkey entry beside a good wallet", edit(b0, |v| v["credentials"][1]["value"] = serde_json::json!(PK.replace("1111", "1112")))),
            ("an extra credential with a borrowed path", edit(b0, |v| { let p = v["credentials"][0]["path"].clone();
                v["credentials"].as_array_mut().unwrap().push(serde_json::json!({ "kind": "wallet", "value": W3, "path": p })); })),
            ("an unknown key", edit(b0, |v| v["note"] = serde_json::json!("x"))),
            ("version 2", edit(b0, |v| v["v"] = serde_json::json!(2))),
            ("a duplicate credential", edit(b0, |v| { let c = v["credentials"][0].clone(); v["credentials"].as_array_mut().unwrap().push(c); })),
        ];
        for (what, cred) in cases {
            assert!(open(&s.pin, &cred).is_err(), "{what} was accepted");
        }
        // a different snapshot (a former issuer's NEW one, after cutover) is not the pinned root
        let forged = snapshot("enclave-test-cutover", &[(A1, [1u8; 32], vec![("wallet", W3)])]);
        assert!(open(&s.pin, &forged.bundles[0].1).unwrap_err().contains("another snapshot root"));
        assert!(account_for(&forged.pin, &forged.bundles[0].1, W3).is_ok(), "(it would open only where its own root is pinned)");
        for junk in ["", "EAB1.", "EAB1.!!", "EAB1.bnVsbA", "EST1.x.y", &format!("EAB1.{}", "A".repeat(80_000))] {
            assert!(open(&s.pin, junk).is_err(), "{junk:.20}");
        }
    }

    /// The original factory's address rule, against a vector computed by viem (getContractAddress, CREATE2) for the
    /// same factory, implementation and key.
    #[test]
    fn vault_for_is_the_factorys_create2_address() {
        let v = VaultPin { factory: hex20("0xa891e4396e3eb11f364554043bc18e86da834e91").unwrap(), implementation: hex20(&format!("0x{}", "12".repeat(20))).unwrap() };
        assert_eq!(vault_for(&v, &[0x11; 32], &[0x22; 32]), VAULT_VECTOR);
    }
    pub const VAULT_VECTOR: &str = "0x94f6c9be6f6c6428e76c89d0c09e3167df9bb807";

    /// A passkey-only account proves through its passkey's vault, and only where the owner pinned the vault factory;
    /// no other address - another factory's, another key's, a wallet's - is accepted for it.
    #[test]
    fn a_passkey_only_account_proves_through_its_own_passkey_vault_only() {
        let s = snapshot("enclave-test-cutover", &[(A1, [1u8; 32], vec![("passkey", PK)]), (A2, [2u8; 32], vec![("wallet", W2)])]);
        // no vault factory pinned: committed, but nothing to check it with - said precisely
        assert!(open(&s.pin, &s.bundles[0].1).unwrap_err().contains("pins no passkey-vault factory"));
        let v = VaultPin { factory: [0xaa; 20], implementation: [0xbb; 20] };
        let pin = Pin { vault: Some(v.clone()), ..s.pin.clone() };
        let b = open(&pin, &s.bundles[0].1).unwrap();
        let vault = vault_for(&v, &[0x11; 32], &[0x22; 32]);
        assert_eq!(b.vaults, vec![vault.clone()]);
        assert_eq!(account_for(&pin, &s.bundles[0].1, &vault).unwrap(), A1);
        // another factory's vault for the same key, another key's vault under this factory, an arbitrary address
        let other_factory = vault_for(&VaultPin { factory: [0xac; 20], implementation: [0xbb; 20] }, &[0x11; 32], &[0x22; 32]);
        let other_impl = vault_for(&VaultPin { factory: [0xaa; 20], implementation: [0xbc; 20] }, &[0x11; 32], &[0x22; 32]);
        let other_key = vault_for(&v, &[0x33; 32], &[0x22; 32]);
        for w in [other_factory, other_impl, other_key, W2.to_string(), W1.to_string()] {
            assert!(account_for(&pin, &s.bundles[0].1, &w).is_err(), "{w} was accepted for a passkey-only account");
        }
        // a wallet account is unaffected by the vault pin, and its wallet's vault-shaped twin means nothing
        assert_eq!(account_for(&pin, &s.bundles[1].1, W2).unwrap(), A2);
        // the pin is strict
        let root = format!("0x{}", hex(&s.pin.root));
        for bad in [serde_json::json!({ "address": "0x12" , "implementation": format!("0x{}", "bb".repeat(20)) }),
                    serde_json::json!({ "address": format!("0x{}", "aa".repeat(20)) }),
                    serde_json::json!({ "address": format!("0x{}", "aa".repeat(20)), "implementation": format!("0x{}", "bb".repeat(20)), "origin": "x" })] {
            assert!(Pin::parse(&serde_json::json!({ "cutover": "x", "root": root, "leaves": 4, "vault_factory": bad })).is_err());
        }
        let ok = Pin::parse(&serde_json::json!({ "cutover": "x", "root": root, "leaves": 4,
            "vault_factory": { "address": format!("0x{}", "aa".repeat(20)), "implementation": format!("0x{}", "bb".repeat(20)) } })).unwrap();
        assert_eq!(ok.vault, Some(v));
    }

    #[test]
    fn an_account_with_no_credential_cannot_be_opened() {
        // the tool commits no such account at all; a hand-made bundle with an empty list is refused
        let s = snap();
        let none = edit(&s.bundles[0].1, |v| v["credentials"] = serde_json::json!([]));
        assert!(open(&s.pin, &none).is_err());
    }

    #[test]
    fn the_pin_checks_the_issuers_statement() {
        use k256::ecdsa::SigningKey;
        let s = snap();
        let key = SigningKey::from_slice(&[0x42; 32]).unwrap();
        let text = statement(&s.pin.cutover, &s.pin.root, s.pin.leaves, 3, "2026-11-01T00:00:00Z");
        let mut h = Keccak256::new();
        h.update(format!("\x19Ethereum Signed Message:\n{}", text.len()).as_bytes());
        h.update(text.as_bytes());
        let (sig, rec) = key.sign_prehash_recoverable(&h.finalize()).unwrap();
        let sig = format!("0x{}{:02x}", hex(&sig.to_bytes()), rec.to_byte() + 27);
        let cfg = |root: &str, signer: &str| serde_json::json!({ "cutover": s.pin.cutover, "root": root, "leaves": s.pin.leaves, "accounts": 3,
            "issued_at": "2026-11-01T00:00:00Z", "signer": signer, "signature": sig });
        let root = format!("0x{}", hex(&s.pin.root));
        assert_eq!(Pin::parse(&cfg(&root, "0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025")).unwrap(), s.pin);
        // a typo in the root, or another signer, is caught at config parse
        assert!(Pin::parse(&cfg(&format!("0x{}", "00".repeat(32)), "0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025")).is_err());
        assert!(Pin::parse(&cfg(&root, "0x2b5ad5c4795c026514f8317c7a215e218dccd6cf")).is_err());
        // pinned without the statement: allowed (the owner checked it with the tool), and strictly shaped
        assert!(Pin::parse(&serde_json::json!({ "cutover": "x", "root": root, "leaves": 4 })).is_ok());
        for bad in [serde_json::json!({ "cutover": "X", "root": root, "leaves": 4 }), serde_json::json!({ "cutover": "x", "root": "0x12", "leaves": 4 }),
                    serde_json::json!({ "cutover": "x", "root": root, "leaves": 0 }), serde_json::json!({ "cutover": "x", "root": root, "leaves": 4, "extra": 1 }),
                    serde_json::json!({ "cutover": "x", "root": root, "leaves": 4, "signer": "0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025" })] {
            assert!(Pin::parse(&bad).is_err(), "{bad}");
        }
    }

    /// The vector the tool must reproduce (tools/eab1.mjs builds the same tree for the same input).
    #[test]
    fn shared_vector() {
        let s = snap();
        eprintln!("eab1 vector root: 0x{}", hex(&s.pin.root));
        assert_eq!(hex(&leaf("c", A1, "wallet", W1, &[1u8; 32])), LEAF_VECTOR);
        assert_eq!(hex(&s.pin.root), ROOT_VECTOR);
    }
    pub const LEAF_VECTOR: &str = "360ea169c196a1261bd27c7d864dd838a88be4d0e39e1154710565c7b0637b05";
    pub const ROOT_VECTOR: &str = "44f05290be66211760bd324a0ac42b647c7c48aba7986639cc82a6060fdd4cce";
}

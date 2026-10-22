//! Account links: a wallet, explicitly and once, becoming the way an existing
//! Enclave account reaches its own notebook.
//!
//! An account's notes live under `<prefix>users/acct_…/`, sealed under a key
//! derived for that account. A wallet that signs in directly is a different
//! identity (`wallet_0x…`, wallet.rs) with a different, empty notebook - on
//! purpose: an address says nothing about which account it belongs to. This
//! is the one way across, and it takes the person's own act, proven with both
//! credentials at once:
//!
//!   - the ACCOUNT, by a Sign in with Enclave token minted for THIS notebook's
//!     own deployment in the last ten minutes (an old session token sitting in
//!     a tab proves no intent);
//!   - the WALLET, by an EIP-4361 message naming exactly that account, that
//!     exact token (by hash), this deployment and ten minutes (wallet.rs,
//!     Act::Link). A routine wallet sign-in never qualifies.
//!
//! THE BUCKET IS NOT AN AUTHORITY. Whoever operates the bucket can write any
//! object, so a link record is only believed if it carries this app's MAC:
//! HMAC-SHA256 under the deployment's LINK KEY, a secret the bucket never
//! sees (`link_key`, or one derived from `master_key` with its own domain
//! separation, see LinkKey). The MAC covers, length-prefixed: the record
//! format, its DIRECTION (wallet->account or account->wallet), this
//! deployment's audience, the bucket, the notebook prefix, the account, the
//! wallet and the creation time. So a record forged by the storage operator,
//! copied from another deployment, bucket or prefix, moved to the other
//! direction or to another identity's path, or edited in any field, links
//! nothing; and with no link key configured NO record links anything, however
//! many exist. Unsigned records (format v1, never activated) never count.
//!
//! Two records, each created ONLY IF ABSENT (`If-None-Match: *`):
//!
//!   <prefix>.jot/links/wallet/<wallet_0x…>   names the account
//!   <prefix>.jot/links/account/<acct_…>      names the wallet
//!
//! `.jot/` is a reserved name no note can take and no user namespace reaches.
//! A wallet acts as the account only when BOTH records verify and name each
//! other (the pair is what makes the link one-to-one); one alone is inert.
//!
//! WRITES, AND WHAT HAPPENS WHEN THEY FAIL. Nothing is ever deleted. The rules:
//!   - a COMPLETE link (both records verified, naming each other) is never
//!     touched: a second link for either side is a 409 (no relink);
//!   - the wallet's own notebook must be EMPTY, or linking would hide notes;
//!   - a record that is inert (verified but half of nothing) or that does not
//!     verify at all (forged, legacy, another key) is replaced only by a PUT
//!     conditional on the exact ETag that was judged (`If-Match`), so a change
//!     between the judgement and the write loses the write instead of being
//!     overwritten;
//!   - an interrupted attempt leaves at most an inert half, which the next
//!     attempt (by anyone who can prove both sides) completes or replaces;
//!   - both records are read back and verified afterwards: success is only
//!     ever reported for a link that is complete as written.
//!
//! What the store must honour: If-None-Match: * and If-Match on PUT (AWS S3,
//! R2 and minio do; jot already relies on If-Match for note writes). A store
//! that ignores them can let two racing link attempts end with the last
//! writer's link. Those attempts are only ever ones the SAME wallet holder (or
//! the same account holder) signed, so a race picks between links that party
//! authorized; it never hands an identity to anyone who did not sign for it.
//! There is no unlink, no transfer, and nothing moves: the account's notes
//! stay exactly where and how they were sealed.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

/// Where link records live, relative to the notebook prefix.
pub const LINKS: &str = ".jot/links/";
const FORMAT: &str = "jot-link-record-v2";

/// The key link records are MAC'd under. Never the bucket's: it is derived
/// from a deployment secret, with a domain string no note cipher scope uses
/// (crypt.rs derives `jot-key-v1:<scope>`; this is `jot-link-v1:mac`).
pub struct LinkKey([u8; 32]);

impl LinkKey {
    /// From the deployment secret; None when the secret is too short to be one.
    pub fn from_secret(secret: &str) -> Option<LinkKey> {
        if secret.len() < 16 {
            return None;
        }
        let k = Sha256::digest(secret.as_bytes());
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&k).ok()?;
        mac.update(b"jot-link-v1:mac");
        Some(LinkKey(mac.finalize().into_bytes().into()))
    }
    fn mac(&self, msg: &[u8]) -> [u8; 32] {
        let mut m = <Hmac<Sha256> as Mac>::new_from_slice(&self.0).expect("hmac key");
        m.update(msg);
        m.finalize().into_bytes().into()
    }
}

/// Everything a record is bound to besides its own two identities.
pub struct Ctx<'a> {
    pub key: &'a LinkKey,
    /// this deployment's id (the wallet block's audience)
    pub aud: &'a str,
    pub bucket: &'a str,
    pub prefix: &'a str,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Dir {
    Wallet,
    Account,
}
impl Dir {
    fn as_str(self) -> &'static str {
        match self {
            Dir::Wallet => "wallet",
            Dir::Account => "account",
        }
    }
}

/// The storage a link needs: read, create-only-if-absent, replace-if-unchanged
/// (compare-and-swap on the ETag), and "is there anything under this prefix".
/// The S3 store implements it in lib.rs; the tests in memory.
pub trait LinkStore {
    /// (body, etag) or None
    fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, String>;
    /// Some(etag) when this call created the object, None when one existed
    fn create(&self, key: &str, body: &[u8]) -> Result<Option<String>, String>;
    /// write only if the object still has `etag`; false when it changed
    fn replace_if(&self, key: &str, body: &[u8], etag: &str) -> Result<bool, String>;
    fn any_under(&self, prefix: &str) -> Result<bool, String>;
}

pub fn wallet_key(prefix: &str, wallet: &str) -> String {
    format!("{prefix}{LINKS}wallet/{wallet}")
}
pub fn account_key(prefix: &str, account: &str) -> String {
    format!("{prefix}{LINKS}account/{account}")
}

/// The MAC'd bytes: every field length-prefixed, so no field can bleed into
/// the next, whatever it contains.
fn signed_bytes(ctx: &Ctx, dir: Dir, account: &str, wallet: &str, at: u64) -> Vec<u8> {
    let mut out = Vec::new();
    for f in [FORMAT, dir.as_str(), &ctx.aud.to_ascii_lowercase(), ctx.bucket, ctx.prefix, account, wallet, &at.to_string()] {
        out.extend_from_slice(&(f.len() as u64).to_be_bytes());
        out.extend_from_slice(f.as_bytes());
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

pub fn record(ctx: &Ctx, dir: Dir, account: &str, wallet: &str, at: u64) -> Vec<u8> {
    let mac = hex(&ctx.key.mac(&signed_bytes(ctx, dir, account, wallet, at)));
    serde_json::json!({ "v": 2, "dir": dir.as_str(), "account": account, "wallet": wallet,
                        "aud": ctx.aud.to_ascii_lowercase(), "at": at, "mac": mac })
        .to_string()
        .into_bytes()
}

/// (account, wallet) of a record that THIS app wrote for THIS context in this
/// direction, or None for anything else - forged, legacy, edited, another
/// deployment's, bucket's, prefix's or key's.
pub fn verify(ctx: &Ctx, dir: Dir, body: &[u8]) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    if v.get("v")?.as_u64()? != 2 || v.get("dir")?.as_str()? != dir.as_str() {
        return None;
    }
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let (account, wallet, aud, mac) = (s("account")?, s("wallet")?, s("aud")?, s("mac")?);
    let at = v.get("at")?.as_u64()?;
    if !aud.eq_ignore_ascii_case(ctx.aud) {
        return None;
    }
    let want = hex(&ctx.key.mac(&signed_bytes(ctx, dir, &account, &wallet, at)));
    ct_eq(mac.as_bytes(), want.as_bytes()).then_some((account, wallet))
}

/// The account a wallet acts as, if a COMPLETE, AUTHENTIC link names it.
/// Without a link key (`ctx` None) nothing is even read: no record, present
/// or not, can authorize anything.
pub fn resolve(store: &dyn LinkStore, ctx: Option<&Ctx>, wallet: &str) -> Result<Option<String>, String> {
    let Some(ctx) = ctx else { return Ok(None) };
    let Some((wb, _)) = store.get(&wallet_key(ctx.prefix, wallet))? else { return Ok(None) };
    let Some((account, w)) = verify(ctx, Dir::Wallet, &wb) else { return Ok(None) };
    if w != wallet {
        return Ok(None);
    }
    let Some((ab, _)) = store.get(&account_key(ctx.prefix, &account))? else { return Ok(None) };
    Ok(match verify(ctx, Dir::Account, &ab) {
        Some((a, w2)) if a == account && w2 == wallet => Some(account),
        _ => None,
    })
}

/// What a slot holds, judged: empty, ours already, or someone else's - and if
/// someone else's, whether that is a complete link (untouchable) or inert /
/// unauthentic (replaceable at exactly this ETag).
enum Slot {
    Empty,
    Ours,
    Taken,
    Replaceable(String),
}

fn judge(store: &dyn LinkStore, ctx: &Ctx, dir: Dir, key: &str, account: &str, wallet: &str) -> Result<Slot, String> {
    let Some((body, etag)) = store.get(key)? else { return Ok(Slot::Empty) };
    Ok(match verify(ctx, dir, &body) {
        Some((a, w)) if a == account && w == wallet => Slot::Ours,
        // authentic, but at the wrong path (a copy): never an authority here
        Some((a, w)) if (dir == Dir::Wallet && w != wallet) || (dir == Dir::Account && a != account) => Slot::Replaceable(etag),
        // authentic, for another pair: complete only if its partner agrees
        Some((a, w)) => {
            let complete = match dir {
                Dir::Wallet => resolve(store, Some(ctx), &w)?.as_deref() == Some(a.as_str()),
                Dir::Account => store
                    .get(&wallet_key(ctx.prefix, &w))?
                    .and_then(|(b, _)| verify(ctx, Dir::Wallet, &b))
                    .is_some_and(|(a2, w2)| a2 == a && w2 == w),
            };
            if complete { Slot::Taken } else { Slot::Replaceable(etag) }
        }
        // forged, legacy, another key or context: never an authority
        None => Slot::Replaceable(etag),
    })
}

/// Make the link. The caller has verified both proofs. Errors are
/// (status, message): 409 for "already linked", "would hide notes" or a lost
/// race; 502 when the bucket fails mid-way (the half written is inert).
pub fn create(store: &dyn LinkStore, ctx: &Ctx, account: &str, wallet: &str, now: u64) -> Result<(), (u16, String)> {
    let io = |e: String| (502, format!("the notebook's bucket refused the link: {e}"));
    if resolve(store, Some(ctx), wallet).map_err(io)?.as_deref() == Some(account) {
        return Ok(()); // the same link again
    }
    if store.any_under(&format!("{}users/{wallet}/", ctx.prefix)).map_err(io)? {
        return Err((409, "this wallet already has notes of its own here; linking would hide them. Export or delete them first".into()));
    }
    let sides = [
        (Dir::Wallet, wallet_key(ctx.prefix, wallet), "this wallet is already linked to an account here"),
        (Dir::Account, account_key(ctx.prefix, account), "this account is already linked to another wallet here"),
    ];
    // judge both before writing either, so a Taken side writes nothing at all
    let mut plan = Vec::new();
    for (dir, key, taken) in &sides {
        match judge(store, ctx, *dir, key, account, wallet).map_err(io)? {
            Slot::Taken => return Err((409, (*taken).into())),
            s => plan.push((*dir, key, s)),
        }
    }
    for (dir, key, slot) in plan {
        let body = record(ctx, dir, account, wallet, now);
        let wrote = match slot {
            Slot::Ours => true,
            Slot::Empty => store.create(key, &body).map_err(io)?.is_some(),
            Slot::Replaceable(etag) => store.replace_if(key, &body, &etag).map_err(io)?,
            Slot::Taken => unreachable!("refused above"),
        };
        if !wrote {
            return Err((409, "another link for this wallet or account was being made at the same moment; try again".into()));
        }
    }
    match resolve(store, Some(ctx), wallet).map_err(io)? {
        Some(a) if a == account => Ok(()),
        _ => Err((409, "the link was not recorded (another link for this account or wallet won); nothing changed for you".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    /// An in-memory bucket with S3's conditional semantics (or, `honest`
    /// false, a store that ignores them), able to fail or race on demand.
    struct Mem {
        objects: RefCell<BTreeMap<String, (Vec<u8>, String)>>,
        honest: bool,
        n: RefCell<u64>,
        /// fail the create/replace after this many succeed (a crash between writes)
        fail_after: RefCell<Option<u64>>,
        /// change this key's ETag right before the next replace_if (a racer)
        race_on: RefCell<Option<String>>,
    }
    impl Mem {
        fn new(honest: bool) -> Mem {
            Mem { objects: RefCell::new(BTreeMap::new()), honest, n: RefCell::new(0), fail_after: RefCell::new(None), race_on: RefCell::new(None) }
        }
        fn etag(&self) -> String {
            *self.n.borrow_mut() += 1;
            format!("e{}", self.n.borrow())
        }
        fn put(&self, key: &str, body: Vec<u8>) {
            let e = self.etag();
            self.objects.borrow_mut().insert(key.into(), (body, e));
        }
        fn tick(&self) -> Result<(), String> {
            if let Some(k) = self.fail_after.borrow_mut().as_mut() {
                if *k == 0 {
                    return Err("connection reset".into());
                }
                *k -= 1;
            }
            Ok(())
        }
    }
    impl LinkStore for Mem {
        fn get(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, String> {
            Ok(self.objects.borrow().get(key).cloned())
        }
        fn create(&self, key: &str, body: &[u8]) -> Result<Option<String>, String> {
            self.tick()?;
            if self.honest && self.objects.borrow().contains_key(key) {
                return Ok(None);
            }
            self.put(key, body.to_vec());
            Ok(self.objects.borrow().get(key).map(|(_, e)| e.clone()))
        }
        fn replace_if(&self, key: &str, body: &[u8], etag: &str) -> Result<bool, String> {
            self.tick()?;
            if self.race_on.borrow().as_deref() == Some(key) {
                let b = self.objects.borrow().get(key).map(|(b, _)| b.clone()).unwrap_or_default();
                self.put(key, b);
                *self.race_on.borrow_mut() = None;
            }
            let current = self.objects.borrow().get(key).map(|(_, e)| e.clone());
            if self.honest && current.as_deref() != Some(etag) {
                return Ok(false);
            }
            self.put(key, body.to_vec());
            Ok(true)
        }
        fn any_under(&self, prefix: &str) -> Result<bool, String> {
            Ok(self.objects.borrow().keys().any(|k| k.starts_with(prefix)))
        }
    }

    const P: &str = "notes/";
    const AUD: &str = "0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa";
    const AUD2: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const A: &str = "acct_0e64d1897f10b32d3a1bc84e";
    const A2: &str = "acct_99aa11bb22cc33dd44ee55ff";
    const W: &str = "wallet_0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025";
    const W2: &str = "wallet_0x1111111111111111111111111111111111111111";
    const SECRET: &str = "link-secret-0f1e2d3c4b5a69788796a5b4c3d2e1f0";

    fn key() -> LinkKey {
        LinkKey::from_secret(SECRET).unwrap()
    }
    fn ctx<'a>(k: &'a LinkKey) -> Ctx<'a> {
        Ctx { key: k, aud: AUD, bucket: "agent-notes", prefix: P }
    }

    #[test]
    fn a_fresh_link_resolves_and_survives_a_restart_with_the_same_key() {
        let m = Mem::new(true);
        let k = key();
        assert_eq!(resolve(&m, Some(&ctx(&k)), W).unwrap(), None);
        create(&m, &ctx(&k), A, W, 1).unwrap();
        assert_eq!(resolve(&m, Some(&ctx(&k)), W).unwrap().as_deref(), Some(A));
        // a restart: the key re-derived from the same secret, nothing else carried over
        let k2 = LinkKey::from_secret(SECRET).unwrap();
        assert_eq!(resolve(&m, Some(&ctx(&k2)), W).unwrap().as_deref(), Some(A));
        // replay of the same link: nothing rewritten
        let before = m.objects.borrow().clone();
        create(&m, &ctx(&k), A, W, 2).unwrap();
        assert_eq!(*m.objects.borrow(), before);
    }

    #[test]
    fn the_storage_operator_cannot_forge_a_link() {
        let k = key();
        let c = ctx(&k);
        let forged = |m: &Mem, wb: Vec<u8>, ab: Vec<u8>| {
            m.put(&wallet_key(P, W), wb);
            m.put(&account_key(P, A), ab);
            resolve(m, Some(&c), W).unwrap()
        };
        // both reciprocal records, in the old unsigned format
        let v1 = |a: &str, w: &str| serde_json::json!({ "v": 1, "account": a, "wallet": w, "aud": AUD, "at": 1 }).to_string().into_bytes();
        assert_eq!(forged(&Mem::new(true), v1(A, W), v1(A, W)), None, "legacy unsigned maps authorize nothing");
        // v2 shape with a made-up MAC
        let fake = |dir: &str| serde_json::json!({ "v": 2, "dir": dir, "account": A, "wallet": W, "aud": AUD, "at": 1, "mac": "00".repeat(32) }).to_string().into_bytes();
        assert_eq!(forged(&Mem::new(true), fake("wallet"), fake("account")), None);
        // properly MAC'd, but under a key the operator chose
        let other = LinkKey::from_secret("the-operators-own-secret-0123456789").unwrap();
        let oc = Ctx { key: &other, aud: AUD, bucket: "agent-notes", prefix: P };
        assert_eq!(forged(&Mem::new(true), record(&oc, Dir::Wallet, A, W, 1), record(&oc, Dir::Account, A, W, 1)), None);
        // a malformed MAC
        let mut bad: serde_json::Value = serde_json::from_slice(&record(&c, Dir::Wallet, A, W, 1)).unwrap();
        bad["mac"] = serde_json::json!("not hex");
        assert_eq!(forged(&Mem::new(true), bad.to_string().into_bytes(), record(&c, Dir::Account, A, W, 1)), None);
        // and with NO link key configured, even authentic records link nothing
        let m = Mem::new(true);
        create(&m, &c, A, W, 1).unwrap();
        assert_eq!(resolve(&m, None, W).unwrap(), None);
    }

    #[test]
    fn records_are_bound_to_deployment_bucket_prefix_direction_and_both_identities() {
        let k = key();
        let c = ctx(&k);
        let m = Mem::new(true);
        create(&m, &c, A, W, 1).unwrap();
        let wb = m.get(&wallet_key(P, W)).unwrap().unwrap().0;
        let ab = m.get(&account_key(P, A)).unwrap().unwrap().0;
        // another deployment with the same key, another bucket, another prefix
        assert_eq!(resolve(&m, Some(&Ctx { key: &k, aud: AUD2, bucket: "agent-notes", prefix: P }), W).unwrap(), None);
        assert_eq!(resolve(&m, Some(&Ctx { key: &k, aud: AUD, bucket: "other-bucket", prefix: P }), W).unwrap(), None);
        let m2 = Mem::new(true);
        m2.put(&wallet_key("team/", W), wb.clone());
        m2.put(&account_key("team/", A), ab.clone());
        assert_eq!(resolve(&m2, Some(&Ctx { key: &k, aud: AUD, bucket: "agent-notes", prefix: "team/" }), W).unwrap(), None, "copied to another prefix");
        // the records swapped into each other's direction
        let m3 = Mem::new(true);
        m3.put(&wallet_key(P, W), ab.clone());
        m3.put(&account_key(P, A), wb.clone());
        assert_eq!(resolve(&m3, Some(&c), W).unwrap(), None);
        // W's valid records placed at W2's path: they still name W, so W2 gets nothing,
        // and the copy cannot block W2 from linking for real
        let m4 = Mem::new(true);
        m4.put(&wallet_key(P, W2), wb.clone());
        m4.put(&account_key(P, A), ab.clone());
        assert_eq!(resolve(&m4, Some(&c), W2).unwrap(), None);
        create(&m4, &c, A2, W2, 2).unwrap();
        assert_eq!(resolve(&m4, Some(&c), W2).unwrap().as_deref(), Some(A2));
        // either identity edited inside an authentic record
        for (field, val) in [("account", A2), ("wallet", W2)] {
            let m5 = Mem::new(true);
            let mut x: serde_json::Value = serde_json::from_slice(&wb).unwrap();
            x[field] = serde_json::json!(val);
            m5.put(&wallet_key(P, W), x.to_string().into_bytes());
            m5.put(&account_key(P, A), ab.clone());
            m5.put(&account_key(P, A2), ab.clone());
            assert_eq!(resolve(&m5, Some(&c), W).unwrap(), None, "{field}");
        }
    }

    #[test]
    fn a_key_change_makes_old_links_inert_and_they_can_be_made_again() {
        let m = Mem::new(true);
        let k1 = key();
        create(&m, &ctx(&k1), A, W, 1).unwrap();
        let k2 = LinkKey::from_secret("a-rotated-link-secret-0123456789abcdef").unwrap();
        assert_eq!(resolve(&m, Some(&ctx(&k2)), W).unwrap(), None, "a key mismatch refuses");
        // the old records are not an authority under the new key: replaced by CAS, not blocked
        create(&m, &ctx(&k2), A, W, 2).unwrap();
        assert_eq!(resolve(&m, Some(&ctx(&k2)), W).unwrap().as_deref(), Some(A));
        assert_eq!(resolve(&m, Some(&ctx(&k1)), W).unwrap(), None);
        assert!(LinkKey::from_secret("short").is_none());
    }

    #[test]
    fn no_relink_and_no_collision_either_side_and_no_deletes() {
        let m = Mem::new(true);
        let k = key();
        let c = ctx(&k);
        create(&m, &c, A, W, 1).unwrap();
        let before = m.objects.borrow().clone();
        assert_eq!(create(&m, &c, A2, W, 2).unwrap_err().0, 409);
        assert_eq!(create(&m, &c, A, W2, 3).unwrap_err().0, 409);
        assert_eq!(*m.objects.borrow(), before, "a refused link writes nothing, and nothing is deleted");
        assert_eq!(resolve(&m, Some(&c), W).unwrap().as_deref(), Some(A));
        assert_eq!(resolve(&m, Some(&c), W2).unwrap(), None);
    }

    #[test]
    fn a_wallet_with_notes_of_its_own_is_not_hidden() {
        let m = Mem::new(true);
        let k = key();
        m.put(&format!("{P}users/{W}/todo.md"), b"mine".to_vec());
        assert_eq!(create(&m, &ctx(&k), A, W, 1).unwrap_err().0, 409);
        assert_eq!(resolve(&m, Some(&ctx(&k)), W).unwrap(), None);
    }

    #[test]
    fn an_interrupted_link_is_inert_then_completed_or_replaced_never_deleted() {
        let k = key();
        let c = ctx(&k);
        // the wallet record lands, the account record does not
        let m = Mem::new(true);
        *m.fail_after.borrow_mut() = Some(1);
        assert_eq!(create(&m, &c, A, W, 1).unwrap_err().0, 502);
        assert!(m.get(&wallet_key(P, W)).unwrap().is_some());
        assert_eq!(resolve(&m, Some(&c), W).unwrap(), None, "one record alone links nothing");
        *m.fail_after.borrow_mut() = None;
        create(&m, &c, A, W, 2).unwrap();
        assert_eq!(resolve(&m, Some(&c), W).unwrap().as_deref(), Some(A));
        // or: the same wallet later links a DIFFERENT account - the inert half is
        // replaced at its exact ETag, not deleted
        let m = Mem::new(true);
        *m.fail_after.borrow_mut() = Some(1);
        let _ = create(&m, &c, A, W, 1);
        *m.fail_after.borrow_mut() = None;
        create(&m, &c, A2, W, 2).unwrap();
        assert_eq!(resolve(&m, Some(&c), W).unwrap().as_deref(), Some(A2));
    }

    #[test]
    fn a_change_between_judging_and_writing_loses_the_write() {
        let k = key();
        let c = ctx(&k);
        let m = Mem::new(true);
        // an unauthentic object sits in the wallet slot; someone rewrites it
        // between our judgement and our compare-and-swap
        m.put(&wallet_key(P, W), b"planted".to_vec());
        *m.race_on.borrow_mut() = Some(wallet_key(P, W));
        assert_eq!(create(&m, &c, A, W, 1).unwrap_err().0, 409);
        assert_eq!(m.get(&wallet_key(P, W)).unwrap().unwrap().0, b"planted".to_vec(), "the racer's version stands");
        assert!(m.get(&account_key(P, A)).unwrap().is_none());
        assert_eq!(resolve(&m, Some(&c), W).unwrap(), None);
    }

    #[test]
    fn a_store_that_ignores_conditions_still_refuses_a_relink() {
        let m = Mem::new(false);
        let k = key();
        let c = ctx(&k);
        create(&m, &c, A, W, 1).unwrap();
        assert_eq!(create(&m, &c, A2, W, 2).unwrap_err().0, 409);
        assert_eq!(create(&m, &c, A, W2, 3).unwrap_err().0, 409);
        assert_eq!(resolve(&m, Some(&c), W).unwrap().as_deref(), Some(A));
    }
}

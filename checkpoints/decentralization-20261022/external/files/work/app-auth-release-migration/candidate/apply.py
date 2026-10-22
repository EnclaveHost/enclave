#!/usr/bin/env python3
# Applies the EAB1 migration candidate to an enclave-apps tree (default: the current directory): eyesoff-ai and jot.
# Each edit anchors on exact text and refuses (exit 1) when an anchor is missing or not unique - a moved file is reported,
# never half-patched. Copies candidate/eab1.rs into both crates. wallet.rs is not touched.
#   python3 apply.py [ROOT] [--only eyesoff|jot]
import os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))

EYESOFF_DOC = '''## Carrying an existing account across the issuer's retirement (EAB1, candidate)

The design is `work/app-auth-release-migration/PROTOCOL-EAB1.md`, with `eab1.rs` (shared with jot) as the verifier.

**Why it is needed.** An Enclave account id is random. Which wallets and passkeys own it is recorded only in the relay's
account store, and an EST1 names none of them. After the issuer retires, nothing public ties an old account to anyone.

**The issuer's one act, at cutover.**
- It commits every account's credentials into a Merkle tree of per-account SALTED leaves.
- The platform key, the `sso.signer` deployments already pin, signs the root.
- Owners pin the statement as `migration` and set `sso.until`.
- Each account holder receives a private migration file.

**Using the file.** The file is an account proof here (`EAB1.<base64url(file)>`), beside EST1 and EAK1, in
`/auth/link/challenge` and `/auth/link`. The wallet that signs must be one the account committed. It is checked at the
challenge and again on the PROVEN signer at the link, and it may be an EOA, a deployed or a counterfactual contract
wallet. The result is the ordinary ELK1: the wallet acts as the account, with its existing API key. No issuer is
involved.

**What a former issuer can do after cutover.** Nothing: a new binding is a different root, and `sso.until` ends every
EST1 by this deployment's own clock.

**Passkey-only accounts.** Where the owner also pins the address book's passkey-vault factory
(`migration.vault_factory`), a committed passkey proves as the address of its ORIGINAL credit vault
(`EnclaveCreditVault`, `vaultFor(x, y)`, derived here from the file, never taken from the request). The passkey signs
on Enclave's static signer page at the vault's pinned origin (`https://enclave.host/recover/`), where its rpId is
valid. The vault's ERC-1271 answer, wrapped as ERC-6492 while the vault is undeployed, is checked through the same
pinned chain readers. Keys the account later adds to or removes from its vault on chain count from then on.

**What is not covered.**
- An account that committed no credential at all (reported at cutover, not in the snapshot).
- The file must reach its holder before retirement, or later through the operator's custodial archive.
'''

JOT_DOC = '''## Restoring an account after the issuer's retirement (EAB1, candidate)

**Why.** An account that never linked a wallet while Enclave's issuer existed would otherwise lose its notebook. The
design is `work/app-auth-release-migration/PROTOCOL-EAB1.md`, with `src/eab1.rs` as the verifier.

**What the owner pins.** The issuer's cutover snapshot (`migration`), with `sso.until` set to the cutover.

**What the user does.** A holder of the account's migration file uses *Restore an account…*. A wallet the account had at
cutover signs the link (EOA, deployed or counterfactual contract wallet; in the browser or by hand). The wallet then
opens the account's existing sealed notebook. Nothing is moved or re-sealed, and no issuer is involved.

**Passkey-only accounts.** With `migration.vault_factory` pinned too (the address book's passkey-vault factory and its
implementation), a passkey the file commits signs as its original credit vault's address, on Enclave's static signer
page (`https://enclave.host/recover/`, the vault's pinned origin). The page shows the address to enter here and signs
the message this page shows, by hand. The vault's ERC-1271 / ERC-6492 answer is checked through the pinned chain
readers, so keys later added to or removed from the vault on chain count from then on.

**What is refused.**
- A wallet the file does not commit, including a link message such a wallet built and signed itself.
- A corrupted or forged file.
- A snapshot this notebook does not pin.
- Any EST1 after `sso.until`.
- The usual link refusals (a linked account, a wallet with notes of its own).
'''


EYESOFF = {
'src/lib.rs': [
 ("mod apikey;\n", "mod apikey;\nmod eab1;\n"),
 # the challenge: an EAB1 migration file is an account proof of its own, checked against the pinned snapshot AND the
 # address that will sign (it must be one the account committed at cutover)
 ('''    let cred = field("account");
    let account = match verify_account_proof(&base, &cred) {
        Ok(a) => a,
        Err(e) => return json_err(out, 401, &e),
    };
    let now = (now_ms() / 1000) as u64;
    match wallet::link_challenge(''', '''    let cred = field("account");
    let proven = if cred.starts_with(eab1::PREFIX) {
        migration_account(&base, &cred, Some(&field("address")))
    } else {
        verify_account_proof(&base, &cred)
    };
    let account = match proven {
        Ok(a) => a,
        Err(e) => return json_err(out, 401, &e),
    };
    let now = (now_ms() / 1000) as u64;
    match wallet::link_challenge('''),
 ('''    let cred = field("account");
    let account = match verify_account_proof(&base, &cred) {
        Ok(a) => a,
        Err(e) => return json_err(out, 401, &e),
    };
    let act = wallet::Act::Link { account: &account, proof: wallet::proof_hash(&cred) };
    let claims = match wallet_verify(w, &field("wallet"), act) {
        Ok(c) => c,
        Err(e) => return json_err(out, 401, &e),
    };''', '''    let cred = field("account");
    let migrating = cred.starts_with(eab1::PREFIX);
    let proven = if migrating { migration_account(&base, &cred, None) } else { verify_account_proof(&base, &cred) };
    let account = match proven {
        Ok(a) => a,
        Err(e) => return json_err(out, 401, &e),
    };
    let act = wallet::Act::Link { account: &account, proof: wallet::proof_hash(&cred) };
    let claims = match wallet_verify(w, &field("wallet"), act) {
        Ok(c) => c,
        Err(e) => return json_err(out, 401, &e),
    };
    // a migration file links only a wallet it committed: the signature above proves this wallet, this proves the binding
    if migrating {
        if let Err(e) = migration_account(&base, &cred, Some(&claims.address)) {
            return json_err(out, 401, &e);
        }
    }'''),
 ('''/// The account a wallet sign-in acts as here: its own wallet identity, or -''', '''/// The ACCOUNT an EAB1 account-migration file proves (eab1.rs): checked against the cutover snapshot this deployment's
/// owner pinned (`migration`), with no issuer. With `wallet`, that wallet must also be one the account committed at
/// cutover; the caller still requires that wallet's own fresh link signature over this exact file.
fn migration_account(cfg: &AppConfig, cred: &str, wallet: Option<&str>) -> Result<String, String> {
    let pin = cfg.migration.as_ref().ok_or("this deployment honours no account migration snapshot (its config pins no `migration`)")?;
    match wallet {
        Some(w) => eab1::account_for(pin, cred, w),
        None => eab1::open(pin, cred).map(|b| b.account),
    }
}

/// The account a wallet sign-in acts as here: its own wallet identity, or -'''),
 ('''                                          // an Enclave account can be linked to a wallet here
                                          "link": c.map_or(false, |c| c.key_seed().is_some()) });''', '''                                          // an Enclave account can be linked to a wallet here
                                          "link": c.map_or(false, |c| c.key_seed().is_some()),
                                          // ...and restored from its migration file, with no issuer
                                          "migration": c.and_then(|c| c.migration.as_ref()).map(|p| p.cutover.clone()) });'''),
 ('''    let mut b = serde_json::json!({
        "enabled": true,
        "required": sign_in_required(sso_cfg, wallet_cfg),
        "sso": sso_cfg.is_some(),''', '''    // after its cutover (`sso.until`) the issuer is not offered: its sign-in would open nothing here
    let now = (now_ms() / 1000) as u64;
    let sso_live = sso_cfg.filter(|s| s.until.map_or(true, |u| now < u));
    let mut b = serde_json::json!({
        "enabled": true,
        "required": sign_in_required(sso_cfg, wallet_cfg),
        "sso": sso_live.is_some(),'''),
 ('''    if let Some(s) = sso_cfg {
        b["authorize_url"] = serde_json::json!(s.authorize_url);''', '''    if let Some(s) = sso_live {
        b["authorize_url"] = serde_json::json!(s.authorize_url);'''),
],
'src/config.rs': [
 ('''    #[serde(default, deserialize_with = "wallet_block")]
    pub wallet: Option<crate::wallet::WalletConfig>,''', '''    #[serde(default, deserialize_with = "wallet_block")]
    pub wallet: Option<crate::wallet::WalletConfig>,
    /// ACCOUNT MIGRATION (eab1.rs): the issuer's cutover snapshot of every Enclave account's credentials, as the owner
    /// pinned it ({cutover, root, leaves[, accounts, issued_at, signer, signature]}). With it, an account's migration
    /// file plus a fresh signature from a wallet that account had at cutover links that wallet to the account here -
    /// with no issuer. Without it, migration files open nothing.
    #[serde(default, deserialize_with = "migration_block")]
    pub migration: Option<crate::eab1::Pin>,'''),
 ('''/// wallet.rs parses its own block (the file is shared with crates that have''', '''/// eab1.rs parses its own block; a malformed one fails the whole config, loudly.
fn migration_block<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<crate::eab1::Pin>, D::Error> {
    match Option::<serde_json::Value>::deserialize(d)? {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => crate::eab1::Pin::parse(&v).map(Some).map_err(serde::de::Error::custom),
    }
}

/// wallet.rs parses its own block (the file is shared with crates that have'''),
],
'src/sso.rs': [
 ('''    /// tolerated clock drift on `iat`, seconds
    #[serde(default = "default_skew")]
    pub skew_secs: u64,
}''', '''    /// tolerated clock drift on `iat`, seconds
    #[serde(default = "default_skew")]
    pub skew_secs: u64,
    /// CUTOVER (unix seconds): from this moment no EST1 counts here, whatever it says about itself - an issuer can mint
    /// any `iat`, so only the deployment's own clock can end its authority. Set it ahead of the issuer's retirement.
    #[serde(default)]
    pub until: Option<u64>,
}'''),
 ('''pub fn verify(cfg: &SsoConfig, token: &str, now_secs: u64) -> Result<Claims, String> {
    let rest = token.strip_prefix("EST1.").ok_or("not an Enclave sign-in token")?;''', '''pub fn verify(cfg: &SsoConfig, token: &str, now_secs: u64) -> Result<Claims, String> {
    let rest = token.strip_prefix("EST1.").ok_or("not an Enclave sign-in token")?;
    if cfg.until.is_some_and(|u| now_secs >= u) {
        return Err("Sign in with Enclave has ended for this deployment: sign in with your wallet".into());
    }'''),
 ('''            required: true,
            skew_secs: 300,
        }''', '''            required: true,
            skew_secs: 300,
            until: None,
        }'''),
],
'PLATFORM-sso.md': [(None, EYESOFF_DOC)],
'src/chat.html': [
 ('''        <p class="api-fine">For a wallet that is not in this browser: a passkey account (sign on the dashboard that
        holds its passkeys), a Safe, a hardware or command-line wallet. A contract account, deployed or not yet
        deployed, is checked on chain only where this deployment's owner pinned chain readers.</p>''', '''        <p class="api-fine">For a wallet that is not in this browser: a passkey account (sign on the dashboard that
        holds its passkeys; for an Enclave passkey restored from a migration file, at https://enclave.host/recover/,
        which shows the address to give here), a Safe, a hardware or command-line wallet. A contract account,
        deployed or not yet deployed, is checked on chain only where this deployment's owner pinned chain
        readers.</p>'''),
 ('''        <p class="api-fine" id="linkNote" hidden></p>''', '''        <p class="api-fine" id="migrateRow" hidden>Have an account migration file from Enclave? <a href="#" id="migrateGo">Restore
        your account with it</a> (or <a href="#" id="migrateOther">with another signer</a>): a wallet or passkey the
        account had at the cutover signs, and it acts as that account here from then on, with no Enclave sign-in.
        <input type="file" id="migrateFile" accept=".json,application/json" hidden></p>
        <p class="api-fine" id="linkNote" hidden></p>'''),
 ('''  $("linkSec").hidden = !(w && w.link);''', '''  $("linkSec").hidden = !(w && w.link);
  $("migrateRow").hidden = !(w && w.link && w.migration);'''),
 ('''async function linkStart(how) {
  const w = state.auth.wallet;
  if (!w || !w.link) return;
  const c = ssoToken && !ssoToken.startsWith("EWS1.") ? ssoClaims(ssoToken) : null;
  let cred = null;
  if (c && Date.now() / 1000 - c.iat < 540) cred = ssoToken;''', '''// given: an account proof chosen by the caller (an EAB1 migration file), instead of the session or the API key
async function linkStart(how, given) {
  const w = state.auth.wallet;
  if (!w || !w.link) return;
  const c = ssoToken && !ssoToken.startsWith("EWS1.") ? ssoClaims(ssoToken) : null;
  let cred = given || null;
  if (cred) {}
  else if (c && Date.now() / 1000 - c.iat < 540) cred = ssoToken;'''),
 ('''$("linkOther").addEventListener("click", (e) => { e.preventDefault(); linkStart("hand"); });''', '''$("linkOther").addEventListener("click", (e) => { e.preventDefault(); linkStart("hand"); });
// Restoring from a migration file: the file is the account proof (checked by the enclave against the snapshot its owner
// pinned); a wallet the account had at cutover signs the link, as for any link.
let migrateHow;
$("migrateGo").addEventListener("click", (e) => { e.preventDefault(); migrateHow = undefined; $("migrateFile").click(); });
$("migrateOther").addEventListener("click", (e) => { e.preventDefault(); migrateHow = "hand"; $("migrateFile").click(); });
$("migrateFile").addEventListener("change", async () => {
  const f = $("migrateFile").files && $("migrateFile").files[0];
  $("migrateFile").value = "";
  if (!f) return;
  const text = (await f.text()).trim();
  let j = null;
  try { j = JSON.parse(text); } catch (_) {}
  if (!j || j.kind !== "EAB1-bundle") { linkNote("That is not an Enclave account migration file."); return; }
  // a passkey-only account signs by hand, on Enclave's passkey signer page (its passkey works only there)
  const wallets = (j.credentials || []).filter((c) => c.kind === "wallet").length;
  linkStart(wallets ? migrateHow : "hand", "EAB1." + b64url(new TextEncoder().encode(text)));
});'''),
],
}

JOT = {
'src/lib.rs': [
 ("mod crypt;\n", "mod crypt;\nmod eab1;\n"),
 ('''    wallet: Option<wallet::WalletConfig>,''', '''    wallet: Option<wallet::WalletConfig>,
    /// ACCOUNT MIGRATION (eab1.rs): the issuer's cutover snapshot as the owner pinned it. With it (and links on), an
    /// account's migration file plus a fresh link signature from a wallet that account had at cutover links the wallet
    /// to the account's notebook - no Enclave sign-in needed.
    migration: Option<eab1::Pin>,''', 1),
 ('''    let master_key = Some(s("master_key")).filter(|k| !k.is_empty());''', '''    let migration = match v.get("migration") {
        None | Some(serde_json::Value::Null) => None,
        Some(m) => match eab1::Pin::parse(m) {
            Ok(p) => Some(p),
            Err(e) => {
                error.get_or_insert(format!("configuration error: {e}"));
                None
            }
        },
    };
    let master_key = Some(s("master_key")).filter(|k| !k.is_empty());'''),
 ('''        sso,
        wallet,
        master_key,''', '''        sso,
        wallet,
        migration,
        master_key,'''),
 ('''/// POST /api/link/challenge {address, nonce} with X-Sso-Token: a fresh
/// Enclave sign-in - the EIP-4361 message the wallet signs to link it.
fn handle_link_challenge(out: ResponseOutparam, cfg: &Config, req: &IncomingRequest, body: &[u8]) {
    let now = now_secs();
    let (account, tok) = match account_proof(cfg, req, now) {
        Ok(x) => x,
        Err((st, e)) => return json_err(out, st, &e),
    };
    let w = cfg.wallet.as_ref().expect("account_proof checked the wallet block");
    // refuse before anyone signs anything a link could not be recorded for
    if link_ctx(cfg).is_none() {
        return json_err(out, 404, &format!("account links are {}", cfg.link_key_source));
    }
    let b: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let f = |k: &str| b.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();''', '''/// The ACCOUNT side of a link, from the request: an EAB1 migration file in the body's `account` (eab1.rs), checked
/// against the snapshot this notebook's owner pinned - no issuer - and, with `wallet`, that this wallet is one the
/// account committed at cutover; otherwise a fresh Enclave sign-in in X-Sso-Token. Returns (account, the proof as
/// presented), the proof the wallet's link signature must name.
fn link_account(cfg: &Config, req: &IncomingRequest, b: &serde_json::Value, now: u64, wallet: Option<&str>) -> Result<(String, String), (u16, String)> {
    let cred = b.get("account").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if !cred.starts_with(eab1::PREFIX) {
        return account_proof(cfg, req, now);
    }
    let (Some(pin), Some(_)) = (&cfg.migration, &cfg.wallet) else {
        return Err((404, "this notebook honours no account migration snapshot (its config pins no `migration`)".into()));
    };
    let account = match wallet {
        Some(w) => eab1::account_for(pin, &cred, w),
        None => eab1::open(pin, &cred).map(|x| x.account),
    }
    .map_err(|e| (401, e))?;
    Ok((account, cred))
}

/// POST /api/link/challenge {address, nonce[, account: EAB1 migration file]} with X-Sso-Token (a fresh Enclave
/// sign-in) or the migration file - the EIP-4361 message the wallet signs to link it.
fn handle_link_challenge(out: ResponseOutparam, cfg: &Config, req: &IncomingRequest, body: &[u8]) {
    let now = now_secs();
    let b: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let f = |k: &str| b.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let (account, tok) = match link_account(cfg, req, &b, now, Some(&f("address"))) {
        Ok(x) => x,
        Err((st, e)) => return json_err(out, st, &e),
    };
    let w = cfg.wallet.as_ref().expect("link_account checked the wallet block");
    // refuse before anyone signs anything a link could not be recorded for
    if link_ctx(cfg).is_none() {
        return json_err(out, 404, &format!("account links are {}", cfg.link_key_source));
    }'''),
 ('''fn handle_link(out: ResponseOutparam, cfg: &Config, req: &IncomingRequest, body: &[u8]) {
    let now = now_secs();
    let (account, tok) = match account_proof(cfg, req, now) {
        Ok(x) => x,
        Err((st, e)) => return json_err(out, st, &e),
    };
    let w = cfg.wallet.as_ref().expect("account_proof checked the wallet block");
    let b: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let wtok = b.get("wallet").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let act = wallet::Act::Link { account: &account, proof: wallet::proof_hash(&tok) };
    let claims = match wallet_verify(w, &wtok, now, act) {
        Ok(c) => c,
        Err(e) => return json_err(out, 401, &e),
    };''', '''fn handle_link(out: ResponseOutparam, cfg: &Config, req: &IncomingRequest, body: &[u8]) {
    let now = now_secs();
    let b: serde_json::Value = serde_json::from_slice(body).unwrap_or(serde_json::Value::Null);
    let (account, tok) = match link_account(cfg, req, &b, now, None) {
        Ok(x) => x,
        Err((st, e)) => return json_err(out, st, &e),
    };
    let w = cfg.wallet.as_ref().expect("link_account checked the wallet block");
    let wtok = b.get("wallet").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let act = wallet::Act::Link { account: &account, proof: wallet::proof_hash(&tok) };
    let claims = match wallet_verify(w, &wtok, now, act) {
        Ok(c) => c,
        Err(e) => return json_err(out, 401, &e),
    };
    // a migration file links only a wallet it committed: the signature above proves this wallet, this proves the binding
    if tok.starts_with(eab1::PREFIX) {
        if let Err((st, e)) = link_account(cfg, req, &b, now, Some(&claims.address)) {
            return json_err(out, st, &e);
        }
    }'''),
 ('''    if let Some(sc) = &cfg.sso {
        // public facts the UI needs before anyone is signed in''', '''    // after its cutover (`sso.until`) the issuer is not offered: its sign-in would open nothing here
    let sso_live = cfg.sso.as_ref().filter(|s| s.until.map_or(true, |u| now_secs() < u));
    if let Some(sc) = sso_live {
        // public facts the UI needs before anyone is signed in'''),
 ('''                                          "link": cfg.sso.is_some() && cfg.link_key.is_some(),''', '''                                          "link": sso_live.is_some() && cfg.link_key.is_some(),
                                          // an Enclave account can be restored from its migration file here, no issuer
                                          "migration": cfg.migration.as_ref().filter(|_| cfg.link_key.is_some()).map(|p| p.cutover.clone()),'''),
],
'src/sso.rs': [
 ('''    /// tolerated clock drift on `iat`, seconds
    pub skew_secs: u64,
}''', '''    /// tolerated clock drift on `iat`, seconds
    pub skew_secs: u64,
    /// CUTOVER (unix seconds): from this moment no EST1 counts here, whatever it says about itself - an issuer can mint
    /// any `iat`, so only the deployment's own clock can end its authority. Set it ahead of the issuer's retirement.
    pub until: Option<u64>,
}'''),
 ('''        let skew_secs = s.get("skew_secs").and_then(|x| x.as_u64()).unwrap_or(300);
        Ok(Some(SsoConfig { signer, audience, accept, authorize_url, skew_secs }))''', '''        let skew_secs = s.get("skew_secs").and_then(|x| x.as_u64()).unwrap_or(300);
        let until = match s.get("until") {
            None | Some(serde_json::Value::Null) => None,
            Some(u) => Some(u.as_u64().ok_or("sso.until must be unix seconds")?),
        };
        Ok(Some(SsoConfig { signer, audience, accept, authorize_url, skew_secs, until }))'''),
 ('''pub fn verify(cfg: &SsoConfig, token: &str, now_secs: u64) -> Result<Claims, String> {
    let rest = token.strip_prefix("EST1.").ok_or("not an Enclave sign-in token")?;''', '''pub fn verify(cfg: &SsoConfig, token: &str, now_secs: u64) -> Result<Claims, String> {
    let rest = token.strip_prefix("EST1.").ok_or("not an Enclave sign-in token")?;
    if cfg.until.is_some_and(|u| now_secs >= u) {
        return Err("Sign in with Enclave has ended for this notebook: sign in with your wallet".into());
    }'''),
 ('''            authorize_url: "https://enclave.host/sso/authorize".into(),
            skew_secs: 300,
        }''', '''            authorize_url: "https://enclave.host/sso/authorize".into(),
            skew_secs: 300,
            until: None,
        }'''),
],
'README.md': [(None, JOT_DOC)],
'src/index.html': [
 ('''    <p class="meta">For a wallet that is not in this browser: a passkey account (sign on the dashboard that holds its
    passkeys), a Safe,''', '''    <p class="meta">For a wallet that is not in this browser: a passkey account (sign on the dashboard that holds its
    passkeys; for an Enclave passkey restored from a migration file, at https://enclave.host/recover/, which shows the
    address to enter here), a Safe,'''),
 ('''    <button class="ghost" id="linkhandbtn" hidden title="Link a wallet that is not in this browser">Link another signer…</button>''', '''    <button class="ghost" id="linkhandbtn" hidden title="Link a wallet that is not in this browser">Link another signer…</button>
    <button class="ghost" id="restorebtn" hidden title="Restore an Enclave account's notebook from its migration file: a wallet or passkey the account had at the cutover signs">Restore an account…</button>
    <input type="file" id="restorefile" accept=".json,application/json" hidden>'''),
 ('''async function linkStart(how) {
  $("#ssoerr").textContent = "";
  const c = ssoToken && !ssoToken.startsWith("EWS1.") ? ssoClaims(ssoToken) : null;
  if (!c) return;
  if (Date.now() / 1000 - c.iat > 540) {''', '''// given: an EAB1 migration file (the account proof), instead of a fresh Enclave sign-in
async function linkStart(how, given) {
  $("#ssoerr").textContent = "";
  const c = ssoToken && !ssoToken.startsWith("EWS1.") ? ssoClaims(ssoToken) : null;
  if (!c && !given) return;
  if (!given && Date.now() / 1000 - c.iat > 540) {'''),
 ('''    const d = await api("POST", "/api/link/challenge", { address, nonce });
    const lines = d.message.split("\\n");
    if (lines[0] !== location.host + " wants you to sign in with your Ethereum account:" ||
        lines[1].toLowerCase() !== String(address).toLowerCase() || !d.message.includes("\\nNonce: " + nonce) ||
        !d.message.includes("\\n- urn:enclave:link:account:" + c.sub + "\\n") ||
        !lines[3].startsWith("Link the Enclave account " + c.sub + " to this wallet"))''', '''    const d = await api("POST", "/api/link/challenge", given ? { address, nonce, account: given } : { address, nonce });
    const acct = given ? d.account : c.sub;
    const lines = d.message.split("\\n");
    if (lines[0] !== location.host + " wants you to sign in with your Ethereum account:" ||
        lines[1].toLowerCase() !== String(address).toLowerCase() || !d.message.includes("\\nNonce: " + nonce) ||
        !d.message.includes("\\n- urn:enclave:link:account:" + acct + "\\n") ||
        !lines[3].startsWith("Link the Enclave account " + acct + " to this wallet"))'''),
 ('''    const r = await api("POST", "/api/link", { wallet: "EWS1." + b64u(bytes) + "." + b64u(Uint8Array.from(sig.slice(2).match(/../g), (x) => parseInt(x, 16))) });''', '''    const wtok = "EWS1." + b64u(bytes) + "." + b64u(Uint8Array.from(sig.slice(2).match(/../g), (x) => parseInt(x, 16)));
    const r = await api("POST", "/api/link", given ? { wallet: wtok, account: given } : { wallet: wtok });'''),
 ('''  $("#linkhandbtn").hidden = $("#linkbtn").hidden;''', '''  $("#linkhandbtn").hidden = $("#linkbtn").hidden;
  $("#restorebtn").hidden = !(status.wallet && status.wallet.migration);'''),
 ('''$("#linkhandbtn").addEventListener("click", () => linkStart("hand"));''', '''$("#linkhandbtn").addEventListener("click", () => linkStart("hand"));
// Restoring from a migration file: the file is the account proof (checked in the enclave against the snapshot the owner
// pinned); a wallet the account had at cutover signs the link - in this browser, or by hand when it is not here.
$("#restorebtn").addEventListener("click", () => $("#restorefile").click());
$("#restorefile").addEventListener("change", async () => {
  const f = $("#restorefile").files && $("#restorefile").files[0];
  $("#restorefile").value = "";
  if (!f) return;
  const text = (await f.text()).trim();
  let j = null;
  try { j = JSON.parse(text); } catch (e) {}
  if (!j || j.kind !== "EAB1-bundle") { $("#ssoerr").textContent = "That is not an Enclave account migration file."; return; }
  const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  // a passkey-only account signs by hand, on Enclave's passkey signer page (its passkey works only there)
  const wallets = (j.credentials || []).filter((c) => c.kind === "wallet").length;
  linkStart(window.ethereum && wallets ? undefined : "hand", "EAB1." + b64u(new TextEncoder().encode(text)));
});'''),
],
}

def apply(root, app, edits):
    ok = True
    for rel, reps in edits.items():
        p = os.path.join(root, app, rel)
        s = open(p, encoding='utf-8').read()
        for rep in reps:
            a, b = rep[0], rep[1]
            if a is None:            # append (docs)
                s = s.rstrip('\n') + '\n\n' + b
                continue
            n = s.count(a)
            if n != 1:
                print(f"{app}/{rel}: anchor found {n} times, not patched: {a[:80]!r}"); ok = False; break
            s = s.replace(a, b)
        else:
            open(p, 'w', encoding='utf-8').write(s)
            print(f"{app}/{rel}: patched")
    shutil.copyfile(os.path.join(HERE, 'eab1.rs'), os.path.join(root, app, 'src', 'eab1.rs'))
    print(f"{app}/src/eab1.rs: copied")
    return ok

if __name__ == '__main__':
    argv = sys.argv[1:]; only = None
    if '--only' in argv: i = argv.index('--only'); only = argv[i + 1]; del argv[i:i + 2]
    root = argv[0] if argv else '.'
    todo = {'eyesoff': ('eyesoff-ai', EYESOFF), 'jot': ('jot', JOT)}
    ok = all([apply(root, *todo[k]) for k in ([only] if only else todo)])
    sys.exit(0 if ok else 1)

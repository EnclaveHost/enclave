# EAB1: carrying Enclave accounts across the retirement of the identity server

Version 1 (candidate, 2026-10-19). Implementations:
- `candidate/eab1.rs`: the app-side verifier, shared verbatim by eyesoff-ai and jot.
- `tools/eab1.mjs`: the operator's snapshot builder and the owners' verifier.

The two implementations agree byte for byte through a pinned test vector, checked in each crate's tests.

## 0. Scope under the 2026-10-20 requirements (`work/effective-goal-requirements.txt`)

**What retires and what stays.**
- **Retires:** a SERVER, the relay's account and SSO service, which today must be online for an old account to prove
  itself. The goal is to remove that required centralized dependency.
- **Stays:** Enclave's business AUTHORITY. EAB1 removes no admin power and adds no moderation bypass:
  - the snapshot is signed by Enclave's own platform key;
  - each deployment's owner chooses whether to pin it, through the existing config transaction;
  - Enclave's admin wallet keeps contract administration and version migration, catalog delisting, host bans and
    platform-wide abuse enforcement, exactly as before;
  - an app version Enclave delists, or a host it bans, is delisted or banned whether or not its users migrated.

**What "no issuer afterwards" means.** No identity server needs to stay reachable, and nobody can mint a NEW binding.
It does not mean nobody may administer the platform.

**Retiring the server is optional for owners.** An owner who wants EST1 to keep working while the server still exists
simply leaves `sso.until` unset.

## 1. The problem, from the relay's source

| Fact | Source |
| --- | --- |
| An account id is `acct_` + 24 random hex digits. | `relay/store.js` `rid()`, `randomBytes(12)` |
| An account record is `{id, createdAt, userHandle, wallets[], passkeys[]}`. `wallets` are lowercase addresses (EOAs and contract wallets: the relay's SIWE accepted EIP-1271 and EIP-6492). `passkeys` are WebAuthn credentials on the `enclave.host` RP, with P-256 coordinates `pubX`/`pubY`. | `relay/auth.js` `newAccount`, `addPasskey`, `siweVerify` |
| `byWallet` maps a wallet to exactly one account. A second link is refused (409). | `relay/auth.js` `/v1/account/link/siwe` |
| An EST1 is `{v, sub: acct_…, aud, iat, exp}`. It names no credential. | `relay/sso.js` `mintEst1` |
| Apps key data by `sub`: jot notebooks under `users/<acct>/`, sealed per account; EyesOff API keys derived from `sub`. | the apps |

**Conclusion.** The only place that says which wallet or passkey owns `acct_X` is the relay's account store. Once the
issuer is gone, nothing public can tie an old account to a person. Only two kinds of evidence survive retirement:
- an app's own credential (EyesOff's EAK1);
- a record made from the store BEFORE retirement.

EAB1 is that record, made once, in a form that needs no issuer afterwards.

## 2. Cutover (the one historical act)

**Who acts.** The relay's operator, on the machine that holds the account store, once. The store is never read by
anything else, and no mapping leaves it except inside each account's own bundle.

**Steps.**
1. `eab1.mjs snapshot --accounts accounts.json --cutover <id> --out <dir>`
   - **Salt.** For every account it draws a fresh 32-byte random salt `k_X`.
   - **Leaves.** For each credential `c` of `X` (each wallet; each P-256 passkey as `p256:<x>:<y>:<credId>`):
     ```
     leaf = keccak256(0x00 ‖ "EAB1-leaf" ‖ lp(cutover) ‖ lp(acct_X) ‖ lp(kind) ‖ lp(value) ‖ k_X)      lp = u32 BE length ‖ bytes
     node = keccak256(0x01 ‖ min(a, b) ‖ max(a, b))
     ```
   - **Tree.** Leaves are sorted, pairs hashed as sorted pairs, and an odd node is carried up unchanged. A proof is the
     list of siblings.
   - **Refusals.** An inconsistent store (one wallet under two accounts) is refused.
   - **Outputs.**
     - `statement.json` (public): `{cutover, root, leaves, accounts, issued_at, text}`.
     - `bundles/<acct>.json` (private, 0600, one per account):
       `{v:1, kind:"EAB1-bundle", cutover, root, account, salt, credentials:[{kind, value, path}]}`.
     - `report.json` (private): the ids of accounts with no credential (not committed, §5), and of passkey-only
       accounts (committed; they migrate through their passkey vault, §3a).
2. **Signing.** The platform SSO key, the same key every deployment already pins as `sso.signer`, signs `text` with
   EIP-191 `personal_sign`:
   ```
   EAB1 account binding snapshot
   Cutover: <id>
   Root: 0x<64 hex>
   Leaves: <N>
   Accounts: <M>
   Issued At: <rfc3339>
   ```
   The text never begins `EST1.`, so no EST1 verifier can read it as a sign-in.

   `eab1.mjs attach --signature … --signer …` stores the signature after checking it.
3. **Pinning.** Owners verify (`verify-statement --signer <the sso.signer they pin>`), then add the `migration` block
   (`eab1.mjs config`) and `sso.until` (the cutover time) to each deployment's on-chain config. With
   `--vault-factory <book vaultFactory> --vault-implementation <its implementation()>` the block also pins the passkey
   vault factory (`vault_factory`, §3a). See `ACTIVATION-PLAN.md`.
4. **Delivery.** Each account's bundle reaches its holder privately (§5).

## 3. Using a bundle (no issuer, at any time)

**What the user sends.** The account proof is `EAB1.<base64url(bundle JSON)>`, used exactly where an EST1 or EAK1 account
proof was used before:
- EyesOff: `POST /auth/link/challenge` and `POST /auth/link` (`account`);
- jot: the same two routes, with `account` in the body.

**What the app checks:**
- **Shape.** The bundle is strictly well-formed: known keys only, at most 32 credentials, paths of at most 64 nodes,
  48 KiB at most.
- **Snapshot.** It names the pinned `cutover` and `root`.
- **Every credential.** Each one's leaf, under the bundle's salt, reaches the pinned root. One bad entry refuses the whole
  file.
- **A checkable credential.** The bundle commits at least one wallet, or at least one passkey and the deployment pins
  `vault_factory` (§3a). Otherwise it is refused, naming which: "commits no credential this deployment can check", or
  "commits only passkeys, and this deployment pins no passkey-vault factory".
- **The signer.**
  - At the challenge: the address that will sign is one of the committed wallets, or the vault address DERIVED from a
    committed passkey (§3a).
  - At the link: the wallet's EWS1 `Act::Link` signature names exactly this account and `keccak256` of this exact
    credential (wallet.rs, unchanged: an EOA offline; a deployed or counterfactual contract wallet through the owner's
    pinned reader quorum).
  - Then, again: the PROVEN signer is a committed wallet or derived vault. This catches a link message the caller
    built and signed with another wallet.

**Result:** the app's ordinary link.
- EyesOff: an ELK1, beside that wallet's sessions. The wallet acts as the account, with the account's existing EAK1.
- jot: the MAC'd create-only link records. The wallet opens the account's existing sealed notebook. Nothing is moved,
  copied or re-sealed.

**Afterwards.** The bundle is not needed again. In EyesOff the account's EAK1 can link further wallets, which is how a
holder moves to a new wallet. In jot an account stays linked to the one wallet that linked it, as before EAB1.

## 3a. Passkey-only accounts: the passkey's ORIGINAL credit vault

**Existing contracts, verified.** Every committed passkey `(x, y)` already has an on-chain account address:
`vaultFor(x, y)` of Enclave's original passkey-vault factory, `EnclaveCreditVaultFactory`. The address book's
`vaultFactory` is `0xa891e4396e3eb11f364554043bc18e86da834e91`, with implementation
`0xeca6644333d3a069001203ce5416914a4d830beb`.
- **Source match.** Checked read-only, two public RPCs agreeing at Base block 52856571 (`passkey/match-history.mjs` ->
  `passkey/production-factory.json`). Both runtimes are byte-identical, immutables masked and CBOR metadata included,
  to `contracts/EnclaveCreditVault.sol` at commit `d36100ae` (sha256 `b978896920989146b8928d86e5e74c4aabb71e261b7261c3c29a24ce9f50934c`).
  That source was compiled with the deploy pipeline's settings: solc 0.8.35, optimizer 200, no viaIR.
- **Decoded immutables.** `origin0 = "https://enclave.host"`; `origin1` is unused; there is no recovery admin.
- **The signature rule.** `isValidSignature(hash, abi.encode(WebAuthnSig))` returns the ERC-1271 magic only when:
  - an ACTIVE key of the vault signed a WebAuthn assertion with user presence;
  - its clientDataJSON begins `{"type":"webauthn.get","challenge":"<b64url(hash)>","origin":"https://enclave.host"`.
- **Undeployed vaults.** They verify through ERC-6492: `(factory, createVault(x, y), signature)`.
- **What is needed.** No new contract, no contract change, no deployment, no admin action on chain. A vault stays
  counterfactual until its holder chooses to deploy it, for example to rotate keys.

**What the owner pins in addition.** `migration.vault_factory: {address, implementation}`: the book's `vaultFactory` and
its `implementation()`, from `eab1.mjs config --vault-factory … --vault-implementation …`.

**What the app checks** (`eab1.rs`):
- **The address.** Each committed passkey's vault address is DERIVED: CREATE2 of the EIP-1167 clone of the pinned
  implementation, under the pinned factory, salt `keccak256(abi.encode(x, y))`. It is never taken from the request.
  Shared vector: `vault_for_is_the_factorys_create2_address`, which equals viem `getContractAddress` and the deployed
  factory's own `vaultFor`.
- **The signer.** At the challenge, and again on the PROVEN signer at the link, it must be a committed wallet or one of
  these derived vaults.
- **The signature.** It is verified by the UNCHANGED `wallet.rs`, `4619d6bb…`: the vault's ERC-1271 answer, as ERC-6492
  while the vault is undeployed, through the owner's pinned reader quorum, at the pinned confirmations.

**The WebAuthn RP/origin constraint, and the signer page.**
- **Where the passkeys work.** The relay's passkeys are credentials on rpId `enclave.host`. Only pages of `enclave.host`
  and its subdomains can ask for them.
- **Which origin the vault accepts.** Only `https://enclave.host`. A tenant page on `*.app.enclave.host` can obtain an
  assertion, but its clientDataJSON carries the tenant's origin, so the vault refuses it. That is the vault's own
  anti-phishing rule, and it stays.
- **The signer page.** The passkey therefore signs on a STATIC page at `https://enclave.host/recover/`
  (`passkey/recover/`: `index.html`, `recover.js`, and `recover-config.production.json` served as
  `recover-config.json`). It needs no server, account store or issuer. It uses the site's own `/vendor/aa.js` (viem,
  plus ox `WebAuthnP256`: the passkey signer the dashboard's passkey account already uses).
- **What the page does.**
  - It reads the holder's migration file locally, and shows each committed passkey's vault address.
  - It signs only Sign-In-with-Ethereum text that names an `urn:enclave:deployment` and whose address is that passkey's
    own vault. It never signs a raw digest, so it cannot be used to authorize a vault operation such as `addKey` or a
    refund.
  - It returns `ERC-6492(factory, createVault(x, y), abi.encode(WebAuthnSig))`.
- **What the person does.** They enter the address in the app's existing "another signer" path, and paste the signature
  back. The candidate app UIs send a passkey-only file to that path and name the page.
- **Who serves the page.** The site owner (Enclave) serves it as a static file on its existing site, under the
  platform's normal administration. The origin is fixed in the vault's immutables. That is inherent to WebAuthn: a
  passkey cannot be used outside its RP at all. A holder who wants a credential usable away from `enclave.host` links
  a wallet, as before.

**Rotation and revocation, on the original contract.**
- **Adding a key.** `addKey(x2, y2, deadline, sig)`, signed by an active key at the pinned origin. Once the vault is
  deployed, the new key signs for the account.
- **Removing a key.** `removeKey(keyHash, …)`. The removed key stops working at the next request, including a session it
  had already signed (`wallet.rs` re-asks the readers per request).
- **The last key.** The vault keeps it: it refuses to remove its last key.
- **Deployment.** Deploying (`createVault`) is permissionless and costs gas. Before it, the vault's key set is exactly the
  committed passkey.

**Refused** (`tests/passkey-recovery.mjs`, real browser and EVM):
- a vault derived from a passkey the account never had;
- the account's vault signed by another passkey;
- the account's own passkey asserting from another origin;
- an ERC-6492 wrapper that deploys a different vault;
- a message naming another address (the signer page refuses it);
- a former issuer's new snapshot;
- a post-cutoff EST1;
- a removed key, including its earlier session.

## 4. What each party can and cannot do

| Party | Can | Cannot |
| --- | --- | --- |
| Former issuer, AFTER cutover | nothing EAB1 relies on | add, change or move a binding: any new leaf is under a different root, which no deployment pins. Mint a usable EST1: `sso.until` ends EST1 at every deployment by the deployment's own clock, since an issuer can write any `iat`. |
| Former issuer, AT cutover | put a wrong binding into the snapshot | — This is the one historical trust, the same trust every EST1 it minted already carried. |
| Anyone holding a bundle (a leak) | learn that account's credentials | use it without a fresh signature from a committed wallet |
| App operator / storage | see the bundles presented to it | forge a link: jot's link records stay MAC'd under the app's key, EyesOff's ELK1 is the app's own MAC |
| The public | see the root and counts | learn any account, credential or pairing: leaves are salted per account |
| A tenant app on `*.app.enclave.host`, or a phishing page | ask a holder's passkey for an assertion (same RP) | make it count: the vault accepts only assertions from `https://enclave.host` (§3a) |
| Whoever serves `https://enclave.host/recover/` (the site owner) | refuse or break the page (a passkey-only holder then waits, or uses a wallet linked earlier) | sign as a holder: the page only asks the holder's own authenticator, which shows the prompt |
| A deployment owner | choose which snapshot to pin | bind a wallet to an account EAB1 did not commit. A depot owner still assigns depot users, as always, and can verify a bundle with the tool before doing so. |

## 5. What cannot be recovered without an action before retirement

- **Delivery of the bundle.** It carries the per-account salt that keeps the published tree private, so it must reach
  its holder privately, and only the issuer can deliver it while it knows who holds what.

  Concrete actions, in `ACTIVATION-PLAN.md`:
  - (a) A signed-in download of "your account migration file" on enclave.host before retirement: a relay endpoint
    proposal, not mine to edit.
  - (b) A prompt at every sign-in during the notice period.
  - (c) For bundles never downloaded: the operator keeps the encrypted bundle set offline after retirement, and releases
    a bundle only on a fresh signature from a committed wallet. That custodian can delay or decline. It can never bind:
    the root is pinned. It is a privacy custodian, not an authority.
- **Passkey-only accounts need no pre-retirement action** beyond receiving the file: they migrate through their passkey
  vault (§3a), with no issuer. This needs two things:
  - the owner pins `vault_factory`;
  - the site keeps serving the static signer page at `https://enclave.host/recover/`.

  A passkey cannot be used away from its RP at all, so a holder who wants independence from that one origin links a
  wallet (the relay's existing `/v1/account/link/siwe` before retirement, or the app's own link flows afterwards).
- **Accounts with no credential at all** (`report.json` `no_credential`). Nothing can ever prove them, so they cannot be
  migrated by anyone.
- **Bare-address EST1 subs.** The spec vector predates account subs. Every relay version in the main repository mints
  `acct_` subs, so no such data is expected. If an app holds data under a bare `0x` sub, the operator's mint logs must
  show it; it is out of EAB1 v1's scope and is flagged, not guessed.

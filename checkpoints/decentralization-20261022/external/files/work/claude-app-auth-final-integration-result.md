# App auth without the Enclave issuer: final integration (2026-10-19)

**Status.** Source, builds and component tests in the `enclave-apps` working tree only (branch `decentralize/wallet-uploads`,
HEAD `928646f`). Nothing is committed, published, deployed or activated. I made no wallet, chain, SSH or production action,
and downloaded no model.

**The goal is not complete.** Component tests prove the apps' protocol and route glue; they do not activate anything.
Activation, the remaining blockers and one coordinated dashboard feature are listed at the end.

**Ownership.**
- Only the auth source, tests and docs of eyesoff-ai, jot, depot and api-mcp-adapter were edited.
- `s3-ipfs-adapter`, `sia-s3` and `ipns-publisher` were not touched; their dirty files belong to their owners.
- The interface is `work/app-auth-final-interface.txt`, published before the code.
- The full inventory, with sha256 and git state of every dirty file in the four crates, component hashes and tool
  versions, is `work/app-auth-final-source-inventory.json`.

## 1. Source closure and the gaps found

**Where it started.** The shared `wallet.rs` (`d23916da…`, the quorum report's final version) was identical in all four
apps. EyesOff had never been rebuilt since the quorum and reader fixes: its newest component still lacked the quorum fix
itself. depot's component e2e and jot's contract-wallet path had never run at component level.

**Facts that decide the design** (main repo, read only):

| Fact | Consequence |
| --- | --- |
| An `acct_…` id is random (`relay/auth.js` `rid("acct_")`). The account→wallet map lives only in the relay database. EST1 claims are `{v, sub, aud, iat, exp}`, with no wallet. | After the issuer is gone, nothing but an app-issued credential (EyesOff EAK1) or an already-made link can prove an old account. A one-time migration while the issuer still mints EST1 is unavoidable for accounts with no such credential. |
| The relay's SIWE accepted EOAs offline, and **EIP-1271 and EIP-6492** contract wallets through viem `verifySiweMessage`. | Smart-wallet users, including **counterfactual (undeployed)** ones, had working app sign-in through EST1. `wallet.rs` accepted only EIP-1271, so those users were refused on the direct path, for sign-in and for the migration link. **This was a real gap: EIP-6492 is required.** |
| The independent passkey identity is a Safe v1.4.1 with passkey owners. The site refuses it until deployed (`identity.js`: "a predicted address cannot own anything"). Its passkeys are bound to the owner's RP. | The site's model is deployment-first, and a deployed Safe answers EIP-1271. EIP-6492 also covers a predicted one. An app page on another origin cannot ask those passkeys to sign, so the signature must be made where they live and carried back. **Gap: the app pages accepted only an injected EIP-1193 wallet.** |
| EIP-7702: a delegated EOA's own key signs ECDSA. | It recovers offline with no reader. If its delegate signs ERC-1271-style, `eth_call` runs the delegate's code and the EIP-1271 path applies. **No gap.** |

## 2. What changed

**Shared `wallet.rs`** (sha256 `4619d6bb1fcf37d8e647c975756e57523fa5426de9b20b6f90bfde455425ed3f`, identical in all four
apps):

- **EIP-6492.**
  - **Recognising it.** A signature ending in `0x6492…6492` is parsed strictly as `abi.encode(address, bytes, bytes)`:
    - an address word;
    - word-aligned in-range offsets;
    - lengths that fit;
    - a non-empty inner signature.

    A malformed wrapper is refused before any reader is asked.
  - **Checking it.** Each pinned reader runs one deployless `eth_call` (no `to`) of ERC-6492 `ValidateSigOffchain` with
    `(wallet, hash, signature)`. It is called at the same agreed `{blockHash, requireCanonical}` and counted by the same
    snapshot quorum, freshness rule and expiry recheck as EIP-1271.
  - **Votes.** `0x01` is valid; `0x00` or a revert is not valid; anything else is no vote.
  - **The validator** is a byte-exact copy of viem 2.53.1 `erc6492SignatureValidatorByteCode` (1684 bytes; sha256 of the
    hex text `037d6b69…`, keccak `041473019f…`, pinned by a test).
- **Size limits.** Signatures may be up to 6144 bytes and tokens up to 16 KiB, so a Safe or WebAuthn wrapper fits.
- **Unchanged.** Every existing format and rule: EWS1, Act::Session/Link, the keyed nonce, context binding, the EIP-1271
  quorum and reader identity.
- **Frozen.** `s3-ipfs-adapter`'s owner already copies this file verbatim and pins `4619d6bb…`. Changing it now needs them
  to re-copy.

**Pages: a hand-signed path for signers outside the browser.**
- **Where it is.**
  - EyesOff: "Signing with something else…" in the gate, and "Link with another signer" for account links.
  - jot: "Another signer…" and "Link another signer…".
  - depot: "Another signer…".
- **How it works.** The person gives an address. The page fetches the deployment's challenge and runs the same checks as
  for a browser wallet: this host, address, nonce and deployment. It shows the exact message, then takes back the
  signature (shape only: `0x` plus 65–6144 bytes). The enclave verifies it as it verifies any signature.
- **Code shape.** Both flows go through one `pickSigner(how)` seam. No argument keeps the injected-wallet behaviour, and the
  existing page tests run unchanged.

**Docs.**
- `eyesoff-ai/PLATFORM-sso.md`:
  - a new section on counterfactual wallets, passkey accounts and signers outside the browser;
  - per-app migration preconditions;
  - the stale "6492 not supported" and "wallets not in the browser not supported" lines replaced.
- `jot/README.md`: contract wallets, the hand path, and when an existing account must link.
- `depot/README.md` and `api-mcp-adapter/README.md`: EIP-6492.

**Tests added.**
- **Real-EVM harness** (`eyesoff-ai/tests/helpers/evm.mjs`):
  - local anvil (chain 8453, 1 block/s, no fork, no network);
  - `TestWallets.sol`: an ERC-1271 owner wallet with per-hash revocation, plus a CREATE2 factory, compiled with solc 0.8.35;
  - readers on loopback ports: honest ones forward to anvil, and one can deny, revert, answer garbage, approve everything
    or be down.
- **Per-app real-EVM component tests:**
  - `eyesoff-ai/tests/contract-wallet-evm.e2e.test.mjs`
  - `api-mcp-adapter/scripts/contract-wallet-evm.e2e.test.mjs`
  - `depot/tests/wallet-evm.e2e.test.mjs`
  - `jot/scripts/wallet-evm.e2e.test.mjs`
- **Browser evidence script:** `work/app-auth-final/browser-hand-signer.mjs`.
- **Simulator vs EVM.** The shared module's unit tests use the simulator. The `*-evm*` tests execute every verdict on the
  EVM, and nothing in them decides a signature.

## 3. Built components (provenance)

| App | Component | sha256 | Kind |
| --- | --- | --- | --- |
| eyesoff-ai | `enclave-apps/eyesoff-ai/target/test-nolto/wasm32-wasip2/release/eyesoff_ai.wasm` (7,080,378 B) | `240d50f04fb89a8612b0f0ad4d1c0a41afd33800c1440b43e86fd7d3c6ca753b` | **TEST BUILD**: release profile with `lto=false`, `codegen-units=16`. The configured release (`lto=true`, `codegen-units=1`) was killed at the 1024 MiB cap (exit 143) and was **not produced**. Toolchain nightly-2026-07-25 (pinned). |
| api-mcp-adapter | `…/api-mcp-adapter/target/wasm32-wasip2/release/api_mcp_adapter.wasm` (463,079 B) | `a3ba018572390563a2eda2707b70559e81237c3576a160671b2a8ee483717124` | **Release**, the crate's own profile (LTO). |
| depot | `…/depot/target/wasm32-wasip2/release/depot.wasm` (2,707,584 B) | `68c256b435e28c0f1f44a61fc871f6dcb6e431cbc14d2104f37702c5fa786017` | **Release**, the crate's own profile (LTO). |
| jot | `work/app-auth-final/scratch/jot-stub/target/wasm32-wasip2/release/jot.wasm` (734,220 B) | `f40afcfe8348a02938206811948c9568e08a2b674de5bb545e286b072e148c41` | **TEST BUILD, NOT DEPLOYABLE**: release profile from a scratch copy whose `src/` and `Cargo.*` are byte-identical to `enclave-apps/jot`, with a **stub** embedding model (12 tokens × 8 dims). The real model was not downloaded. |

Every component postdates every source file it compiles. Each contains the new code strings (6492, quorum, hand path). The
old EyesOff release in `target/wasm32-wasip2/release` (`2fbaba91…`, 16:51) contains none of them.

Tools: wasmtime 49.0.3, anvil/cast 1.7.1, minio RELEASE.2025-10-15T17-29-55Z, node v22.23.3, system Chromium 154 (Playwright
from the main repo, read-only; no browser download).

## 4. Tests run (final sources; each foreground, awaited)

**Memory discipline.**
- Each run was capped with `work/app-auth-final/guard.sh`: a systemd scope with `MemoryMax`, `MemorySwapMax=0`,
  `CARGO_BUILD_JOBS=1`, a MemAvailable check before starting, and the exit code reported.
- Rust and WASM builds started only at ≥18 GiB available, under a 1024 MiB cap. Unit tests ran under 512 MiB from a 16 GiB
  floor; component and browser runs under 1024 and 1408 MiB.
- When memory was below a start level, I waited in the foreground and bounded the wait.

| Suite | Component | Result / exit |
| --- | --- | --- |
| eyesoff-ai `cargo test --lib` (native) | — | **253/253**, exit 0 |
| api-mcp-adapter `cargo test --lib` | — | **51/51**, exit 0 (27 shared `wallet::` tests, including the new 6492 and validator-pin tests) |
| depot `cargo test` (its own test profile, 512 MiB) | — | **81/81**, exit 0 |
| jot `cargo test --lib`, non-model (scratch, stub model) | — | **51/51**, exit 0; **7 model-dependent tests filtered, NOT run** |
| eyesoff-ai `tests/*.test.mjs`: existing attestation, continuity, sign-in, sw and warmup suites | eyesoff test build | **36/36**, exit 0 |
| eyesoff-ai `contract-wallet-evm.e2e` | eyesoff test build + anvil | **6/6**, exit 0 |
| api-mcp-adapter `contract-wallet-evm.e2e` + existing `contract-wallet.e2e` | release | **3/3**, exit 0 |
| depot `wallet-evm.e2e` (MinIO) | release | **4/4**, exit 0 |
| depot `tests/e2e.py`, the full deferred component e2e (git push/clone, sealing, tokens, SSO, hooks, witness, collection) | release | **ALL PASS (56 checks)**, exit 0 |
| jot `wallet-evm.e2e` (MinIO) | jot test build | **4/4**, exit 0 |
| jot `link-minio.test.mjs` (existing real-S3 link forgery suite) | jot test build | **1/1** (8 steps confirmed executed), exit 0 |
| Browser: the hand-signed path in all three pages (Chromium, anvil, MinIO) | eyesoff test build, jot test build, depot release | **3/3 PASS**, exit 0 |

**What the real-EVM tests show, in every app's built component.**
- **Wallet kinds.**
  - An EOA asks no reader.
  - A deployed (EIP-1271) wallet signs in.
  - A counterfactual (EIP-6492) wallet signs in, and is still undeployed afterwards.
- **One bad reader.** With two honest readers, a third that denies, reverts, answers garbage, approves everything or is
  down changes nothing.
- **Forgeries.** A forged signature is refused even with an approve-everything reader.
- **Below quorum.** One honest reader against two deniers refuses. Two colluding approvers DO pass a forgery: the stated
  trust boundary, asserted as such.
- **Revocation.** Owner revocation on chain is refused on the next request, for a deployed wallet and for a counterfactual
  one deployed after signing.
- **Context binding.** A token for another site, deployment or act is refused with **zero** reader calls.
- **Existing-account continuity.**
  - EyesOff: an `acct_…` with an EAK1 links to a counterfactual wallet with a fresh EST1. The deployment then runs with
    **no SSO block**. The wallet acts as the account with the same EAK1, EST1 opens nothing, and revocation ends it.
  - jot: the same over real S3, reading the account's existing sealed note.
  - depot: the same depot user through an owner-listed wallet, with no SSO block.
- **Page glue.** Each page's own `walletStart("hand")`: in a VM against the component, and as a real-browser click-through.

**Mutation checks.** Run in an isolated copy of api-mcp-adapter, each with a release rebuild against a passing baseline,
then deleted. All three were caught by the real-EVM test:
- no 6492 dispatch;
- any one-byte 6492 verdict counts as valid;
- the 6492 call sent to the undeployed wallet instead of deployless.

## 5. Against the all-features goal

- **New users.** They sign in with a wallet of any kind (EOA, EIP-7702, deployed or counterfactual contract, a passkey Safe
  through the hand path). The verification is the wallet's own signature, checked in the enclave, plus owner-pinned
  readers for contract wallets. No Enclave issuer, account API or origin is involved, and the challenge and page come
  from the app itself.
- **Ongoing sign-in never needs EST1.** EST1 stays optional beside it.
- **App-specific authorization is unchanged.**
  - EyesOff: derived keys per identity.
  - jot: sealed per-identity notebooks; links only by the explicit dual proof.
  - depot: users only through the owner's on-chain config.
  - api-mcp-adapter: the caller is named per request; `X-User` is an owner override only with the key.
- **Existing users keep their accounts and data, with these exact preconditions:**
  - **EyesOff.** Chat history is browser-local. EAK1 keys verify forever with `api_key_seed`. A holder of the account's
    EAK1 can link a wallet at **any** time, issuer or not. A holder who never revealed an EAK1 must reveal it, or link,
    **while the issuer still mints EST1 for the account**. The ELK1 lives in the browser, so on a new device they relink
    with the EAK1.
  - **jot.** jot issues no account credential. An account must make its one-time link **while the issuer still signs it
    in**; afterwards the stored MAC'd link serves forever with no issuer. **An account that never links before the issuer
    stops cannot recover its sealed notes.** This follows from the issuer-only account→wallet map, and no app can repair
    it.
  - **depot.** The owner lists the wallet identity beside the account (`accounts`) at any time, with no issuer.
  - **api-mcp-adapter.** Nothing is stored.
  - **Passkey-only relay accounts.** They have no wallet, so they need one to link: any wallet, including the new passkey
    Safe through the hand path.

## 6. Remaining blockers and live steps (not taken; owner and operator wallet actions)

1. **Activation**, per deployment, in the on-chain config:
   - `wallet {audience, domains, ttl_secs, nonce_key?, contract_wallets? {rpcs (2–7 distinct hosts), quorum > half,
     confirmations, max_age_secs, timeout_secs}}`;
   - jot `link_key` (or rely on `master_key`);
   - keep EyesOff `api_key_seed`;
   - depot `accounts`.

   Then publish new catalog versions of the four apps and deploy them.
2. **Migration window.** Before the issuer is retired, announce and run the one-time links: jot accounts, and EyesOff
   accounts without a saved EAK1. Afterwards they are unrecoverable (section 5).
3. **EyesOff release artifact.** The configured LTO release needs more than 1 GiB to link. Build it where memory allows,
   then re-run `tests/*.test.mjs` and `contract-wallet-evm.e2e` against it. The tested build differs only in the LTO and
   codegen-unit settings.
4. **jot deployable artifact.** Run `scripts/fetch-model.sh` (a pinned download), build, then run the 7 model-dependent
   tests and `scripts/e2e.sh`. This pass used a stub model.
5. **Dashboard (main site owner).** A page that signs an arbitrary EIP-191 message as the selected passkey Safe, following
   the grant page's pattern. Until then, passkey-Safe users sign with any Safe-capable signer and paste the result. The
   Safe passkey signer contracts themselves were not exercised by the app tests; that would need a Base fork, an external
   read I did not make. The app protocol was proven with a test ERC-1271/CREATE2 wallet.
6. **Trust model, unchanged and stated.**
   - Contract wallets rest on RPC-quorum trust, not a light client: `quorum` colluding readers decide, and distinct hosts
     are not distinct organizations.
   - Checks are sequential, about 3 × readers × timeout.
   - Within its window, an EWS1 token is a bearer session, not a single-use nonce proof.
7. **Outside this scope.** App names and certificates under `*.app.enclave.host` remain Enclave-controlled (earlier audit
   §D). In-page attestation remains diagnostic.

**Residue.**
- Scratch kept for provenance: `work/app-auth-final/scratch/jot-stub` (the jot test build).
- Other scratch, the mutation copy and every test process were removed.
- I stopped two orphans (an anvil and a minio) from my own aborted first browser run; the script now registers cleanup
  before anything can fail.
- No background jobs remain.

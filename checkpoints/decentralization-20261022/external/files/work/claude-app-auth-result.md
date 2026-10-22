# S8: app sign-in and attestation without Enclave's issuer or API (2026-10-19)

**Status: implemented and tested in source. Nothing is committed, published or activated.**

- **Repository:** `enclave-apps`, branch `decentralize/wallet-uploads`, starting from HEAD `928646f`.
- **Files changed:** only the assigned ones (eyesoff-ai, jot, depot and api-mcp-adapter auth/SSO/attestation code, tests and
  docs; `s3-ipfs-adapter/src/main.rs` CORS configuration and its README section).
- **Not touched:** `sia-s3`, adapter storage/upload code (`upload.rs`, `wallet_upload.rs`), versions, `Cargo.lock`,
  publish artifacts.
- **No external actions:** no commits or pushes, no live requests, no production operations, no wallet or chain
  transactions, no SSH, no private configuration read.

## What exists now

### 1. Direct wallet sign-in beside Sign in with Enclave (EyesOff first, then jot, api-mcp-adapter and depot)

**Mechanism.**
- New `wallet` config block. The visitor's own browser wallet signs an EIP-4361 (SIWE) message that the deployment
  composed.
- The resulting token is `EWS1.<b64url(message)>.<b64url(65-byte sig)>`.
- It is verified inside the enclave by `src/wallet.rs`. The file is byte-identical in all four apps
  (sha256 `4e8a96f2…`), and a pinned vector test guards the format.
- No issuer, no account API, no outbound call.
- Sign in with Enclave (EST1) is unchanged and can be enabled at the same time.

**EyesOff.**
- `GET /auth/wallet/challenge`. The message is built from the request's own Host, accepted only when that host is in
  `wallet.domains` (or the platform's `ENCLAVE_HOSTS`).
- The token is accepted on:
  - the gated `/chat` and `/title` routes;
  - `/v1/*`;
  - `POST /v1/keys` (derived keys for the wallet identity);
  - `$user` tool forwarding.
- `/models` advertises the wallet door and never the nonce key.
- The playground gate and sidebar have a "Sign in with your wallet" button using any injected EIP-1193 wallet. Before
  asking the wallet to sign, the page checks that the message names its own host, the address, its nonce and this
  deployment.

**jot.**
- Per-user notebooks via the `wallet` block, with `/api/auth/wallet/challenge` and a UI button.
- `X-User` (eyesoff's `$user`) also accepts `wallet_0x…`.

**api-mcp-adapter.**
- EWS1 tokens in `X-Sso-Token` or a Bearer name the caller. `accept` and `domains` let it honour sign-ins made at an
  eyesoff deployment.
- The token names the caller only; the API key still gates access.

**depot.**
- EWS1 tokens in `X-Sso-Token`, the challenge route and a UI button.
- A wallet becomes a depot user **only** if the owner set that user's `account` to `wallet_0x<addr>`. This is the
  explicitly owner-selected identity path.

### 2. Audit of the auth properties

| Property | How it is handled |
| --- | --- |
| Nonce | The page supplies 16–64 alphanumeric characters of randomness. With an optional `nonce_key` (a `$SECRET`), the nonce carries the deployment's MAC over the domain, address, issued-at, expiry, chain and audience, so only a challenge this deployment issued is accepted, with its expiry. An unresolved `$NAME` key fails closed. Single use is **not** enforced: the component is stateless. |
| Domain | The message `domain` must be a configured host and the `URI` must be that origin (https; http only on loopback). A signature made for another site is refused. |
| Audience | Exactly one `urn:enclave:deployment:<id>` resource, equal to `audience` or an entry in `accept`. Several deployments in one message are refused. |
| Chain | `Chain ID` must match (8453 by default). |
| Replay | Inside its window a token is a bearer credential, like EST1. Expiration is required. The window is capped by `ttl_secs` (at most 7 days). Issued-at and not-before are checked with a skew allowance. There is no replay across sites, deployments, chains or expiry. |
| CSRF | Credentials travel in script-set headers, never cookies. The challenge is a side-effect-free GET. There is no redirect or fragment return. |
| Account linking | None. A wallet sign-in names `wallet_0x<addr>`. EST1 names `acct_…` (the relay mints only these today, per `relay/sso.js`) or a legacy `0x…`. The same wallet signed in both ways is two identities. |
| Never mapping a wallet to someone else's data | An EST1 `sub` of `wallet_…` is refused, so a platform or owner signer cannot claim a wallet's data. Derived API keys, jot namespaces, MCP callers and depot users all stay separate. Depot maps only owner-bound accounts. |
| Not supported | EIP-1271 contract wallets (they need a chain read), passkey-only accounts (the passkey is bound to the enclave.host RP), and WalletConnect (it would be another relay). |

### 3. EyesOff attestation without `api.enclave.host`

**The hardcoded API is gone.**
- `attest.rs` reads `attestation.sources`: owner-chosen https record origins, tried in order, with the one that
  answered named in the response.
- The default is still `https://api.enclave.host`, so current behavior is preserved. `[]` means no relayed record.
- Invalid entries are a loud configuration error.

**New self-served path, which the dialog now tries first.**
- The browser fetches `/.well-known/enclave-attestation?nonce=<fresh 32 bytes>` from its own origin. That document is
  served by the measured guest front (`isolation/m2/front/main.go`), not by the app.
- `src/attest-verify.js` verifies it in the page with WebCrypto:
  - the nonce echo;
  - the ABI/1 or ABI/2 binding (key, nonce and runtime id; the runtime id is recomputed byte-for-byte as the contract
    does);
  - the app id;
  - the guest policy (no debug, no migration agent) and VMPL 0;
  - the VCEK → ASK → ARK chain: RSA-PSS with AMD's exact parameters, validity windows, and AMD's three ARKs pinned by
    sha256;
  - that the VCEK's extensions name the chip and TCB;
  - the PSP's ECDSA P-384 signature;
  - that HOST_DATA matches the label the hostname spells.
- `GET /attestation/vcek` relays only KDS-shaped URLs, built from validated fields, from `attestation.kds` (default
  `https://kdsintf.amd.com`). Its result is trusted only after it chains to the pinned root.
- The dialog lists what it did not check: CRL, TCB floor, expected measurement, handshake key, and the fact that the
  page came from the origin it checks.
- Under a path prefix (the `/x/` bridge) the self-served path is skipped, because that origin's document would belong
  to a different guest.

### 4. Adapter CORS (`s3-ipfs-adapter/src/main.rs`)

**What I found in the source.**
- `allowOrigins` was already configurable, and the production config sets `["https://enclave.host"]` explicitly.
- Two real defects:
  - An entry of `"*"` became the first-entry fallback, so **every** response would carry
    `Access-Control-Allow-Origin: *`.
  - Entries were not normalized (case, default port), so a mirror listed as `https://Dash.example.org:443` would never
    match a browser's Origin header.

**What changed.**
- Entries are parsed into exact browser-form origins.
- Wildcards, `null`, paths, userinfo and non-loopback http are dropped and logged.
- A comma or space separated string (for example a `$ALLOW_ORIGINS` secret) is accepted.
- An absent key keeps the legacy default, for behavior preservation. `[]` admits no browser origin.
- No credentials header is ever allowed, and the deployment-bound wallet signatures are untouched.
- Independent mirrored dashboards upload once listed.

## Tests run (all local, offline)

| Suite | Result |
| --- | --- |
| eyesoff-ai `cargo test --lib` (native) | 237/237 |
| eyesoff-ai `node --test tests/*.test.mjs` | 30/30 (includes the existing sw and warmup suites) |
| jot unit tests (scratch copy with stub embedding files; model-dependent `embed::`/`index::` tests skipped because fetching the model is an external request) | 26/26 |
| api-mcp-adapter `cargo test --lib` | 36/36 |
| depot `cargo test` | 66/66 |
| s3-ipfs-adapter `cargo test` | 66/66 |
| `wasm32-wasip2` release builds: eyesoff-ai, api-mcp-adapter, depot | all three build cleanly (jot not built: it needs the downloaded model) |

What the eyesoff node suites cover:

- **`tests/attest-verify.test.mjs` (9 tests):** EyesOff's **own production guest** (`0x9eb4e600…`, captured from its
  public origin on 2026-10-17, copied from the enclave repo's public fixtures).
  - Every check passes.
  - The recomputed runtime id equals the relay prediction's `297b6c2c…`.
  - Each substitution is refused at its own check: a replayed nonce, a key swap, an app swap, a runtime swap, a flipped
    measurement byte, a foreign VCEK, an expired chain, a wrong host label.
  - A missing VCEK is reported as "unsigned", never as a pass.
  - Retrieval runs over real HTTP against a stand-in for the front and the VCEK relay, with nothing else served.
- **`tests/sign-in.e2e.test.mjs` (4 tests), run against the built component under `wasmtime serve`:**
  - Wallet sign-in end to end, through both header spellings.
  - A derived key for the wallet identity.
  - Refusals: wrong domain (a phishing-site signature), another deployment, expired, a wallet signing over another
    wallet's message, an over-long session, EST1 where no signer is pinned, and a challenge for a foreign Host.
  - Old SSO still works.
  - EST1 for the same address versus EWS1 gives different subs and different keys. EST1 claiming `wallet_…` is refused.
  - The attestation routes need no platform API. The VCEK relay refuses non-KDS input.
  - The **playground's own `walletStart()` code**, with a stub EIP-1193 wallet, signs in against the component. A
    tampered challenge naming another site is refused before the wallet is asked to sign.
  - Signatures come from `cast wallet sign` with throwaway keys, offline.

The production chat is preserved:
- browser storage keys (`llmchat-*`, IndexedDB) are unchanged;
- existing EST1 tokens verify exactly as before;
- no production config or state was read or written.

## What each proof rests on: hardware, RPC/host, or an operator

| Claim | What it rests on |
| --- | --- |
| Report signature, VCEK chain, chip/TCB in the VCEK | **AMD hardware** (pinned ARK). Checked in the page. |
| Launch measurement value; `report_data` binding (nonce, transport key, runtime id, app id); HOST_DATA value | **Hardware-signed.** HOST_DATA is chosen by the host at launch, then signed by the PSP. |
| The runtime identity really is what runs; `runtimeSelfTest`; boundary | **The measured code's own statement**, bound into the report. Not hardware proof. |
| Expected measurement | **Not checked in the page.** Needs your own reproduction. The relay's `/v1/expected-guest` is Enclave-operated. |
| Transport key equals the TLS certificate you connected to | **Not checkable from page JS.** Rests on WebPKI and DNS for the app's name, which per audit §D are Enclave-controlled for `*.app.enclave.host`. |
| The verifier code itself | **The origin being checked.** The independent step is `verifier/live-domain-check.mjs` run against the same origin. |
| CRL / revocation and firmware floor | **Not checked** (residual). |
| VCEK availability | **AMD KDS** (a third party), reached through the deployment's egress. Authenticity does not depend on it. |
| GPU report, deployment row, self-check | **Whoever the owner configures as source.** The default is `api.enclave.host`: Enclave-operated, relayed, not verified in the page. |
| Wallet sign-in | **Pure signature math.** No RPC, issuer or host trust per request. The config (`audience`, `domains`) arrives as the deployment's CID-verified on-chain config, so it rests on the usual chain/RPC trust at launch. |
| Sign in with Enclave | **Platform signer and relay accounts** (unchanged, still optional). |

## Residual gates, honestly

- **Activation is an owner action I did not take.** Each deployment's on-chain config needs a `wallet` block
  (`audience`, `domains`) and optionally an `attestation` block. A new version must be published and deployed for the
  code to run. That needs owner and operator wallets, which are out of scope.
- **Names and certificates.** EyesOff at `eyesoff.ai` or `<label>.app.enclave.host` still relies on Enclave DNS-01 and
  certificates (audit §D). A mirrored front-end on another name must be listed in `wallet.domains` and have its own
  certificate.
- **Runtimes with no measured front** (Windows Shield, Cloud Provider) have no self-served document. The dialog falls back to
  the configured record source, and GPU attestation remains platform-relayed.
- **Stateless limits.** Nonces are not single-use and expiry is the only revocation. Keep `ttl_secs` short where that
  matters.
- **`/attestation/vcek` is open.** Each call is one outbound KDS fetch, cached for a day by browsers. It is not gated,
  so there is a possible AMD rate-limit impact.
- **Adapter default.** An absent `allowOrigins` still defaults to `https://enclave.host`, preserved on purpose; set it
  explicitly. `upload::cors` (not my file) still echoes the first allowlisted origin to non-matching requests. That is
  harmless because browsers refuse it, but it is noisy.
- **jot gaps.** jot's model-dependent tests, wasm build and `scripts/e2e.sh` (minio) were not run.
- **No independent operators.** No organizations were added. Configured mirrors, record sources and KDS mirrors are
  whatever the owner lists; extra Enclave-run replicas are not independence.

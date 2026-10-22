# Sign in with Enclave: the platform half

The app half is DONE on this branch (0.51.0): `sso.rs` verifies tokens, the
playground runs the redirect flow, `/chat` and `/title` gate on a valid token
when the deployment says so, and `/v1/*` accepts one beside `api_key`. What
does not exist yet is the thing that MINTS tokens. This document is the
contract that side has to meet, written so it can be built in the platform
repo without reading the app.

## Why this shape

The identity is the relay ACCOUNT - the passkey is the person; a wallet is
one way an account authenticates (SIWE keys accounts by wallet, so wallet
users get a stable account too). Sharing the LOGIN therefore means sharing
a claim about the account, not the credential: a WalletConnect pairing is per dapp and a passkey is bound to its
RP, but a short-lived signed note saying "this address is signed in, for that
deployment, until then" can be carried by the browser to any app that knows
the platform's signing address.

The token is verified INSIDE the enclave, statelessly. No gateway injection
(the TLS path stays end to end), no introspection call (a deployment with no
egress can still gate), no session table (a wasip2 component keeps nothing
between requests). That puts three duties on the mint side: bind the
audience, keep the TTL short, and never let the signing key near anything
else, because expiry is the only revocation there is.

## Endpoint

```
GET https://enclave.host/sso/authorize
    ?aud=<0x + 64 hex, the deployment id>
    &redirect_uri=<absolute https URL>
    &state=<opaque, 1..256 chars>
    [&ttl=<seconds>]
    [&prompt=select_account]
```

Behavior:

1. **Session.** If the visitor has no live enclave.host session, run the
   normal login (passkey or WalletConnect) first, then continue. The flow is
   a plain navigation, so this is just the existing login page with a
   continuation.
2. **Validate `redirect_uri`.** Its origin must belong to the `aud`
   deployment: `https://<first-8-hex-of-aud>.app.enclave.host`, the
   deployment's registered custom domain(s), or the direct enclave origin
   serving `/x/<aud>`. Anything else is a hard error page, no redirect: a
   redirect to an unvalidated URI is a token exfiltration primitive. Compare
   origins exactly (scheme, host, port); the path may be anything, since the
   app returns to the page the visitor was on.
3. **No consent interstitial** (operator decision, 2026-08-17; the original
   draft asked for one). A visitor with a live session passes straight
   through: every return origin is one of the platform's own deployments,
   and the platform accepts its apps learning a signed-in visitor's address
   without a click. Interaction remains only where something genuinely
   forks: signing in at all when there is no session.
4. **Mint** (format below) and 302 to:

```
<redirect_uri>#sso=<token>&state=<state, echoed verbatim>
```

The FRAGMENT, never the query: fragments do not reach servers, logs or
Referer headers. `state` is opaque to the platform; echo it byte for byte
(the app refuses a token whose state echo does not match the one it stored
when it started the flow, which is what stops a crafted link logging a
visitor into an attacker's account).

`ttl` clamps to `[300, 604800]`, default `86400` (24 h). The default is a
session length, not a security boundary; the security boundary is `aud`.

`prompt=select_account` (2026-09-03; `login` is accepted as the same ask)
is the one exception to step 3: a visitor with a live session is shown a
two-button card, continue as the current account or use a different one.
The second signs the account out of enclave.host in this browser and runs
the normal sign-in. It exists because the account session is one per
browser and a wallet connection is a separate state domain: connecting
another wallet never changes the account, so without it an app could only
switch users by sending them to sign out of enclave.host first. An app
that wants a "switch account" button drops its own stored token and
starts the flow with this parameter; absent the parameter, nothing
changes.

## Token format (EST1)

```
EST1.<base64url_nopad(claims JSON)>.<base64url_nopad(65-byte r||s||v signature)>
```

Claims, all required:

```json
{"v":1,"sub":"<the signed-in ACCOUNT: acct_<hex> account id, or a 0x<40 hex> wallet address, lowercase>",
 "aud":"0x<64 hex, deployment id>",
 "iat":<unix seconds>,"exp":<unix seconds>}
```

Signature: Ethereum **EIP-191 personal_sign** over the ASCII string
`EST1.<base64url(claims)>`, i.e.
`keccak256("\x19Ethereum Signed Message:\n" + len + "EST1.<b64>")` signed by
the platform SSO key, secp256k1 with recovery byte (`v` as 27/28 or 0/1, the
verifier takes both). The signed string is the token's own first two
segments, byte exact, so there is no canonical-JSON step to disagree about,
and any wallet tooling can mint a test token (`cast wallet sign` produces
exactly this signature).

Extra claims are ignored by the verifier, so `v:1` can grow fields without a
version bump; changing the MEANING of an existing field is what `v:2` is for.

## Test vector

Throwaway key `0x4242...42` (32 bytes of 0x42), whose address is
`0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025`. Claims:

```json
{"aud":"0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa",
 "exp":1755086400,"iat":1755000000,
 "sub":"0x00a329c0648769a73afac7f9381e08fb43dbea72","v":1}
```

Token (one line):

```
EST1.eyJhdWQiOiIweGNjMWY0ZjNmMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwYWEiLCJleHAiOjE3NTUwODY0MDAsImlhdCI6MTc1NTAwMDAwMCwic3ViIjoiMHgwMGEzMjljMDY0ODc2OWE3M2FmYWM3ZjkzODFlMDhmYjQzZGJlYTcyIiwidiI6MX0.yk7Y_U0V-3ZyKhLJptbXZB3_Id-bEay1FtUTLFWjGgdyYQRL3xUJfKR5WTawlUSttKpUO0_H-x960Vn5-82NvRw
```

`sso.rs`'s `spec_vector` test mints and verifies exactly this (rerun with
`cargo test spec_vector -- --nocapture` to regenerate); a platform
implementation that produces this token for these claims and this key is
compatible.

## The signing key

- **Dedicated key.** Never the treasury or any key that signs transactions:
  this one signs whatever the authorize endpoint is asked to, on demand, and
  its blast radius must be "logins", not "funds".
- **Publish the address** at `https://enclave.host/.well-known/sso-signer.json`:

  ```json
  {"signer":"0x...","previous":["0x..."]}
  ```

  Operators pin it in deployment config (`sso.signer`); the app deliberately
  does NOT fetch it (a deployment with no egress must still verify), so
  rotation reaches deployments as a config update. `previous` exists so an
  operator who missed a rotation can see what changed.

## What the app expects (already built, for reference)

- Deployment config block, on-chain via configCid:

  ```json
  "sso": {"signer": "0x<platform address>",
          "audience": "0x<this deployment's id>",
          "required": true}
  ```

  plus optional `authorize_url` (defaults to the endpoint above) and
  `skew_secs` (default 300, applied to `iat` only; `exp` is strict).
- With `required` true: `POST /chat` and `POST /title` answer
  `401 {"error":{"message":...,"code":"sso_required"}}` without a valid
  token; `GET /`, `/models`, `/attestation` stay open (the page must be able
  to carry the sign-in button, learn where to send people, and be verified
  before being trusted with a login). `/v1/*` takes a valid token OR the
  deployment's `api_key`.
- The playground starts the flow with `aud`, `redirect_uri` (its own page)
  and a random `state` kept in sessionStorage, and stores the returned token
  in sessionStorage for the tab's lifetime. With "Remember on this device"
  on (0.54.0) it also keeps a copy in localStorage and asks for
  `ttl=604800`, so a return visit inside 7 days is already signed in;
  sign-out and switching storage off both remove the copy, and a copy past
  `exp` is dropped at boot.
- **Popup mode** (0.52.0, the default when popups are allowed): the app opens
  the authorize URL in a `window.open` popup with `display=popup` (the
  console drops its site chrome) and `redirect_uri` pointing at the app's
  `/sso-return` page. The popup is a TOP-LEVEL enclave.host context, so it
  sees the first-party session - a signed-in visitor's popup flashes and
  closes. `/sso-return`, being same-origin with its opener again, ferries the
  return fragment over `postMessage` and closes; the chat page runs the same
  state-echo acceptance either way. This sidesteps both storage partitioning
  (which blinds an IFRAME embed to the first-party session - why embedding is
  not offered) and any COOP on the console (the postMessage hop happens
  between two app-origin documents). A blocked popup falls back to the
  full-page redirect flow above.
- **Header transport caveat.** The fleet's inbound TLS proxy has been
  observed stripping `Authorization` (2026-08-17, deployment e64f7cba: a
  correct Bearer answered 401 while the same value as `X-Api-Key` answered
  200). The app therefore reads the credential from `Authorization: Bearer`
  OR `x-api-key`, and the playground sends both. Platform fix worth making
  regardless: the proxy should pass `Authorization` through untouched; until
  it does, `x-api-key` is the spelling that provably arrives.

## Non-goals, stated so they stay stated

- **Authorization.** The gate is "signed in with Enclave", not "allowed":
  any account satisfies it. An address allowlist beside `signer` is the
  obvious extension and belongs in the app when someone needs it.
- **Scopes / delegation.** The token means "may use this deployment", whole.
- **Server-side logout.** Dropping the token is logout; expiry is revocation.
- **The platform learning usage.** It learns that a login happened for a
  deployment (it served the login); conversations still never leave the
  enclave, and the app calls nothing out to verify.

## Without the platform: direct wallet sign-in (2026-10-19)

Everything above needs enclave.host to MINT: its account API authenticates the
visitor and its `SSO_SIGNER_KEY` signs. That stays, unchanged. Beside it, a
deployment's owner can admit the visitor's own wallet directly, with no
issuer at all. The wallet signs an EIP-4361 ("Sign-In with Ethereum")
message that this deployment composed, and the enclave verifies it
(`src/wallet.rs`, shared verbatim by jot, depot and api-mcp-adapter).

```json
"wallet": {"audience": "0x<this deployment's id>",
           "domains":  ["eyesoff.ai", "9eb4e600.app.enclave.host", "mirror.example.org"],
           "required": true}
```

Optional keys:
- `chain_id`: default 8453.
- `ttl_secs`: default 86400, clamped to [300, 604800].
- `skew_secs`: default 300.
- `accept`: other deployment ids whose visitors are honoured.
- `allow`: an address allowlist.
- `nonce_key`: a `$SECRET`.

Without `domains`, the platform's `ENCLAVE_HOSTS` list decides. With neither,
nothing is accepted.

**Token (EWS1).**

```
EWS1.<base64url(the exact EIP-4361 message)>.<base64url(65-byte r||s||v)>
```

The signature is the wallet's EIP-191 `personal_sign` over the message
bytes. The browser carries the signed message itself, so there is nothing to
canonicalize.

**Flow.**
1. `GET /auth/wallet/challenge?address=0x…&nonce=<16..64 alphanumerics>`
   (jot and depot serve it under `/api/auth/wallet/challenge`).
2. The server answers with the message, built from:
   - the request's own Host, only if it is one of the listed domains;
   - the address;
   - the chain;
   - an `Issued At` / `Expiration Time` window;
   - exactly one resource, `urn:enclave:deployment:<id>`.
3. Before asking the wallet to sign, the page checks that the message names
   its own host, the address, our nonce and this deployment.
4. The page sends the token exactly as it sends an EST1 token: `Authorization:
   Bearer` plus `x-api-key` here, or `X-Sso-Token` on jot and depot.

**Checked on every request.**
- The signature recovers the message's address.
- `domain` is one of ours, and `URI` is that origin. A message a wallet signed
  for another site opens nothing; this is SIWE's phishing defence carried
  through.
- `Version` is 1 and `Chain ID` matches.
- There is exactly one deployment resource, and it is this deployment (or one
  in `accept`).
- `Issued At` is not in the future and `Expiration Time` has not passed.
- The window is no longer than `ttl_secs`.
- With `nonce_key` set, the nonce carries this deployment's MAC over the
  domain, address, times, chain and audience. Only a challenge this
  deployment issued, with the expiry it chose, is accepted. A `$NAME` left
  unresolved fails closed.

**Replay, said exactly.** An EWS1 token is a BOUNDED BEARER SESSION, not a
single-use proof:
- Inside its window it opens every gated request, as often as it is
  presented, from wherever it is presented. Holding it is the session, as with
  EST1.
- Nothing records that a nonce was used, because the component keeps no state.
  The nonce (MAC'd with `nonce_key` when set) proves only that THIS deployment
  composed the message, for that address, those times and that act. It does
  not stop the same signed message being shown twice.
- Expiry is the only revocation. Use a short `ttl_secs` where that matters.

What does NOT replay:
- a signature made for another site (domain and URI checks);
- one made for another deployment (the single deployment resource);
- one made for another chain;
- one made for another act (session vs link: the resources, the statement and
  the nonce MAC all differ);
- anything after its expiry.

**Domains, exactly.** A message's `domain` must equal one entry of the allowed
set, compared after lowercasing and dropping a `:443`. The allowed set is
`wallet.domains` when that list is non-empty. Otherwise it is the platform's
`ENCLAVE_HOSTS` (every hostname the deployment answers on). With neither, it is
empty and nothing is accepted. A configured list REPLACES the platform's list;
it does not extend it.

It is membership, not equality with the request's Host. A message signed at one
listed host also opens requests that arrive at another listed host of the same
deployment, because the wallet consented to that deployment on a site the owner
listed. The challenge, by contrast, is composed only for the request's own Host,
and only when that Host is listed.

**CSRF.** The credential travels in a header that page script sets, never in
a cookie, so a cross-site form or request carries nothing. The challenge route
is a side-effect-free GET. The wallet flow has no redirect or fragment return,
so the `state` echo that guards the EST1 return has nothing to guard here.

**Identity, never merged.** A wallet sign-in names `wallet_0x<lowercase
address>`. An EST1 token names a relay account (`acct_…`, or a bare `0x…` from
older mints). These are different identities even for the same wallet:
- This app cannot see which wallets an account links.
- Mapping one onto the other would hand one party's data to another on an
  assumption.

The rules that follow:
- An EST1 token whose `sub` is `wallet_…` is refused (`sso.rs` admits only the
  platform's two shapes). Whoever holds a signer cannot claim a wallet's
  namespace.
- Derived API keys, `$user` forwarding, jot notebooks and api-mcp-adapter
  callers all keep the namespaces apart.
- Depot admits a wallet only as the user whose `account` the owner set to that
  `wallet_0x…`. The owner selects; nothing maps itself.
- There is no automatic account linking. A link would need proof of both
  identities at once and somewhere to keep it, and nothing here offers that.

**Contract wallets (EIP-1271), optional.** A deployment that pins chain readers
accepts smart-contract wallets:

```json
"contract_wallets": {"rpcs": ["https://reader-1.example", "https://reader-2.example", "https://reader-3.example"],
                     "quorum": 2, "confirmations": 2, "max_age_secs": 120, "timeout_secs": 5}
```

**What the readers must say.** For a signature that does not recover as an EOA,
the app asks every reader, in one batch, for `eth_chainId` and its head. A reader
not on the wallet block's `chain_id` is no reader of this chain and does not
count.

**Which block.** The target is the `quorum`-th highest reported head minus
`confirmations`, so at least `quorum` readers claim to have it. One reader that
lags, is stale, or lies about its head can neither drag the check to an old,
unusable block nor push it past what the others have.

**Each reader's snapshot.** Each remaining reader returns that block's number,
hash (validated as 32 bytes of hex) and time. It then returns
`isValidSignature(EIP-191 hash, signature)` executed AT THAT HASH (EIP-1898
`{blockHash, requireCanonical}`), so the verdict is bound to the block the
reader named. A revert counts as a "no". A malformed hash, garbage, an unknown
block or silence counts as no answer at all.

**Approval needs all of:**
- exactly one snapshot (number, hash, time AND verdict) held by at least
  `quorum` distinct readers, saying valid;
- no other snapshot also reaching `quorum` (a split refuses);
- that block no older than `max_age_secs` by the clock read AFTER the reads,
  and the sign-in itself still unexpired by that clock.

**What refuses.**
- A "not valid" snapshot reaching quorum (the contract said no, and enough
  readers agree it did).
- A split, where two snapshots both reach quorum.
- No snapshot reaching quorum, including too few readers on the configured
  chain.
- A stale block, or a sign-in that expired while the readers answered.

**What one reader can do.** Nothing alone: a lone "no", revert, garbage answer,
stale or forked view, lagging head or silence is outvoted by an agreeing honest
quorum. A lone "yes" is one vote short. There is no first-answer path.
`quorum` colluding readers can approve or refuse, so set `quorum` above half the
readers and choose operators that will not collude.

**What the readers see.** Only the contract address, the message hash and the
signature, all of them public.

**Bounds.**
- 2 to 7 readers, each a distinct READER. A public reader is identified by its
  canonical host, so port, path, letter case and a trailing dot do not make a
  second one (`https://rpc.example`, `https://rpc.example:443` and
  `https://rpc.example.:8443` are one reader), and an IPv4-mapped IPv6 address is
  its IPv4. On loopback (a test rig) the port tells readers apart, and
  `localhost`, `127.0.0.1` and `[::1]` are one host;
- URLs parsed strictly: https (plain http only on loopback); a DNS name,
  dotted-quad IPv4 or bracketed IPv6; port 1–65535; a path of letters, digits
  and `-._~/` only. No credentials, query, fragment, percent-escapes,
  whitespace or non-ASCII. Ambiguous numeric hosts such as `127.1` are refused.
  Diagnostics name an entry by index and host, never by URL, since a path may
  carry an API key;
- quorum at least 2;
- `timeout_secs` at most 15 per request;
- `max_bytes` capped, and no redirects followed.

**Elapsed time, stated plainly.** The readers are asked ONE AFTER ANOTHER: one
head request each, then up to two requests (header, then the call) per remaining
reader, each bounded by `timeout_secs`. A check can therefore take up to about
3 × readers × `timeout_secs` (3 readers at 5 s: about 45 s; 7 at 15 s: about
5 minutes). Freshness and sign-in expiry are judged after that.
- A reader that hangs until its timeout does not get a veto, but it does spend
  the budget.
- Enough slow readers can push an honest check past `max_age_secs`, or past the
  sign-in's expiry, and that check is then refused.
- Keep 3 × readers × `timeout_secs` well under `max_age_secs`. Slow-reader
  tolerance is bounded, not unlimited.

**Malformed answers.** A reader's answer is hostile input. Non-ASCII or non-hex
text where hex belongs is refused before any parsing that could split a
character, so it counts as no answer and cannot crash the app.

**What it does not change.** An EOA sign-in never touches a reader, even when
readers are pinned. Without `contract_wallets`, a non-EOA signature is refused
with no network at all.

**Where it is wired.** All four apps carry their own transport to the
owner-pinned readers, with no shared or central verifier:
- eyesoff-ai and api-mcp-adapter through wasi:http;
- jot through its own HTTP client;
- depot through its own client and egress, each request sent once.

**Signer proof and owner override are kept apart.** A contract wallet that passes
is a SIGNER-proven caller (`via: "wallet"`). api-mcp-adapter's and jot's
`X-User` beside the API key is the OWNER OVERRIDE (`via: "key"`): the key
holder's assertion, for which no signature is checked and no reader is asked.
depot binds identities to users only through the owner's config
(`account`/`accounts`).

**Limits.**
- This is RPC trust, not a light client. The readers' operators, at quorum,
  decide.
- Distinct URLs are not distinct organizations, and the owner chooses who they
  are.
- The check runs on every gated request: there is no state to cache a verdict
  in.
- Wallets not deployed yet (EIP-6492) and signers that are not in the browser are
  covered in the next section.

**Not supported.** A WalletConnect relay: it would be another third party. A
signer outside the browser uses the hand-signed path instead (next section).

## Counterfactual wallets, passkey accounts, signers outside the browser (2026-10-19)

**Why this is needed.** The platform's own SIWE sign-in accepted EOAs offline,
and EIP-1271 and EIP-6492 contract wallets through viem's `verifySiweMessage`.
So a smart-wallet user, including one whose wallet was never deployed, had
working app sign-in through EST1. Refusing those wallets on the direct path
would drop an identity the platform supported, for sign-in and for the one-time
account link alike.

**EIP-6492 (wallets not deployed yet).**
- **Recognising it.** A signature ending in the 32-byte `0x6492…6492` suffix is a
  wrapper: `abi.encode(address factory, bytes factoryCalldata, bytes signature)`.
  `wallet.rs` checks its ABI strictly before anything else: an address word,
  in-range word-aligned offsets, lengths that fit, and a non-empty inner
  signature. A malformed wrapper is refused before any reader is asked.
- **Checking it.** Each pinned reader runs ONE deployless `eth_call` (no `to`) of
  ERC-6492's `ValidateSigOffchain` creation code, with constructor arguments
  `(wallet, hash, wrapped signature)`. It is called at the same agreed
  `{blockHash, requireCanonical}` as an EIP-1271 call.
  - The validator simulates the factory call when the wallet has no code, asks
    `isValidSignature`, and returns one byte: `0x01` valid, `0x00` not valid.
  - A revert is "not valid". Anything else is no vote.
  - It is a simulation: nothing is deployed, and the wallet stays undeployed (the
    tests check this).
- **The validator bytecode** is a byte-exact copy of viem 2.53.1's
  `erc6492SignatureValidatorByteCode` (1684 bytes; sha256 of the hex text
  `037d6b69…6ea4`, keccak-256 `041473019f…57b9`, pinned by a test).
- **Same trust as a deployed wallet.** The same snapshot quorum, freshness rule,
  expiry recheck and context checks apply.
- **Revocation.** A wallet that is deployed after signing and then revokes the
  hash is refused on the next request: the validator first asks the deployed
  code.
- **Size.** Signatures may be up to 6144 bytes (tokens up to 16 KiB), so a
  wrapper carrying a Safe's factory call and a WebAuthn assertion fits. The pages
  accept the same range.

**EIP-7702 (a delegated EOA).**
- Its own key still signs ECDSA, which recovers offline and asks no reader.
- If its delegate signs ERC-1271-style instead, `eth_call` runs the delegate's
  code and the EIP-1271 path applies unchanged.
- Nothing new is needed.

**The independent passkey account** (the dashboard's Safe v1.4.1 with passkey
owners, `site/js/core/passkey-account.js`).
- **Deployment-first.** The dashboard itself treats the account as an identity
  only once it is deployed (`identity.js`: "a predicted address cannot own
  anything"). A deployed Safe answers EIP-1271 through its pinned
  CompatibilityFallbackHandler, and EIP-6492 also covers a predicted one.
- **Where the signature is made.** Its passkeys are bound to the owner's RP, so
  an app page on another origin cannot ask them to sign. The signature has to be
  made where the passkeys live and carried back.
- **Carrying it back.** Every app page now has that path (below).
- **Not built yet (dashboard owner).** A dashboard page that signs an arbitrary
  EIP-191 message as the selected Safe. The grant page already shows the
  pattern: the request in the URL fragment, then `passkeyParts` +
  `safeSignatures` over the SafeMessage hash. Until it exists, any Safe-capable
  signer can produce the same signature.

**Signers outside the browser: the hand-signed path.**
- **What the person does.** "Signing with something else" in EyesOff's gate
  ("Link with another signer" for links), "Another signer…" in jot and depot.
  The person gives the address, and the page fetches the deployment's challenge.
  It runs the same checks as for a browser wallet: this host, this address,
  this nonce, this deployment. It then shows the exact message to sign as a
  personal message and takes back the signature.
- **Trust.** Nothing pasted is trusted beyond its shape (`0x` plus 65–6144 bytes).
  The enclave verifies it as it verifies any signature: an EOA offline, a
  contract account (deployed or EIP-6492) through the owner's readers.

**Proven on a real EVM.** The component tests run the BUILT components against
a local anvil chain, not a simulator:
- a deployed ERC-1271 test wallet and a counterfactual one from its CREATE2
  factory (`tests/fixtures/contract-wallet/TestWallets.sol`, solc 0.8.35);
- two honest readers forwarding to anvil, and a third that denies, reverts,
  answers garbage, approves everything or is down.

What they show:
- sign-in through all of those reader modes;
- refusal of forgeries;
- owner revocation, before and after deployment;
- zero reader calls for a foreign site, deployment or act;
- the one-time link of an existing account to a counterfactual wallet, then
  use with no SSO block at all.

That is the protocol the apps speak and their route glue. It is not the Safe
passkey signer itself, which is verified only through the dashboard's own Base
fork tests.

## Attestation without the platform API (2026-10-19)

The guest front of a measured deployment answers `GET
/.well-known/enclave-attestation?nonce=<64 hex>` on the app's own origin,
before the app sees the request. The shield dialog now asks it FIRST, with a
fresh nonce, and checks the answer in the page (`src/attest-verify.js`). It
checks:
- the nonce echo;
- the ABI/1 or ABI/2 binding over the document's transport key, recomputed
  (including the runtime id);
- the app id in `report_data[32:64]`;
- the guest policy (no debug, no migration agent) and VMPL 0;
- the VCEK → ASK → ARK chain, with AMD's three ARKs pinned by sha256;
- that the VCEK's extensions name the chip and reported TCB;
- the PSP's ECDSA P-384 signature;
- that HOST_DATA matches the deployment label the hostname spells.

`GET /attestation/vcek` relays the one piece of collateral a page cannot fetch
cross-origin: the VCEK, from AMD's KDS, which sends no CORS. It builds only
KDS-shaped URLs from validated fields, and the page trusts the result only
after it chains to the pinned root.

The platform record (GPU, deployment row, self-check) still comes from
`GET /attestation`. Its source is now owner configuration:

```json
"attestation": {"sources": ["https://api.enclave.host"],
                "kds": "https://kdsintf.amd.com"}
```

- Both values shown are the defaults.
- `sources: []` relays no record.
- Entries must be https origins.
- The answer names the source that gave it.

Under a path prefix (the `/x/<id>/` bridge or a reverse proxy) the origin's
document is not this app's, so the dialog skips the self-served path and says
so.

**The in-page check is DIAGNOSTIC.** Browser JavaScript cannot learn the SPKI
its own TLS connection negotiated, and the page was served by the origin it
checks. A pass is therefore a reading of the evidence, shown in neutral styling
with no check mark, and never presented as equivalent to a native verifier. No
number it shows is stored or reused as an expectation, so a measurement read
here never becomes a trust pin.

What the in-page check does not do, and the dialog lists:
- **Revocation and firmware.** AMD's CRL is not consulted and no TCB floor is
  applied.
- **Measurement.** It is shown, not compared. An expectation must come from a
  reproduction or a party you choose, never from the server being judged.
- **Handshake key.** A page cannot read its own TLS handshake key.
- **Self-served page.** The page was served by the origin it checks.

The step that takes nobody's word is a verifier you run yourself against the
same origin: the enclave repo's `verifier/live-domain-check.mjs`, with your own
expected measurement.

`tests/attest-verify.test.mjs` replays EyesOff's own production guest
(deployment `0x9eb4e600…`, captured from its public origin on 2026-10-17)
through the verifier and through a local stand-in for the front and the VCEK
relay. Every check passes, and each substitution is refused at the check that
names it. `tests/sign-in.e2e.test.mjs` runs the built component under
`wasmtime serve`.

## Keeping an existing account: explicit links (2026-10-20)

Sign in with Enclave names a relay ACCOUNT (`acct_…`). A direct wallet sign-in
names `wallet_0x…`. They stay separate identities, and nothing ever infers one
from the other. An address says nothing about which account it belongs to.

What a person with an existing account actually has in each app decides what
continuity means:

| App | What is keyed by the account | Continuity |
| --- | --- | --- |
| eyesoff-ai | Chat history: nothing; it lives in the browser (IndexedDB), keyed by no identity. Derived API keys (EAK1) and `$user` (what jot and MCP tools see) are keyed by `sub`. | **Existing EAK1 keys keep working with no issuer:** verification needs only `api_key_seed`. A LINK (below) lets a wallet act as the account. Re-deriving the key and naming `$user` then work from a wallet sign-in. History needs nothing. |
| jot | The notebook, under `<prefix>users/<sub>/`, sealed per `sub`. | A durable, create-once link in the bucket (jot's `link.rs`). The account's notes are never moved or re-sealed. |
| depot | Depot users are owner-defined; `account` binds an identity to one. | Owner-selected. `accounts: ["wallet_0x…"]` beside `account` binds more identities to the same user, and one identity may name only one user. No user-driven link. |
| api-mcp-adapter | Nothing stored; `$user` is forwarded to backends. | Through eyesoff-ai: a linked wallet's turns name the account. |

**Making a link (eyesoff-ai).** Both credentials are presented together, in one
act. Requires a `wallet` block and `api_key_seed`.

1. **Prove the account** with either:
   - an EST1 token minted for THIS deployment in the last 10 minutes; a
     still-valid session token minted earlier is refused; or
   - this deployment's own EAK1 key for the account. This works with no
     issuer, which is the path when enclave.host is gone.
2. **Get the message.** `POST /auth/link/challenge {address, nonce, account}`
   returns an EIP-4361 message:
   - **statement:** "Link the Enclave account <acct> to this wallet on this app…";
   - **resources:**
     - `urn:enclave:deployment:<this id>` (only this deployment, never an
       `accept`ed one);
     - `urn:enclave:link:account:<acct>`;
     - `urn:enclave:link:proof:<keccak256 of that exact credential>`;
   - **window:** at most 10 minutes.
3. **Make the link.** `POST /auth/link {account, wallet}` verifies both again and
   returns the link credential:

   ```
   ELK1.<b64url({"acct","aud","v":1,"wallet"})>.<MAC>
   ```

   It is MAC'd with the EAK1 construction under the seed, with its own prefix.

**Refused.**
- A routine sign-in signature (session resources).
- A link message for another account, another credential, another deployment,
  or after its expiry.
- A stale EST1, or an EST1 for another deployment.
- A wallet's own key offered as an account.

**Using it.** The page keeps ELK1 in the browser and sends it as
`x-enclave-link` ONLY beside a sign-in by that same wallet.
- With it, `$user` and `/v1/keys` act as the account. The account's existing
  EAK1 comes back unchanged.
- Without it, the wallet is itself.
- A link presented beside another wallet's session is a 401, never a silent
  downgrade.

**Limits of ELK1, stated as the contract.**
- It is stateless: no expiry and no per-link revocation. Rotating
  `api_key_seed` revokes every link and every key.
- An account can be linked to several wallets, and a wallet can hold links for
  several accounts. Each one needs that account's own proof, and nothing
  records or prevents it.
- Replaying the same proofs inside their 10 minutes yields the identical link.

**jot.** `POST /api/link/challenge {address, nonce}` and `POST /api/link
{wallet}`, each with `X-Sso-Token`: an EST1 for jot's OWN audience, minted in the
last 10 minutes. Then two records, each created only if absent (`If-None-Match:
*`):
- `<prefix>.jot/links/wallet/<w>`;
- `<prefix>.jot/links/account/<a>`.

**The bucket is not an authority.** Each record carries HMAC-SHA256 under the
deployment's LINK KEY:
- **Key source.** `link_key` (a `$SECRET`, at least 16 characters) when the
  config names one, otherwise derived from `master_key`. The derivation is
  `HMAC(SHA-256(secret), "jot-link-v1:mac")`, a domain no note cipher scope uses.
  An unset or short `link_key` turns links OFF; it never falls back.
- **What the MAC covers,** length-prefixed: `jot-link-record-v2`, the direction,
  the deployment audience, the bucket, the prefix, the account, the wallet and
  the creation time.
- **What is believed.** A record is believed only if its MAC verifies for this
  exact context, direction and path. Records that are forged, copied (from
  another deployment, bucket, prefix, direction or identity path), edited, of
  the legacy unsigned v1 shape, or MAC'd under another key link nothing.
- **No key, no links.** With no link key configured, no record links anything,
  and none is even read.
- **Key rotation.** Changing the key makes every link inert. The links can then
  be made again, because inert records are replaced as described below.

**The rules:**
- **Inert until complete.** A wallet acts as the account only when both records
  verify and name each other.
- **No relink.** A complete link is never touched, so a second link for either
  side is a 409.
- **Nothing hidden.** A wallet that already has notes of its own is refused.
- **Nothing is ever deleted.** An inert or unauthenticated record is replaced
  only by a PUT conditional on the exact ETag that was judged (`If-Match`). A
  change between the judgement and the write therefore loses the write instead
  of overwriting. An interrupted attempt leaves at most an inert half, which the
  next proven attempt completes or replaces.
- **Read-back.** Both records are read back and verified, and success is
  reported only for a link that is complete as written.
- **Nothing moved.** The account's notes stay exactly where and how they were
  sealed.
- **No unlink and no transfer.** The operator can delete both objects (a denial
  only; deleting forges nothing).

**What the store must honour.** `If-None-Match: *` and `If-Match` on PUT (AWS
S3, R2 and minio do).
- **On a store that ignores them,** two racing link attempts can end with the
  last writer's link. Those attempts are only ever ones signed by the SAME
  wallet holder (or proven by the same account holder), so a race picks between
  links that party authorized. It never hands an identity to anyone who did not
  sign for it.
- **No atomic pair.** The two records are not a single atomic write: S3 offers
  no multi-object transaction, and none is claimed.

**What is NOT migrated, and is not claimed to be.**
- Nothing copies or re-keys data from `acct_…` to `wallet_0x…`.
- jot's export/import is not built; the API already lets the user read every
  note of their own.
- A passkey-only person without an EAK1 can link only while the issuer still
  mints EST1 for them. Once it is gone, an account with neither a fresh EST1 nor
  an EAK1 has nothing that proves it, and no app can recover that.

**Exactly what an existing account needs, per app.**
- **The fact this rests on.** An `acct_…` id is random (`relay/auth.js`
  `rid("acct_")`). The account→wallet map lives only in the relay's database,
  and EST1 claims name no wallet. Nothing outside the issuer can therefore tie
  an old account to a wallet: an app-issued credential or a link made while the
  issuer lived is the only bridge.
- **EyesOff.**
  - Chat history is in the browser and needs nothing.
  - The account's derived keys (EAK1) verify with only `api_key_seed`, forever.
  - Linking a wallet (ELK1) needs a fresh EST1 OR the account's EAK1. So an
    account holder who has (or reveals now) their EAK1 can link at ANY time,
    issuer or not.
  - The ELK1 is kept in the browser. On a new device, link again with the EAK1;
    keep the EAK1, like any API key.
- **jot.**
  - Notes are sealed under the account.
  - A link needs a fresh EST1, made once while the issuer still mints for the
    account. After that the stored, MAC'd link serves forever with no issuer.
  - An account that never links before the issuer stops has no way back to its
    notes: jot issues no account credential of its own.
- **depot.** Users are the owner's config. The owner adds the wallet identity to
  the same user (`accounts`), at any time, with no issuer.
- **api-mcp-adapter.** Stores nothing. Callers are named per request.

## Carrying an existing account across the issuer's retirement (EAB1, candidate)

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

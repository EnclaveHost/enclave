# Default independence: remaining feature-parity gaps (follow-up checklist)

Written for immediate assignment, per work/browser-default-coordinator-review.txt. Each item names:

- its exact sources and boundaries, and what is done here;
- what remains, and its preconditions.

"Hosted only" is never accepted as removal. No item below is claimed complete by this candidate.

## G-1 Credit-vault (hosted passkey/card) accounts: direct access without the relay

**Sources**
- `contracts/EnclaveCreditVault.sol` and `EnclaveCreditVaultFactory` (book key `vaultFactory` = 0xa891e4396e3eb11f364554043bc18e86da834e91 on Base).
- Live holders found on the ledger: 0x3e98aac0… (7 records) and 0x14b37ee3… (4 records), both 4,793-byte vault contracts.

**What the contract allows without the relay**

Any gas payer may submit a passkey-signed op:

- `controlDeployment(callData, deadline, WebAuthnSig)`. The allowed calls are `setAppRef`, `setActive`, `setShares`,
  `setConfig`, `setMaxRate`, `refund` (inward), and a `multicall` of those.
- `fundDeployment`, `deployAndFund`.
- `addKey` / `removeKey`.

Each op works as follows:

- Digest: `keccak256(abi.encode(OP_*, vault, chainid, nonce, …, deadline))`.
- `WebAuthnSig{authenticatorData, clientDataJSON, r, s, x, y}`. The WebAuthn challenge is the digest (base64url).
- `clientDataJSON` must begin `{"type":"webauthn.get","challenge":"…","origin":"<origin0|origin1>"`. The origins are
  implementation immutables, and the hosted one is `https://enclave.host`.
- `isValidSignature` (ERC-1271) accepts the same assertion.

**What it does not allow (by design)**

There is no `transferDeployment`, withdraw, or other outflow: records and credit stay vault-bound. `migrateToSuccessor`
(recovery admin only) moves credit to the same customer's vault at the book's current factory.

**Dependencies to finish**

| # | Dependency | Detail |
| --- | --- | --- |
| 1 | Reviewed pins | `vaultFactory`, the vault implementation code hash, and its `book`, added to the authority profile layout (network/authority-profile.mjs PROFILE_LAYOUT + LINKS, and the browser port site/js/core/authority-profile.js, parity-tested). Owner: authority-profile reviewers with the ledger17 migration (it repoints `book` keys). |
| 2 | Origin | The default build must be served at `https://enclave.host` (or `origin1`) for assertions to verify. A mirror on another origin cannot operate these vaults; that is a contract property. |
| 3 | Discovery | The vault address is `factory.vaultFor(x, y)` of the passkey's P-256 key. In the browser: one assertion (rpId `enclave.host`), then P-256 public-key recovery over `sha256(authenticatorData ‖ sha256(clientDataJSON))`. That gives two candidates; keep the one whose `vaultFor` has code and `keyActive(keccak(x, y))`. Needs ox `P256` in a vendor bundle (scripts/vendor/discovery-entry.mjs can add it). |
| 4 | Ledger binding | Before any op, check `book.addr("deployments")` equals the profile's ledger at the agreed block. The vault resolves the ledger from the mutable book on every call. |
| 5 | Module + UI | New `site/js/core/credit-vault-direct.js` (digest, assertion, simulation at an agreed block, submission by the wallet or the account bundler as gas payer). `deployments.js`: `ctlOf() === "vault"` rows routed there instead of `vault.js` (relay). |
| 6 | Tests | A fixture factory/implementation deployed on the fork with origin `https://localhost:<port>`, and a virtual authenticator. |

No private account mapping is exported: the browser derives its own vault from its own passkey.

**Done here**

- A hosted account stored in the browser is named on the dashboard, not silently dropped.
- Its relay session is not restored as "signed in" in independent mode.

## G-2 Relay-era and V1 session vaults: enumeration and migration

**Done here**

- The reviewed `legacySessionVaultFactory` (0x1f5c…, the relay's `SESSIONS_FACTORY`) vault of the wallet is found at an
  agreed block (`owner()` checked).
- Its records are listed read-only.
- "Release to my wallet" (`SessionVault.release(id, to, …)`): method checked in agreed code, simulated, then sent by
  the owner (site/js/core/sessions.js `legacyVaultOf`, `releaseLegacyRecord`; api.js `listDeployments`).

**Remains**

1. **V1 factory 0x00bB59c40768aA56E292b4E789f9f3B5826E3a8d** (contracts/deployments/sessions-base.json; windows/node/session-api-auth.mjs `FACTORY_V1`). It is not in the reviewed authority profile.
   - A live record is held by 0x081c60c7…, an EIP-1167 proxy to implementation 0xeca66443….
   - That implementation's `owner()` reverts, so its owner getter and release semantics must be reviewed before listing.
   - Owner: authority-profile reviewers (a `legacySessionVaultFactoryV1` layout entry). Then extend `legacyVaultOf` to a list.
2. **Per-session enumeration** (the hosted /sessions device list) for pinned and legacy vaults. It needs either a vault
   getter or agreed `SessionOpened`/`Revoked` log scans: site/js/pages/sessions.js independent branch +
   site/js/core/sessions.js. Today the pinned vault's live session and "End all sessions" (`revokeAll`) work; individual
   sessions of other devices are not listed.
3. Release of the relay-era rows was exercised on a Base fork with an impersonated real owner (see the result). Real
   owners act with their own wallet.

## G-3 WalletConnect

**Done here**

- An owner-chosen WalletConnect transport (`site/js/core/config.js` `ownerWalletConnect`, `site/js/core/wallet.js`
  `wcProvider` `relayUrl`, panel `independent-ui.js` `walletTransport`).
- Their project id, and a relay they pick (`wss://`, Reown's or self-hosted).
- Reads go through the profile's RPCs; no Enclave issuer.

**Remains**

- A browser test with a local relay fixture (a WalletConnect relay protocol implementation is needed for a fixture).
- The `wcOwnerLock` error text still names enclave.host (cosmetic).

## G-4 Downloads (host software, mobile) and in-browser verification

**Inputs that exist**
- outputs/native-cold-artifacts/release.json (guest runtime files with sha256; replicas.json lists 4 PLAIN-HTTP IPFS
  gateways, Enclave-operated).
- outputs/windows-independent-bundle.json (archive sha256 d87a51ac…, verified, not activated; no CID or published
  location recorded).

**Remains**

1. A release manifest naming each artifact's CID, sha256 and size. Owners: the host-image / windows-bundle release
   workers; site-release has the CAR/UnixFS tooling in scripts/site-release/.
2. HTTPS replicas. Chrome blocks plain-HTTP downloads from an HTTPS page.
3. UI: site/js/pages/host.js and site/host.html download buttons (today `https://get.enclave.host/...`). They should read
   the manifest packaged with the build (like the default profile), offer every replica, and verify the sha256 in the
   page (stream, hash, then save).
4. Mobile builds: the same, for the mobile build outputs (row "Downloads" tab, `mobileOffer()` in deployments.js).

**In-browser attestation verification**

- Today site/js/core/verify.js reaches hosts through `https://api.enclave.host/t/<box>` and `/enclaves`.
- Done here: live-verify, the fleet list and the enclave panel no longer fetch the API in independent mode, and say so.
- Remains: a verifier transport to a host's own operator-signed origin, as the management records do
  (network/management-record.mjs browser origins; site/js/core/independent-management.js). Then
  `verifyBoxInBrowser`/`verifyAppInBrowser` take the origin from the agreed lease and record, not from API_ORIGIN.

## G-5 Card payments, credit, checkout, device flow, SSO

- **Card processing** (Stripe Checkout) may stay an optional third-party integration. The mandatory Enclave parts are the
  ORDER and CREDIT issuers (relay/billing.js orders, the credit vault funding).
  - Interface needed: an owner/provider-chosen order issuer whose result is an on-chain fact. One option is
    `PaymentRouter` (pinned in the authority profile) paying USDC into the user's own account, or credit-vault funding by a
    provider chosen through the service index.
  - No Enclave issuer as the only path.
  - Sources: site/js/pages/checkout.js, site/js/core/pay.js, relay/billing.js, contracts/PaymentRouter.sol.
- **Device flow** (`/link`, relay account device codes): needs an account-level pairing that does not need the relay.
  - For the independent passkey account (a Safe), adding a passkey from another device is an owner operation already
    (site/js/core/passkey-account.js addOwner via `/grant`-style request).
  - Remains: a QR pairing UI on site/js/pages/link.js for the Safe account.
- **SSO** (`/sso/authorize`, relay `sso.js` EST1 tokens): app-release-migration22089 (direct account-issued app auth)
  is one dependency, not general SSO. Remains: an account-signed (ERC-1271) audience-bound token issued in the page
  (site/js/pages/sso-authorize.js) that tenant apps verify on chain.
- Done here: these pages show a precise notice and the explicit hosted choice in independent mode, instead of failing
  against the relay.

## G-6 Network tab: live route health, BYO WireGuard, paid providers

**Sources**: site/js/core/enclave-network.js (`renderIndependentNetwork`, `renderPaidProviders`,
`connectivityAddress` = address book), network/directory-server.mjs (`/v1/network/providers`, `/v1/network/routes`),
network/route-record.mjs, network/wg-config.mjs.

**Boundaries**

- **Health**: read signed route records from the chosen directories (`/v1/network/routes`, route-record v2 signatures)
  instead of the relay's status.
- **Paid providers**:
  - the authority profile already pins `connectivity` (0x5f8b…); `connectivityAddress()` must take it from
    `INDEPENDENT.authority`, not the book;
  - provider listings come from `/v1/network/providers` (signed provider records), verified as in
    network/provider-directory.mjs.
- **BYO WireGuard**: needs a private config transport to the host running the app. Candidates are the custody-v2
  owner-read channel (browser-secrets57842) or an HPKE upload to the host's management origin. Not public directories.

**Done here**: directory selection by operator, answers counted per operator.

## G-7 Display-only contracts: featured slots, ratings, host ratings

- Today they are address-book only (`featured`, `reviews`, `hostReviews`); the ledger17 plan repoints `reviews`/`hostReviews`.
- Remains: reviewed pins (authority profile layout) and then the browser profile.

## G-8 Rollout-dependent (not code in this candidate)

- HTTPS directories in the service index (today 4 plain-HTTP Enclave origins).
- Browser management transport on hosts (`browserHostRollout: false`).
- v2 storage adapters with gateway CORS (account-upload47233).
- An independent custody committee.
- Ledger17 activation (rehearsal PASS, not activated).
- These are gates G2–G5 of `scripts/network/default-profile.mjs gate`.

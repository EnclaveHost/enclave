# Browser follow-up: owner-names parity, the GPU panel, and the remaining-feature map

Workspace: `work/enclave`. HEAD is 3542e180 (GPU management) on top of ee0fd148 (independent host qualification and
owner names).
- Nothing was staged or committed.
- No production, SSH, chain write, Wine or GUI. No Chromium or anvil run: memory stayed at ~18.4 GiB available, and
  every run was a single Node job.
- I edited no CLI, Go, Windows or `network/*` module, and no naming-worker document. Edits were limited to site files,
  site tests and `docs/network/independent-dashboard.md`.

## 1. Owner names in the browser

**The earlier flag is no longer true.** "The browser fixed key list might still reject names" referred to the activation
gate in `docs/network/independent-names.md` (line 246, owned by the naming worker; not edited).
- `site/js/core/startup-package.js` `verifyPackage` allows the `names` member.
- Its `validateNames` is a line-for-line mirror of the SDK's and of the measured guest's `names.go`.
- Run over the shared vectors `isolation/m2/bootstrap/testdata/names-vectors.json` (38 cases, 3 aliases), the browser
  accepts and refuses exactly what the SDK does, and derives the same challenge aliases: 0 mismatches.
- The doc line can be closed by its owner.

**Changes made:**
- **Stale comment.** The comment in `startup-package.js` claimed the browser "only preserves names and never invents
  them". It now states that the module mirrors SDK and Go, is checked by the shared vectors, and builds names only from
  what the owner typed.
- **Explicit choices only, kept and now tested.** `namesFromForm` fills in no CA, responder or zone. A CA selection
  needs all three fields typed by the owner, or the `acme` member is absent (issuance happens outside the app).
- **New: `enclaveOperatedSelection(names)`.** The Startup tab's preview warns when an explicitly chosen CA directory,
  challenge responder or zone is under `enclave.host`. The schema allows such a choice, but it is not organizational
  independence. It is a warning, not a refusal, because the schema and the Go check accept an explicitly selected zone.

**New test: `test/site-independent-names.test.mjs` (4 tests, all pass).**
- **Vectors.** The browser's accept/refuse equals each vector's `valid`, and equals the SDK's.
- **Aliases.** Browser `challengeLabel` and `challengeAlias` equal the shared alias vectors.
- **Round trip.** Every valid vector carrying names goes from form input (names reversed and partly upper-case, CA
  fields one by one) through `namesFromForm`, giving the identical member and key order. `preparePackage` then gives
  bytes identical to SDK `preparePackage` of the vector manifest.
- **Explicit choices.**
  - Names only gives no `acme` member.
  - Each partial CA selection is refused.
  - ACME without names is refused.
  - `enclave.host` names are refused.
  - Enclave-run directory, challenge or zone choices are named, and independent choices produce no warning.

## 2. GPU status panel, on the committed shared operation

**Source.** The `gpu` operation (`GET /v1/deployments/<id>/gpu`, scope `api.status`, 1 MiB, not a mutation) was
committed in 3542e180.
- Before building I checked git status: all six bundle sources are clean at their commits.
- Commits: `management-routes.mjs` 3542e180; `-browser`, `-record` and `-outcome` b3256349; `canonical.mjs` and
  `net-guard.mjs` c2bc3cc6.

**Bundle rebuilt, prepared not activated.**
- `site/vendor/management.js`: 69,716 bytes, sha256 `768f7df64700a470cb0f4ce816c94441053b7922a77abceb2ec065174715240a`.
- The manifest records each source's sha256, its last commit, and that the file still matches that commit.
- `--check` passes. Nothing was published.

**Site changes.**
- `independent-management.js`:
  - `hostGpu(id)` is the same one-request path as the other operations: agreed lease, operator record, persistent
    floor, WebCrypto session signature, no retry.
  - The supervisor's `404 no_gpu` becomes kind `no-gpu` ("the host reports no GPU"), not a transport failure.
  - `gpuView(json)` is a pure summary of the supervisor's GPU view: role, MPS, SMs, free share, VRAM, VM rows and
    tenants. On Shield hosts it lists each card, and names every proof field as a host claim.
- `HOST_GPU_NOTE`: "Host-reported GPU state … not attestation and not a capacity reservation; free capacity can change
  before any claim."
- `api.js`: `hostGpu(id)`. In hosted mode it refuses with a plain reason.
- Manage tab:
  - A **"GPU (host-reported)"** button renders those rows. A Shield card's extra fields are listed as "the host's own
    claims; this page did not verify them". The raw answer is behind a disclosure.
  - On a CPU-only host, the panel doesn't offer the native fallback.
- Native fallback for GPU: the CLI has no independent `gpu` command yet. The panel shows `status <id> --host` and names
  `ManagementClient.gpu()` as the native read; it invents no command.
- No arbitrary-host GPU query is claimed: the operation reads only the deployment's current runner.

**Tests: `test/site-independent-management-unit.test.mjs`, 28 pass.** The GPU test runs against both the source helper
and the rebuilt shipped bundle.
- A request is exactly one GET to `…/v1/deployments/<id>/gpu`, and its header verifies over that host path.
- A session without `api.status` is refused with no request.
- `no_gpu` is reported as kind `no-gpu`.
- `gpuView`:
  - worker, VM and tenant rows are as the host stated them;
  - Shield card claims are named;
  - an empty answer gives no invented rows.

## 3. Mutations: 8 of 8 killed

Run in an isolated `/tmp/mut-names` copy (`site/` and `test/` copied, the rest symlinked), since removed.
- **Names:**
  - ascending-order check removed;
  - `enclave.host` names allowed;
  - a default CA directory filled in;
  - the Enclave-run choice not named;
  - the alias without the owner.
- **GPU:**
  - wrong scope;
  - `no_gpu` treated as a transport failure;
  - Shield claims hidden.

## 4. Regressions (single job)

111 of 111 passed:
- `site-independent-names` and `site-independent-management-unit`;
- `site-independent-review`, `-storage`, `-profile` and `-bundle`;
- `site-list-failure`, `site-session-auth`, `bootstrap-names`, `dashboard-host-auth` and `runlog-retry`.

Not run: Chromium suites, which are excluded by the memory allocation. The Manage panel's GPU button and the names
warning have not been rendered in a browser. The next Chromium run should be `test/site-independent-management.test.mjs`
plus a GPU click.

## 5. Remaining features (every feature kept as a goal; none claimed as replaced)

### Independent equivalents that exist
- **Through `api.js`:** listing, deployment and host reads, prices, availability as per-host posted prices (not
  capacity), and host management (status, logs, attestation document, restart, app token, CPU profile, GPU).
- **Elsewhere on the site:** deploy and fund on chain, Host & price, Startup (names, tier) and the Network tab. Also
  wallet sessions on the pinned factory, owner operations, pending CLI grants (`/grant`) and the native Connect profile.

### Needs a protocol (missing pieces named in `work/cli-remaining-interface.txt`)
- **Move.** The owner can't end a lease on chain (`release()` is runner-only). It needs a management `release`
  operation plus a signed placement-steer hint. The hosted `terminateDeployment(evacuate)`, `claimHint`, `getPlacement`
  and `savePlacement` have no independent path.
- **Free capacity / availability.** It needs signed per-host capacity records, or an owner capacity query. The GPU read
  is per deployment and host-reported, and is no substitute.
- **In-browser verification of host or app evidence.** The hosted Verify uses Enclave-reachable endpoints.
  Independent mode shows host-reported documents and points to the native client's SEV-SNP check. A browser-side
  verifier fed from an operator-signed origin is not built.

### Owned elsewhere
- Relay-held secrets: the independent form is custody-v2 inside the startup package; no secrets parity is claimed.
- Custody v2 UI integration.
- Host onboarding: direct-host and Windows workstreams.
- The CLI's Shield option for `bootstrap activate`.

### Hosted by nature: the account system is the relay
**The `api.js` methods with no independent path:**
- `accountRegister*`, `accountLogin*`, `accountSiwe*`, `accountLinkSiwe`, `accountMe` and `clearAccountSession`;
- `ssoToken`/`ssoSigner` and `accountDevice*` (CLI device-flow login);
- `createOrder`, `listOrders`, `getOrder`, `orderCheckout` and `orderUsdc` (card and order-provisioned deployments);
- `billingVault`, `billingTopup`, `vaultPrepare`, `vaultExec` (credit-vault deployments) and `accountDeployments`;
- `getNonce`/`login` (per-host SIWE sign-in; sessions replace this);
- `domainsMap` (relay-held domains);
- `health`, `version` and `getPricing` (relay facts).

**Also hosted:** WalletConnect (a third-party relay), phone app downloads, the live route map, store promotion
campaigns (gateway-metered views), and the `*.app.enclave.host` app names (`authorize.js` now says so).

**A wallet cannot be assumed to replace a passkey account.** A passkey account gives a user:
- no wallet, no ETH for gas and no USDC;
- card credit and a credit vault, with the relay paying gas;
- recovery through the account;
- CLI sign-in through device flow.

Independent mode requires an EOA wallet with gas and USDC. Equivalent capability would need architecture work that is
not done and not claimed here. Possible directions, all unbuilt:
- a passkey-controlled smart account (P-256 verifier) as a deployment owner;
- an owner-chosen bundler and paymaster, or a third-party fiat on-ramp, instead of the relay's credit vault;
- a recovery model;
- a device-flow equivalent for the CLI that issues SessionVault grants.

Until then, those users depend on the hosted service, and the feature map keeps them as open goals.

## Files changed this round

- `site/js/core/startup-package.js` (comment, `enclaveOperatedSelection`)
- `site/js/core/independent-management.js` (GPU, `gpuView`, `no-gpu`)
- `site/js/core/api.js` (`hostGpu`)
- `site/components/deployments/deployments.js` (GPU button, Enclave-run warning, `no-gpu` fallback)
- `site/vendor/management.js` and `management.MANIFEST.json` (rebuilt)
- `test/site-independent-names.test.mjs` (new)
- `test/site-independent-management-unit.test.mjs` (GPU cases)
- `docs/network/independent-dashboard.md`

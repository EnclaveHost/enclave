# custody-canary-wallet: administrator wallet handoff for the canary upload and catalog publication (source only, INACTIVE)

Root task ROOT-NEXT-HANDOFF (2026-10-23): this is parallel preparation only; root's recovery work has priority.

It is a local MetaMask handoff that performs two things. First, it uploads the ONE reviewed component
(`custody_canary_proof.wasm`, 101,222 bytes, sha256 `7ce32918…ee883`, CID `bafkreid44murq…xiqm`). Second, it publishes it
with `EnclaveAppCatalog(0x18419…).publishVersion` as the new free listing `custody-canary-proof 0.1.0`
(work/custody-proof-app-20261023 PUBLISH.md).

**Nothing was started, opened, uploaded, signed or sent.** No server ran outside the tests, no browser was opened on a
real wallet, no production endpoint was contacted, and no key exists here.

## What the administrator authorizes (disclosures)

| step | wallet request | what it authorizes | what it does NOT do |
|---|---|---|---|
| 1 | `personal_sign` of exactly `enclave-upload:7ce32918490b91b87c7ffa4cf69769c676b5b835ca11d55904b1511ef93ee883:<expiry>` (expiry = now + 300 s; the page shows the text) | the relay (`api.enclave.host`, operated by Enclave) mints a token for exactly these bytes until the expiry; the gateway pins them and charges the administrator's daily upload budget (4 GB/day; this is 0.1 MB) | not a transaction; moves no funds; grants nothing beyond uploading these exact bytes before the expiry |
| 2 | `eth_sendTransaction` of the freshly prepared `publishVersion` (value 0) | a NEW catalog app `0x85c5ed4c…13a0`, version index 0, free, approved on publish because the administrator owns the catalog | changes no existing listing, deploys nothing, and changes no secret, custody policy, committee, address-book entry or contract |

More detail on the signature and the effect:
- **Who sees the signature:** the relay sees it (exactly as with `enclave publish`). The relay keeps no replay store,
  so the token is reusable until it expires, but it only covers these bytes. This server sends the signature once and
  never writes or logs it: the journals hold only states, the expiry, the CID and the fetch results, and the tests
  check this.
- **No remote response bodies (root review of f161ceb).** An upstream error could echo the submitted signature or
  token, so relay, gateway and storage-fetch failures keep and show only a fixed diagnostic plus at most an HTTP status.
  - A gateway "CID" is kept only if it has the shape of a CID; a signature-recovery error never carries library text.
  - A test makes the fake relay and gateway reflect the signature and the token in their error bodies, and in the CID
    field. Neither appears in any response, page state or journal (on disk).
- **Rollback:** the catalog owner can later reject (`setApproval`) or yank the version. The listing record stays in the
  catalog's history.
- **Out of scope:**
  - no v2 activation transaction;
  - no contract change;
  - nothing that touches the old committee `0x4774`, whose code freeze cannot be bypassed;
  - the new-committee rollout is separate.

## Flow and state (two durable journals; one local origin)

**Upload** (`journals/upload.json`, `upload.mjs`). Every state is fsynced before its side effect.
- **States:** ready → authorizing (the message goes to the browser only after this is durable) → uploading → one of:
  - **stored-verified:** the gateway answered exactly the pinned CID, AND the bytes fetched back by that CID
    (`/ipfs/<cid>?format=raw`, capped at 101,222 bytes) hash to the pinned sha256 and CID;
  - **pinned-unverified:** the CID matched but the fetch-back did not verify yet. Only *Verify storage again* moves
    on.
  - **upload-unknown:** the add request was sent and no answer came back, so it may have pinned. A process that stopped
    mid-upload restarts here. *Verify storage again* (a fetch) moves on only when the bytes verify.
    - Any failed fetch keeps upload-unknown, with an honest reason. A timeout, 5xx or network error proves nothing, and
      a 404 is reported as "does not prove the earlier upload was not stored" (root review of f161ceb; the earlier
      version wrongly reset to ready).
    - There is no automatic re-upload. *Upload the same bytes again (outcome unknown)* is the administrator's explicit
      choice: it reopens a signed authorization for the SAME bytes and CID, and the earlier outcome stays recorded as
      never established.
  - **ready + lastError:** a definite refusal BEFORE anything reached the gateway.
  - **cid-mismatch:** TERMINAL. The gateway named another CID: nothing can be published; stop and ask root.
- **The signature:** checked locally before any network request. The signer is recovered and must be the
  administrator, and the message must be the journaled expiry's message, with ≥ 30 s left.
- **The file:** read with a hard 101,222-byte cap and re-hashed at begin and again before the upload.

**Publish** (`journals/publish.json`). This uses the reviewed transport (§ Reuse).
- **Gate:** `/prepare` is refused while the upload is not stored-verified, AND it re-fetches the stored bytes and
  re-hashes them at every prepare; the journal's word alone is not enough.
- **Fresh preparation:** every prepare runs the vendored, reviewed read-only preparer, which checks:
  - two RPCs at one agreed block;
  - book, ledger and catalog code hashes;
  - owner = administrator, with no pending handoff;
  - the new slug and the unlisted CID;
  - a settled nonce and the exact simulation;
  - L2 + L1-bound + Isthmus operator fee within the caps;
  - paced, budgeted reads with a freshness bound.
  Root's live run of the same preparer passed at 22:05Z (plan `0x34b77085…`, 54 requests, no 429, balance sufficient,
  total 8,225,833,055,021 wei).
- **Before MetaMask is asked:** the transaction is re-checked against the frozen sender, target, calldata, value and
  chain, and the bounded total must be covered by the balance.
- **One attempt per journal:** it is journaled before the wallet sees it.
- **Rejection:** only an explicit 4001 resets an unsubmitted attempt. Any other wallet error leaves it open and the page
  says so, never "success" and never "nothing happened". That covers a disconnected Trezor (-32603), a closed popup or a
  lost response.
- **Recording a hash:** a hash is recorded only if a provider returns that transaction with exactly the request's fields
  (same gas; fee caps not raised; no access list). A recorded hash is never replaced.
- **Verification:** two blocks deep and canonical on both providers, with status 1. The receipt must carry exactly
  `AppCreated, VersionPublished, VersionApprovalSet(…, 1)`, all from the catalog; this is the sequence observed on the
  deployed runtime, with no fee event. The readback at the anchor must match: `getApp` (publisher, slug, name,
  description, active, 1 version), `getVersion(appId, 0)` (CID, version, config, ports, resources, approval 1, not
  yanked), `numVersions` 1 and `versionFee` 0.
- **Reconcile** (for an attempt handed to the wallet whose hash was lost; `/reconcile` reads the chain):

| situation | result |
|---|---|
| prepared nonce used and the canary listed | keep the attempt: enter the hash from MetaMask's activity tab to verify |
| nonce used by another transaction and nothing listed | reset: the prepared transaction can never be mined |
| nonce unused on both providers, nothing pending, attempt ≥ 5 min old | reset (the page first tells the administrator to reject any open MetaMask request) |
| pending, too early, or the providers disagree | keep |

  After any reset the next prepare re-reads everything. A listing that appears later makes it refuse, and two
  transactions can never share the same nonce.

## Reuse: proven primitives, one minimal adaptation

| file | origin |
|---|---|
| `rpc.mjs` | byte-identical to custody-factory-wallet `rpc.mjs` (sha256 df00a18b…): READ-only method allowlist, two hosts, https only |
| `vendor/publish.mjs` | byte-identical to custody-proof-app ad81dd5 `publish/lib/publish.mjs` (sha256 d255587b…): the reviewed preparer with pacing |
| `style.css`, `app.css` | byte-identical to the factory handoff |
| `handoff-server.mjs` | the factory transport (sha256 fb189e46…) with three ADDITIONS (`evidence/handoff-server.diff`, 45 lines) |
| `app.js`, `stage.html`, `page.mjs`, `stage-app.mjs`, `serve.mjs` | adapted from the factory page and stage for two steps |

The three additions to the transport:
- **`gate()`:** `/prepare` refuses while the gate names a reason.
- **`routes`:** the `/upload/*` POST routes, behind the same host, origin, cross-site and token checks and the same
  body cap.
- **`reconcile()`:** the chain-based reset described above.

Nothing is removed or relaxed: same CSP, one durable attempt, journal before wallet, 4001-only reset, never-replaced
hash.

**Fixed surfaces only.** The server talks to exactly three upload URLs: `https://api.enclave.host/v1/apps/upload-token`,
`https://ipfs.enclave.host/add-wasm` and `https://ipfs.enclave.host/ipfs/<pinned CID>?format=raw`.
- Redirects are refused and every request has a timeout.
- It reads ONE fixed file path, and talks to the two reviewed RPCs.
- No URL, method, path, file or calldata comes from the browser.
- It listens on 127.0.0.1:39675, not the factory handoff's 39672; the factory server and its journal were not touched.

## How root would run it (after review; not done)

1. **Preflight:** in work/custody-proof-app-20261023, run `node publish/bin/publish-prepare.mjs --prepare`. It must
   report PASS with `balanceSufficient` true.
2. **Start:** here, run `node serve.mjs --serve`. It prints `http://127.0.0.1:39675`.
3. **Open the page:** the administrator opens it in the browser with MetaMask (Trezor-backed is fine) and clicks
   Connect.
4. **Upload:** *Sign upload authorization in MetaMask*. Compare the message with the page; on a Trezor, compare the
   text on the device. Wait for "stored and verified".
5. **Publish:** *Review publish transaction in MetaMask*. Confirm only if it matches the page, and do not edit gas or
   fees. The page then verifies the transaction after two blocks on two providers.
6. **Then:** the canary rules switch to `catalog://0x85c5…/0`, AppID `4f700c92…`, measurement `e5febd10…` (separate root
   review).

## Tests (unchanged queue, 512 lane; loopback only)

| suite | result | peak |
|---|---|---|
| `./q.sh 512 handoff-N ./run-tests.sh handoff` | 12/12 | 244 MiB |
| `./q.sh 512 browser-N ./run-tests.sh browser` (headless Chromium, single process) | 2/2 | 464 MiB |
| `./q.sh 512 mutants-N test/mutants.sh` | 21/21 killed | 252 MiB |

**Test environment:**
- anvil (chain 8453) with the deployed catalog's and book's exact runtimes at their production addresses, and a mock
  GasPriceOracle;
- two provider hosts, 127.0.0.1 and 127.0.0.2;
- a fake relay and gateway that recover the signer, check the HMAC token and compute the raw CID;
- an ephemeral test key, used only as the fixture's `uploadSigner`; production has no such field, and a test checks
  that. The publish is sent from the production administrator address by anvil impersonation.

**Covered:**
- pins and transport guards;
- the full path, including pending and then confirmed with readback;
- a wrong signer, a relay refusal, a changed file, expiry, 4001 versus other wallet errors;
- a wrong CID (terminal), wrong bytes served back (gate blocks; re-fetch at every prepare);
- a gateway that never answers, a crash mid-upload, and restart reconciliation by fetch;
- 404 and 502 fetch-backs keeping the outcome unknown, and the explicit same-bytes retry;
- reflected signature or token in upstream error bodies and in the CID field, plus a malformed signature: nothing leaks;
- a refreshed prepare refusing once the listing exists or the catalog owner changed;
- publish 4001 versus -32603, and a raised fee never recorded;
- every reconcile branch;
- a rejected-after-mining version never reported as published;
- browser: nothing asked before a click, the exact message and transaction, a Trezor disconnect on both steps, and a
  wallet `disconnect` event.

**Mutants killed:**
- the signer, CID, fetch-hash, gate, re-fetch and crash-state checks;
- re-authorization while the upload is unknown, any-error reset, changed file;
- transport gate, reconcile minimum age, published reset and pending checks;
- the raised-fee check and the readback;
- the privacy and unknown-outcome corrections: relay or gateway error body kept, a non-CID answer stored, a recovery
  error echoed, a failed fetch resetting an unknown upload, a retry without confirmation.

## Not verified / limits

- **Production gateway settings are unknown** (Kubo `Import.*`, `WASM_TOOLS`). The handoff compares the returned CID
  exactly, so a difference stops it before publishing.
- **Live behaviour:** relay and gateway rate limits and live MetaMask/Trezor rendering were not exercised.
- **What the wallet shows:** the message is passed hex-encoded, which MetaMask shows as text.
- **Budget:** the gateway's daily byte budget is shared with any other upload by the administrator.

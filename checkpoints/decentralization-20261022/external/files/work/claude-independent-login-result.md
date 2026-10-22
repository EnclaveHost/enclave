# Independent CLI sign-in without an Enclave authority: result

Repository: `work/enclave`. Nothing is committed, staged or applied outside my own new files.

I made no edits to `cli/enclave.mjs`, `site/*`, `sdk/*` or `network/*`. The glue for those is in patches only.

The full contract is in `work/independent-login-interface.txt`.

## Files and exact hashes (sha256, at report time)

| file | sha256 | lines |
|---|---|---|
| `cli/independent-login.mjs` (new helper) | `05def615e7e7f8e8b05cc4717b8e4265ab4ae102242b332d502052078c277d45` | 373 |
| `cli/independent-login-cli.mjs` (new commands) | `6db3cc606f0a9fffc112df3aefb69903fea67f6772418bb764291451f6361b6e` | 119 |
| `test/cli-independent-login.test.mjs` (new, real chain) | `f1695589dd35eb958db4e24726f7f944789502673b38e6aad3ec7ed8cf1dfd7f` | 292 |
| `work/independent-login-cli-glue.patch` (NOT applied) | `a211ee8e880ffbe75601fe2a4b6e2afc92c48eb7be3d21eb6199dab29dc1fe71` | 65 |
| `work/independent-login-browser.patch` (NOT applied) | `75d6923b1c20e01dcb0ea8bd73e173451e19c192cfaf11f7c0653be6d089f226` | 122 |

The patches were made against these base files:

| base file | sha256 |
|---|---|
| `cli/enclave.mjs` | `5c21db40f393806f9da44392c35174d626e580356a7b206c0f30a361e599125d` |
| `site/js/pages/grant.js` | `c068f3bebb5cd8affe639957be5d463245fc0a84e3af5fcb4f05455e35e3242e` |
| `site/js/core/sessions.js` | `736fadadd1c7d1be57bf6398c0d7379707fb0dbefd39b6ca85454c64c6b1f37f` |

The helper imports `canonicalHost` from `network/rpc-identity.mjs` (`74cb965e…5d57`). That file is the shared helper from my earlier RPC-identity task, which is still uncommitted. **It must be committed with, or before, this work.**

## What this delivers

`login`, `logout`, `account`, `session resume-wait` and `session top-up-link` now work in `--independent` mode. They previously refused or needed the hosted account service and relay.

It is a device flow carried by the chain itself:

1. The CLI makes a local P-256 key and a bounded grant using the existing SDK (`newSessionKey`, `buildGrant`).
2. It saves both before printing anything, then prints:
   - an approval link to the owner-chosen frontend origin, using the existing `/grant#` fragment format;
   - the check code.
3. The owner's own account signs with its wallet, or with a passkey Safe through ERC-1271.
4. Any gas payer opens the session through the pinned factory's vault:
   - the connected browser wallet;
   - or the CLI's own gas key, after `login --owner-signature`;
   - or the owner's own tooling.
5. The CLI adopts only the exact matching on-chain session. It learns this from quorum-agreed reads (`QuorumChain.snapshot`, `sessionSnapshot`) and a bounded, chunked, resumable scan for `SessionOpened` logs with our key hash.

There is no bearer token, mailbox, relay or Enclave endpoint. Nothing opens a browser.

Properties, with where they are enforced:

- **Binding.** Every login record binds chain id, factory and profile digest. The adoption rule checks:
  - sid = keccak(vault, key, nonce);
  - the vault is from the pinned factory;
  - the stored policy is exactly equal to the grant (key, measurement, actions, environments, app scope, every cap, period, ops);
  - expiry and budget are at least what was granted;
  - the session is live;
  - the owner is bound, pinned or explicitly confirmed.
- **Expiry.** The owner must sign before `signBefore`, which the vault enforces. Pending logins expire at the agreed CHAIN time, not the local clock, and the key is then deleted.
- **Revocation.** Adoption needs the session to be live. `logout` and `account` report the live state on chain.
- **Replay.**
  - The random grant nonce is part of the sid.
  - The vault rejects a second open of the same sid.
  - Logs whose recomputed sid differs are ignored.
- **Owner / identity switch.**
  - The first adoption pins the account.
  - A different `--owner` needs `--switch-account`.
  - In an unbound login, opens by other accounts are reported (`alsoOpenedBy`) and never followed without explicit confirmation (`--accept-owner`, or an interactive yes for a single candidate).
- **Phishing boundary.**
  - The CLI prints the check code and the frontend; the page shows `location.origin` and the code.
  - Both say: approve only a request your own command just printed.
  - A stolen link of yours is harmless, because the key stays local.
  - A link sent by someone else is the residual risk. The check code plus that sentence is the guard.
- **No secrets in URLs or logs.** The tests check that the link and every state file contain no PKCS#8. Key files are 0600 in a store outside git.
- **Crash resume.**
  - State is written atomically (tmp + rename, 0600) before the link is shown.
  - The scan position and candidates are saved after each chunk.
  - `login --resume` and `session resume-wait <id>` continue from them, including from a new process (tested).
- **Logout.** It clears only the local active pointer and never claims remote revocation. It names `session terminate` (session key) and the owner revoke as the separate ways to end the session. `--forget-key` on a live session is refused unless `--force`, and the refusal changes nothing.
- **Top-up.** `session top-up-link` only proposes an amount, as a `/sessions#topup=` link on the owner's frontend. The owner's account signs the USDC authorization there.
- **Gas payer.** It is always separate from the account, in both the browser patch and the CLI. See "Still open" for passkey-only first deployment.

## Tests (real local chain, injected real SDK, QuorumChain and FileStore; no mocked crypto)

Command, run in the foreground with no swap:

```
systemd-run --user --scope -p MemoryMax=512M -p MemorySwapMax=0 node --test --experimental-test-isolation=none \
  --test-concurrency=1 test/cli-independent-login.test.mjs
```

I launched it only when MemAvailable was 18.5 GiB, so at or above the 18 GiB floor.

**Result: 8/8 pass, 1.34 s, maxRSS 116,984 KB (about 114 MiB), exit 0.** The earlier run of the first 7 tests was also 7/7, at about 118 MB.

The test starts its own anvil (chain 31337) and deploys the existing compiled artifacts from `contracts/foundry/out`:

- MockUSDC3009;
- the ledger and catalog;
- PaymentRouter;
- SessionVaultLib;
- PinnedSessionVaultFactory;
- Mock1271Owner.

It uses only anvil's default dev keys. There are no new contracts and no external chain.

| # | test | what it shows |
|---|---|---|
| 1 | bound sign-in | The link carries no secret. The wallet owner approves; the CLI adopts exactly that sid, sets it active and pins the account. |
| 2 | ERC-1271 sign-only | A contract account signs. `signedOpen` checks the signature against the exact `openFor` at an agreed block (a bad signature is refused). A separate gas wallet submits. |
| 3 | foreign vault | An attacker who opens the same key in their own vault is never adopted. The pinned account, or an explicitly accepted one, is. `--owner` for another account is refused without `--switch-account`. |
| 4 | exact policy | Same key and nonce, opened with a wider policy: refused, nothing adopted. |
| 5 | resume, logout, top-up | A second helper instance resumes from the saved state. Binding to other trust is refused. Top-up link format and owner check. Logout keeps the session, says how to end it, and refuses `--forget-key` while live. |
| 6 | frontends | Origin only. https, or http on loopback only. Credentials, path, query and fragment are rejected; trailing dot removed. |
| 7 | command layer | `login --no-wait` prints link and code; `--resume`; `account`; `session top-up-link`; `logout`. `login --owner-signature` with a gas key and `sendTx` (`sendQuorumTx` shape). A missing frontend is refused. |
| 8 | expiry | After a time warp, the agreed chain time passes `signBefore`, the state becomes expired and the key is deleted. |

Patch checks, all done in a scratch copy under /tmp that was then deleted:

- `git apply --check` passes for both patches on the current tree.
- With both applied, `node --check` passes on patched `cli/enclave.mjs`, `site/js/pages/grant.js` and `site/js/core/sessions.js`.

## Bugs found and fixed during the work (all in my new files)

- A counterfactual vault (no code yet) made `sessionSnapshot` throw "not a vault of the pinned factory". Now no code means "no session yet"; anything else still throws.
- viem `getLogs` silently ignores raw `topics`, so discovery found nothing. It now uses `event` + `args: { keyHash }` + `strict`.
- `pending()` assumed ids starting `pending-0x`; real ids are `pending-<hex>`.
- `frontendOrigin` kept a trailing dot. It now uses the shared `canonicalHost`.
- `logout --forget-key` cleared the active pointer before refusing. It now checks first.
- Candidates found in earlier scan chunks were lost on later polls. They are now saved in the state.
- The test assumed a just-mined transaction is visible in one poll, but agreed reads can trail. The test now uses a bounded poll.

## Glue for the owning workers (reviewable patches, not applied)

- **`work/independent-login-cli-glue.patch` (CLI worker).** It:
  - routes login, logout, account, `session resume-wait` and `session top-up-link` to `independentLogin`;
  - removes their three refusals;
  - checks `assertReviewedCode(…sessionVaultFactory)` and `assertPinnedSessionFactory` first;
  - uses `SESSION_DIR/login` as the state directory;
  - uses `loadKey({required:false})` as the gas key unless `--unsigned`, and `I.sendQuorumTx` to submit.
- **`work/independent-login-browser.patch` (browser worker).**
  - `sessions.js`: a new `grantOwner()`. A verified passkey account signs through `passkeySafeOwnerSigner`; an unverified account refuses.
  - `grant.js`: the independent card uses the acting owner (account or wallet), and "Sign only" works without a wallet. It hands back `login --owner-signature <sig> --owner <account>`. The wallet is only the gas payer for "Approve and open". The card shows the origin and the phishing warning.

## Still open, with concrete designs

1. **Passkey-only first deployment is NOT solved.**
   - Opening the vault, and creating an undeployed passkey Safe, both need someone to pay gas. That can be the owner's own EOA used once, or an owner-chosen ERC-4337 bundler and paymaster (`passkey-account.js` already has prepare/sendUserOperation).
   - An undeployed Safe cannot pass ERC-1271. Signature-before-deployment needs ERC-6492 in the vault's owner check, which is a contract change and out of scope.
   - No default paymaster or vendor is chosen here, as instructed.
2. **Legacy hosted credit and order history in `account`.**
   - Independent `account` shows the pinned account, the active session's live state and pending sign-ins. The hosted credit balance and orders are not shown.
   - Design for migration: the service operator signs an export of each user's balance. The user's own account claims it on chain into a one-time credit vault or a ledger import function.
   - That needs a new contract or ledger entry point, which does not exist, so it stays open.
   - New funding already works without it, from the owner's own USDC (top-up / fund).
3. **Budgeted sign-in by signature hand-back.** A budget also needs the owner's USDC `ReceiveWithAuthorization`, so `signedOpen` refuses budgets.
   - Today: open a budgeted login from the frontend, or open with budget 0 and then use `top-up-link`.
   - Design: carry a second signature, `--usdc-authorization`, and use `openWithDepositFor` with the same agreed simulation.
4. **Frontend trust.** Distinct origins do not prove distinct or honest operators. The owner's protection is what their wallet or passkey UI shows them to sign.
   - Design: add a `frontends` list (origin plus content digest) to the authority profile, so the CLI can refuse unreviewed origins.
   - The profile has no such field today, so that is a profile and schema change for its owner.
5. **Windows (`windows/node/host-identity.mjs`) canonicalization** from the earlier RPC-identity task is still undone. See `work/claude-rpc-identity-common-result.md` (interim).

## Test limitations

- The glue was not run end-to-end through a patched `cli/enclave.mjs`. Test 7 drives `independent-login-cli.mjs` with a context built the way the patch builds it. The patched file was only syntax-checked.
- The browser patch was not run in a browser (no GUI allowed). It was only syntax-checked.
- `Mock1271Owner` stands in for a Safe. No real Safe, passkey (WebAuthn P-256) or 4337 bundler was tested on chain.
- The quorum is two clients of one local anvil. That tests agreement plumbing, not independent operators.
- Public-RPC `getLogs` range and rate limits are not tested. The scan is chunked (2000 blocks × 25 chunks per poll) and resumable, but a provider limit below 2000 blocks would need a smaller `scan.chunk`. It is a parameter, not yet a CLI flag.
- The time warp covers expiry only. Session-expiry and owner-revoke paths after adoption are covered only through the `live` flag, not as separate tests.

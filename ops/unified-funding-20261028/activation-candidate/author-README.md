# activation-r1: production initializer wiring for successor funding (source only, OFF by default)

Status: UNREVIEWED SOURCE. The author used only Read/Grep/Write. Nothing was executed: no python, no node, no tests, no
network. No hashes were computed. The four input pins in `prepare.py` were copied verbatim from
`successor-host-r1/generated/PREPARE-MANIFEST.json` "outputs", and `prepare.py` refuses if the files differ. No deployment,
signature, grant, nonce reservation or fund movement happened. The existing $30 session/grant is untouched. No address
here is claimed to be deployed.

## What was wrong

`successor-host-r1/generated/relay/sessions.mjs` `initSessions` passes `funding: fundingManifestFromEnv(process.env)` but
never builds `fundingQuotePolicy`, so the route always reports `funding_disabled`. There was also a deeper problem in
`createFundingRoute`, which uses ONE global gate (`why` / `M`):

| Dependency of `/funding/owner`, `/funding/end` (before) | Consequence |
|---|---|
| `M` requires the intake manifest AND a v2 quote policy AND the envelope guard | Turning intake off for rollback (dropping the policy) also turned off successor terminate / revokeAll / withdraw / sign-out |
| `ownerOp` / `end` / `sessionView` called `readPins()` | An expired intake manifest (`manifest_stale`), or any DEX / quoter / pool / ledger pin failure, locked owners out |
| `route()` started with `if (!M) throw 503` | No owner-control path existed without intake |

Owners can still call their vault directly on chain. The relay path, though, was coupled to intake. The deployment-r1
rollback plan ("disable intake while retaining owner terminate/revoke/withdraw") was therefore not achievable with that code.

## The narrow fix (marked `unified-activation-r1` hunks in generated copies; the inputs are only read)

`funding-route.mjs` (12 hunks):
- `parseOwnerControlsManifest` handles a new, INDEPENDENT, immutable owner-controls manifest
  (`enclave-funding-owner-controls-r1`). It holds only `factory`, `implementation`, `fundingGasLib` and
  `fundingSessionVaultLib`, each by address and runtime code hash. It has no `notAfter`, because deployed code is immutable.
- The gate is split:
  - **Owner controls** (`POST /funding/owner`, `POST /funding/end`, `GET /funding/session/..`, `GET /funding/owner/..`,
    `GET /funding/tx/..`) need the host pieces plus the owner-controls manifest. They do NOT need the quote policy,
    envelope, intake manifest or its expiry.
  - **Intake** (`GET /funding/config`, `POST /funding/quote|execute|open`) needs everything it needed before, PLUS owner
    controls on, PLUS identical pins for those four keys in both manifests. So intake can never be on without owner
    controls, and switching intake off never removes them.
- `readOwnerPins()` is what the owner routes call now instead of `readPins()`. At one latest block it checks: chain 8453,
  block age, all four runtime code hashes, the library-link substring, `factory.implementation()` and
  `implementation.factory()`. Everything after it is unchanged: `fundingVault` (factory `isVault`, CREATE2 prediction,
  `vaultFor`, exact clone runtime), presimulation (the vault checks the owner/session signature), the host's
  `simulateAndSend`, the ONE TxQueue, durable intents, `rateOwner` quotas and the control headroom.
- **Reviewer decision:** while intake is on, owner routes no longer re-check the DEX/ledger/adapter pins or the intake
  `notAfter`. Owner ops never touch those contracts, and the implementation's immutables are covered by its code hash. If
  the root wants those checks back, that reintroduces the lockout.
- `GET /funding/tx` for a pending **gas.fund** (`execute`) waits with 503 while intake is off. Its settlement proof needs
  the intake adapter. Nothing is resubmitted, settled or refunded, and the journal keeps the intent. Owner/end/open
  reconciliation works with owner controls alone.

`sessions.mjs` (3 hunks): it imports the loader, passes `ownerControls: o.fundingOwnerControls` to the route, and spreads
`fundingActivationFromEnv(process.env, { netName, chainId: chain.id, relayer: account.address, request: (args) =>
pc.request(args), log })` into the EXISTING `createSessionsService({...})` call. The spread goes right after the unchanged
`funding: fundingManifestFromEnv(process.env)` line. There is still one key, one account, one wallet client, one public
client, one TxQueue, one journal, the same network/RPC/factory env and the same owner/admin/API paths. `prepare.py`
refuses if the counts of `new TxQueue(`, `privateKeyToAccount(`, `createWalletClient(`, `createPublicClient(`,
`sendTransaction(` or the `SESSIONS_RELAYER_KEY/NETWORK/RPC/FACTORY` tokens change.

`funding-activation.mjs` (new, copied into generated/relay): the loader. It never throws, sends nothing and makes no
client, key or queue (`prepare.py` rejects such tokens in it). Any refusal leaves only its own piece off and logs
`[sessions] funding activation: ...`.

## Environment keys (all new ones default OFF)

| Key | Meaning |
|---|---|
| `SESSIONS_FUNDING_OWNER_CONTROLS` | exactly `1` enables successor owner controls; unset/empty = off; any other value = refused, off |
| `SESSIONS_FUNDING_OWNER_MANIFEST` | absolute path to the owner-controls manifest JSON |
| `SESSIONS_FUNDING_INTAKE` | exactly `1` enables intake (requires owner controls on) |
| `SESSIONS_FUNDING_MANIFEST` | (existing key) absolute path to the `enclave-funding-activation-r1` intake manifest |
| `SESSIONS_FUNDING_FEE_POLICY` | absolute path to the `enclave-gasfund-fee-policy-r1` config (fee-policy-r1 `parseFeePolicyConfig`: every field explicit, no default or fallback price) |
| `SESSIONS_FUNDING_RELAYER` | the relayer address the operator expects; must equal the account from `SESSIONS_RELAYER_KEY` |

Both pieces refuse:
- unless `SESSIONS_NETWORK=base` and the chain id is 8453 (so `local` with `SESSIONS_CHAIN_ID=8453` is refused);
- a relayer that differs from `SESSIONS_FUNDING_RELAYER`;
- the ten anvil/hardhat default accounts (list typed from memory: root, please verify).

Intake also refuses when:
- either manifest or the fee config has already expired at load;
- the two manifests pin different successor code;
- the fee config fails the policy schema (including any chain other than 8453).

Every config file must:
- be named by an absolute, normalized path with no symlink in any component (`realpath` must equal the path; opened
  `O_NOFOLLOW|O_NONBLOCK`);
- be a regular file of at most 16 KiB;
- not be world-writable;
- be valid UTF-8 holding one JSON object.

Duplicate JSON keys are NOT detected (last one wins). Root: decide whether that matters.

Owner-controls manifest shape (values must come from the ACTUAL deployment receipts and runtime reads, never from the
provisional `UNSIGNED-PROPOSAL-r1.json` predictions):

```json
{ "schema": "enclave-funding-owner-controls-r1", "chainId": 8453, "maxBlockAgeSec": 60,
  "addresses":  { "factory": "<deployed>", "implementation": "<factory.implementation()>", "fundingGasLib": "<deployed>", "fundingSessionVaultLib": "<deployed>" },
  "codehashes": { "factory": "<keccak(runtime)>", "implementation": "...", "fundingGasLib": "...", "fundingSessionVaultLib": "..." } }
```

A wrong or provisional address gets no relay send: every owner request re-reads code at the latest block and answers
`missing_code` or `codehash_mismatch` before anything is reserved (tested).

## Install file list (for the root's additive activation manifest)

Run `python3 prepare.py`, then copy from `generated/relay/`:
- `sessions.mjs` replaces `relay/sessions.mjs` (the only replaced file);
- `funding-route.mjs`, `funding-abi.mjs`, `fee-policy.mjs` and `funding-activation.mjs` are new in `relay/`;
- `sessions-abi.mjs` and `snp-verify.mjs` are symlinks to the unchanged originals (do not copy).

The three JSON config files live outside the code tree, owned by the service user, mode 0600/0640. Record their sha256 in
the activation manifest.

Activation order:
1. Deploy, then verify the runtime against fork evidence.
2. Owner-controls manifest + `SESSIONS_FUNDING_OWNER_CONTROLS=1` + `SESSIONS_FUNDING_RELAYER`. Restart. Check
   `GET /funding/owner/<addr>`.
3. Fee config + intake manifest + `SESSIONS_FUNDING_INTAKE=1`. Restart.

Rollback: unset `SESSIONS_FUNDING_INTAKE` (or remove the fee config) and restart. Owner controls stay on, and journals
are untouched. Full rollback: also unset `SESSIONS_FUNDING_OWNER_CONTROLS`. That leaves owners only their direct on-chain
vault controls, so do it only after reconciling pending intents.

## Tests (`test/activation.test.mjs`, 10 tests, NOT RUN)

What they use:
- the actual `initSessions` (2 boots: flags unset, and a malformed fee config with owner controls on; RPC pointed at
  closed `127.0.0.1:9`, a random throwaway key);
- the actual `createSessionsService`, the same constructor initSessions uses;
- the actual loader and the actual `createGasFundQuotePolicy` over fee-policy-r1's scripted EIP-1193 fixture, re-served at
  the route's pinned block.

What they cover:
- default off;
- owner-only (rollback) state: withdraw, revokeAll, terminate, sign-out and views on nonces 7–10;
- a real-policy quote bound to `configHash` and the pinned block, and `accept` refusing a fee it did not quote (nothing
  reserved or sent);
- rollback by restart over the same journal;
- expired intake manifest, and expired fee config, versus owner terminate;
- 13 malformed or mismatched config cases;
- provisional or other-code owner pins;
- the path/symlink/oversize/non-regular/world-writable/encoding cases of the bounded reader.

What they do not cover:
- The fake vault accepts `GOOD_SIG` by script. **No signature verification is exercised or claimed.**
- No gas.fund execute success. The exact native success fixture is root-tested separately and is not duplicated here.

Reproduce: `python3 prepare.py && node --test --test-concurrency=1 test/*.test.mjs`. Before an install copy, the root must
review `funding-activation.mjs`, set `ACTIVATION_SOURCE_SHA256`, and run `python3 prepare.py --require-pinned`.

Also still open: browser grant/migration (next task), the successor contract/grants (unchanged here), and the
`DEV_ACCOUNTS` list and the copied input pins, which the root should confirm.

# relay-owner-r2: successor owner management (UNREVIEWED SOURCE)

Status: **source only**. I (the authoring agent) executed nothing in this stage: no `prepare.py`, no node, no tests,
no forge, no RPC. I claim no test results. `generated/` and `patched/` do not exist until the root runs `prepare.py`.
Nothing here is production-tested, and no signature is crypto-verified by these tests. relay-r1 and `source/` were only
read, never written.

```
python3 prepare.py            # writes only inside relay-owner-r2/
python3 prepare.py --check    # must print "all outputs current"
node --test test/
```

## Files

| file | role |
|---|---|
| `funding-route.mjs` | relay-r1's route, extended: `/funding/owner`, `/funding/end`, views, `/funding/tx/:hash` reconciliation, canonical-receipt gate, strict event re-encoding, quote guards, vault-revocation checks |
| `prepare.py` | relay-r1's generator plus: marker `funding-r2`; exact ABI signature checks for every owner op/event; vault `deployedBytecode.linkReferences` must name both libraries; EIP-170 runtime-size check; constructor inputs, link offsets and Grant fields recorded in `PREPARE-MANIFEST.json` |
| `test/fake-chain.mjs` | relay-r1 harness plus `epoch`, owner ops, `terminateBySession`, `eth_getTransactionReceipt`, per-number block hashes, scripted host `simulateAndSend` / `rateOwner` stand-ins |
| `test/owner-route.test.mjs` | offline owner/end/open/canonical/quote-guard tests |
| `test/prepare.test.mjs` | static proof: stripping `funding-r2` blocks gives the pinned original, plus a check of the hook's content |

relay-r1's `funding-route.test.mjs` was **not** copied. Its regression coverage (pins, manifest, legacy holder, the
settlement mismatch cases) applies to unchanged code here, but has not been re-run against this module. The root
should port it (the receipts now need `mined()` so they are canonical), or run it against this file.

## Host patch (patched copy only)

There are five insert-only blocks. Removing them reproduces sha256 `457e8647…d0682d`, which `prepare.test.mjs` asserts.

The construction hunk passes:
- `ownerManagement: true`;
- `rateOwner: (owner, op, commit) => rateOwner(owner, op, commit)`: the host's own function declaration, which keeps the terminate/revokeAll exemption and counts only on commit;
- `simulateAndSend: (req) => simulateAndSend(req)`: the host's own function, with `afterSimulate` passed through;
- `pc`, `account.address`, `store`, `log`, `now`.

It adds no new queue, nonce, key or wallet client.

The original `/owner`, `/end`, `/open`, the original factory, the grant v1 path and `ingestLogs` are byte-identical.
The `/funding/*` dispatch is the first line of `route()`, and no original path starts with `/funding`.

There is no private route selector. `/funding/owner` is its own handler in the module. It resolves the vault only
through the pinned successor factory (`isVault` + CREATE2 prediction + `vaultFor(owner)` + clone runtime) and uses only
the successor artifact ABI. No body field can choose the factory, the ABI or the enablement.

**Still disabled in the patched host.** `initSessions` passes no `fundingQuotePolicy`, so every `/funding/*` answers
503 `funding_disabled` until reviewed host code supplies `{fee, accept}` and a reviewed activation manifest is set.
This stage contains no manifest, no addresses and no price oracle.

## Owner controls (`POST /funding/owner {owner, vault, op, args, sig?}`)

The ops are the original handler's set, with the same argument names. Types come from the successor artifact, and
`prepare.py` refuses to build if any signature drifts.
- `topUp`, `topUpWithAuthorization` (screened; the EIP-3009 auth goes in `args.sig`), `extend`, `terminate`, `revokeAll`, `withdraw`, `promote`, `adopt`, `setEnvironment`, `release`;
- plus `close` (signature-free; expired sessions only, as the contract decides);
- `ownerCall` is refused (`owner_direct_only`): it is `msg.sender == owner` on chain, and this route has no fake relayed authority.

The order for every op:
1. Strict body/args parsing (exact keys, non-zero `opNonce`).
2. Host `rateOwner(owner, op)` check (429 before any chain read; terminate/revokeAll exempt).
3. Pins at one block, then vault identity, then `owner()` must equal `body.owner`.
4. Real-vault simulation at the pinned block. **No JS signature check exists. The contract is the only verifier of the domain-2 owner signature.** A forged op stops here with 409, and nothing is marked or counted.
5. Host `simulateAndSend`. Its own simulation must pass before `afterSimulate` runs. `afterSimulate` writes the revocation first, then calls `rateOwner(owner, op, true)`:
   - terminate/close: `store.data.revoked[sid]`;
   - revokeAll: `store.data.revokedVaults[vault] = {at, block: null, successorEpoch}`, plus `revoked[sid]` for every indexed successor session of the vault.

   After that it broadcasts once through the existing queue.
6. Canonical gate (below). Only then are events folded and revokeAll's `block` recorded.

`POST /funding/end {vault, sid, deadline, x, y, r, s}` does `terminateBySession`. The real vault checks the session key's
SessionEnd signature in simulation; `afterSimulate` marks `revoked[sid]`. No owner quota applies, as in the original `/end`.

**Failure never weakens revocation.** Once the contract has accepted a revocation, a queue error, an on-chain revert, a
pending receipt or a settlement mismatch leaves the off-chain mark in place.

**Fresh sessions are not permanently blocked.**
- `revokedVaults[vault]` with `block == null` refuses every session of the vault for 600 s, as the host's `revokedBeforeOpen` does.
- After that, sessions with `epoch <= successorEpoch` (the vault epoch read before the revokeAll) are refused, and later epochs pass.
- A completed revokeAll bumps the epoch, so new sessions carry `epoch + 1` and are served (tested).
- If a revokeAll never lands, same-epoch sessions stay refused off-chain. This fails closed; the owner re-submits.

## Quote / execute revocation and guards

Before any chain read, quote and execute refuse on `revoked[sid]` **and** on an in-flight vault revocation. Relay-r1
only checked sids.

After reading, they also refuse on:
- `!live`;
- `session.epoch != vault.epoch()`;
- `epochRevoked`.

The new guards, matching client-r1 `preflightGasFund`, are evaluated at block time after the period-reset rule:
- `opsPerPeriod != 0 && periodOps >= opsPerPeriod` → `op_limit`;
- `periodOps == 2^32-1` (even when "unlimited") → `op_counter_exhausted`;
- `seq == 2^64-1` → `nonce_lane_exhausted`, with no nonce wrap.

## Canonical receipts

Every write (execute, open, owner, end) passes through `completed()`, which requires all of the following:
- a non-zero 32-byte `blockHash` and a positive `blockNumber`;
- `pc.getTransactionReceipt(hash)` with the same tx hash, block hash and number;
- `pc.getBlock({blockNumber})` with the same hash;
- every log carrying that block hash and tx hash.

Otherwise it records `store.data.fundingPending[txHash]` (bounded to 500) and answers **202
`pending_reconciliation`** with the tx hash. In that case:
- nothing is indexed;
- nothing is resubmitted;
- nothing is called failed or refunded;
- no new nonce is used.

`GET /funding/tx/:hash` re-reads it, read-only. A canonical revert answers 409 and keeps any revocation. Indexes are
updated only from the **node's** canonical receipt, never from the host's returned object.

**Strict events.** Each vault/adapter log is decoded, then re-encoded (topics and data), and must match byte for byte;
an undecodable vault/adapter log refuses settlement. `SessionOp.result` must be exactly 64 bytes and canonical.

## Index and views

- Successor-only namespaces: `fundingSessions` (`openedBlock` from canonical SessionOpened), `fundingOps`, `fundingVaults`, `fundingPending`.
- Shared with the host: `revoked` and `revokedVaults`, keyed by successor addresses/sids, so they never collide with original vaults.
- Views: `GET /funding/session/:vault/:sid` (never more live than the relay's revocation state) and `GET /funding/owner/:addr`.

## Remaining wiring before the whole flow can be enabled (exact)

1. **A reviewed host quote policy** `{fee, accept}`, passed as `o.fundingQuotePolicy` in `initSessions`. The activation is gated on it.
2. **A reviewed activation manifest** (`SESSIONS_FUNDING_MANIFEST`), with addresses and runtime hashes read from the real deployment and checked independently. None exists here.
3. **Patched-runtime test (root).** Drop `patched/relay/*` into a source-tree branch, then:
   - run the original relay suite unchanged;
   - run these routes through the real `createSessionsService`, including the real `rateOwner`, `simulateAndSend` and `TxQueue`, on a Base fork;
   - sign real domain-2 owner ops, SessionEnd and P-256 signatures.
4. **TxQueue preconfirmation.** The host queue's early `_done` acceptance is unchanged; root reviews it separately. This module only refuses to treat such receipts as complete. It does not fix the queue journal.
5. **Event ingestion for owner-direct actions.** The host `indexOnce`/`ingestLogs` does not scan successor vaults, so on-chain owner-direct `terminate`/`revokeAll` reach the relay only through the chain reads (`live`, epoch) at quote/execute time, not through the off-chain index.
6. **Not supported** (no API permissions are granted by default):
   - `verifyApiRequest` / API scopes for successor sessions; `/funding/open` refuses grants with any bit ≥ 128;
   - `/by-key`;
   - the keeper's automatic `close`;
   - Exposing these needs a separate review.
7. **Build link verification.** The manifest's library check is an address substring, and the artifact `linkReferences` check is a build pin. Neither proves deployed call sites. Verify the linked runtime against the deployment byte for byte.
8. **USDC proxy admin** stays a trust risk: the code-hash pin covers the proxy only.
9. Client/SDK/UI wiring for domain-2 owner ops (client-r1 `buildOwnerOpV2`) and an operator runbook for relayer USDC.

## Known limits of this stage

- **Tests:** offline, scripted transport only. "Forged" signatures are scripted reverts. Code blobs are synthetic. The host helpers are stand-ins (`hostSend`, `hostRate`).
- **Event checks:** a specific event is required only for topUp(WithAuthorization), extend, terminate, close, end and revokeAll. withdraw, promote, adopt, setEnvironment and release are checked only for success, canonical inclusion and strict decoding of vault logs, because their exact emission was not re-derived here.
- **`close` and quota:** `close` needs no signature, so anyone naming the owner can spend that owner's daily quota with closes of genuinely expired sessions (at most one per session).
- **Simulation timing:** the host's `simulateAndSend` re-simulates at *latest*, not at the pinned block.
- **Migration:** no automatic migration of old sessions and no new wallet-funding request. The original sessions (including the $30) are never touched.

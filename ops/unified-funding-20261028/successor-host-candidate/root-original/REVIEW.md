# successor-host-r1: durable successor intents on the actual host queue (source only, nothing run)

UNREVIEWED SOURCE. Its author executed nothing: no python, no node, no tests, no Anvil, no network, no signing. No sha256 in
this stage was computed by the author; every hash below was copied from a root-written manifest. No PASS is claimed.
Activation stays OFF: no hunk wires a quote policy or activation manifest into `initSessions`.

## Provenance (inputs, read only)

| Input | sha256 (from fee-policy-r1/generated/PREPARE-MANIFEST.json "outputs") |
|---|---|
| fee-policy-r1/generated/relay/sessions.mjs | 852ded20b389321f7344ad7dbd436c54242b5ee95e847073bb89406c5719c5d8 |
| fee-policy-r1/generated/relay/funding-route.mjs | ddbd856c9c3a832cd252719df23c13ca08eb4c4ed747585e0daa38abf0c23966 |
| fee-policy-r1/generated/relay/funding-abi.mjs | 6bb37e658aca45fd416d5ea17dda3109e1b41791e674976a60425d579f485cd7 |
| fee-policy-r1/generated/relay/fee-policy.mjs | 32bcf03ea52db9be70d86e957dd440c1697daf0eaeab79f732378002d4f2bcfd |

Chain of composition, each a pinned, marked, reversible generator: `source/relay/sessions.mjs` (457e8647…) →
relay-owner-r2 funding-r2 inserts → host-queue-r1 canonical-receipt TxQueue (eb0f5543…) → fee-policy-r1 envelope hunks
(852ded20…) → **successor-host-r1 hunks (this stage)**. `prepare.py` refuses to run if any pinned input differs, if the
fee-policy manifest names different outputs, records unpinned inputs, or does not say activation OFF, or if any hunk anchor
is not found exactly once, or undoing the hunks does not return the input byte for byte. The fee-policy envelope code
(`_envelopeStart`, `_envelopeAttempt`, replacement caps) is carried unchanged; nothing in fee-policy-r1 was edited.

Tests import read-only fixtures from sibling stages (relay-owner-r2/test/fake-chain.mjs and what it imports,
host-queue-r1/test/fixture-rpc.mjs). Their hashes are recorded in the manifest under `test_inputs_observed_unpinned`;
the root should review and pin them.

## The fix

Problem: the queue throws `503 tx_pending` (with `extra.txHashes`) or `nonce_busy` (naming ANOTHER record's hashes), while
the route's `completed()` only recorded pending state after a receipt came back. A lost response, timeout or restart lost
the metadata, and a client retry was a new call: the queue's journal-nonce fence does not stop that once the provider's
pending nonce has advanced past the first broadcast, so the same signed intent could go out under a second EOA nonce.

Change (one durable intent per signed intent, in the SAME queue journal; no new wallet, signer, nonce source or queue):

- **Identity** (`intentKey`, route): keccak(kind, 8453, relayer, target, exact calldata with ONLY the signature words
  blanked). execute: sid/nonce/action/args/fee/deadline/x/y (r, s blanked). open: owner + full grant + deposit window
  (owner signature and EIP-3009 signature blanked). owner ops: op + every signed argument including the owner's opNonce
  and signBefore (last argument, the signature/authorization, blanked; unsigned close has nothing blanked). end: the signed
  sign-out (r, s blanked). Alternate signatures over the same intent are therefore the same submission.
- **Lookup first, read-only**: every handler looks the key up before quota checks, pins or simulation. An existing live
  submission is answered from the journal (reconciled over all its hashes) and is never sent again.
- **Reservation** (`TxQueue.reserveIntent`): inside the host's `afterSimulate`, i.e. only after the route's pinned-block
  presimulation AND the host's simulation accepted the signature, BEFORE the owner quota is committed and before
  `queue.send`. A forged signature reserves nothing and counts no quota. Flushed to `journal.data.intents` immediately;
  the queue record created for it carries `rec.intent`/`rec.intentGen` from its first flush, which precedes any broadcast.
  JS run-to-completion makes the check-and-reserve atomic: of simultaneous duplicates exactly one reserves; the others are
  answered (`intent_in_flight` / pending / done).
- **Outcomes** (`intentSubmit` / `intentAnswer` / `completed`), hashes ALWAYS read from this intent's journal record,
  never from a queue error:
  - no record of this intent (refused before journaling: envelope, estimate, `nonce_busy` from an earlier tx, journal
    full, or record status `nonce_lost`/`nonce_busy`) → reservation released; the error carries `sent: false` and any
    hashes it named as `blockingTxHashes`, never as `txHashes`;
  - record with hashes, not canonical → `202 pending_reconciliation` with every hash (replacements included), each bound
    to the intent in `fundingPending`;
  - record without a hash (`send_failed`, or `sending` after a crash mid-broadcast) → `503 intent_unknown`, fenced: no
    automatic rebroadcast, operator reconciliation required (the queue's existing nonce fence also stays);
  - canonical revert → only that submission's hashes cleared, intent `reverted` with the exact hash, `409 reverted`
    (`onChain: true`) — distinct from the host's simulation refusal `409 revert`. The host's `simulateAndSend` returns the
    reverted receipt only to intent callers; every original route keeps its original 409;
  - canonical success → FINISH (index) and `settle(done)` in one synchronous step, so indexing happens exactly once; all
    associated hashes cleared; later requests get `{ txHash, block, intent, already: true }`.
- **Reconcile** `/funding/tx/:hash`: resolves the hash to its intent (store index, else the journal) and observes ALL of
  its hashes, so a landed replacement finalizes a request made with the first hash.
- **Bounds, no eviction**: `recordPending` no longer evicts. At most 500 unresolved intents; a new one is refused
  (`503 journal_full`, nothing reserved or sent) — only resolved ones (done / reverted / an earlier process's reservation
  that never journaled a record) are dropped. terminate / revokeAll / sign-out get 64 extra slots so recovery is not
  locked out by volume. The queue's record pruning additionally skips records of unresolved intents.
- **Restart**: reservations carry the process `boot`. A reservation from an earlier process with no journal record
  provably broadcast nothing (records are flushed before broadcast) and may be reused; one with a record is answered.
- **Activation**: the route stays off unless the host passes the queue's intent journal (`intents`).

Owner controls are unchanged in authority: the contract still verifies every signature; terminate/revokeAll stay
quota-exempt and keep their off-chain revocation in `afterSimulate`; an unrelated pending intent has a different key and
does not block them (the queue's own nonce fence still applies; see limits).

## Tests written (not run)

`test/intent.test.mjs` imports the ACTUAL `createSessionsService`, `TxQueue`, funding route and fee-policy `makeEnvelope`
from `generated/relay/`. Chain reads/simulation are relay-owner-r2's scripted fake chain; sends/receipts/blocks are
scripted per test; the quote policy is a labelled TEST policy (fixed fee). Cases: canonical success with
reserve-before-broadcast assertion and alternate-signature retry; invalid signature reserves nothing; delayed
preconfirmation with retry after the provider's pending nonce advanced; replacement-hash finalization; simultaneous
duplicates + alternate signature; restart; no-hash ambiguity (also after restart); crash after broadcast before the hash
returned; earlier transaction's `nonce_busy` never attached; canonical revert clears only its submission; journal bound
and control headroom; forged owner signature consumes no quota and terminate is not blocked by an unrelated pending
intent; HTTP adapter 202 body; activation off without the intent journal and no policy in bootstrap.

`test/legacy-host.test.mjs`: host-queue-r1's original `/end` route cases against the composed copy (unchanged answers,
`409 revert`, `503 tx_pending`, replacements identical) and funding off without configuration.

Expectations in these tests were derived by reading the code, not by running it; a first run may expose test or source
errors. Scripted transports prove control flow only, never EVM behaviour or signature validity.

## Commands for the root

```
cd successor-host-r1
python3 prepare.py && python3 prepare.py --check
node --test --test-concurrency=1 test/*.test.mjs
```

Existing suites are untouched and stay reproducible in place (this stage writes nothing outside itself): relay-owner-r2
(the 68 = 36 prior-route + owner/static/root regressions), host-queue-r1 (34 queue/static + 5 route), fee-policy-r1 (30
policy + queue envelope/regression). Re-run them unchanged in their own directories. They do not exercise this copy.

## Limits (honest)

- Nothing executed. Hashes of outputs, hunk results and test fixtures are computed only when the root runs `prepare.py`.
- Crash after broadcast before the hash returns is NOT solved, only fenced: the record (`sending`, no hash) blocks any
  rebroadcast of the intent and needs operator reconciliation. Solving it needs a deterministic signed hash journaled
  before `sendRawTransaction` (local `signTransaction`), a change to the shared queue's signing path not made here.
- `send_failed` without a hash is treated as possibly broadcast (fail closed), even for errors that were clearly
  pre-broadcast; the queue's existing nonce fence may then hold the lane (including relayed terminate/revokeAll) until
  reconciled. Owners can always call their vault directly.
- A canonical revert makes the intent reusable (the vault nonce was not consumed); canonical is at observation on one RPC,
  not finality. A reorg after completion is not watched.
- `fundingPending` lives in the non-durable index store; the authoritative state is the durable queue journal and
  reconcile falls back to it. Pending records written before this stage (no `intent`) are answered 404.
- Fee policy is NOT live-chain qualified or activated; the tests use a fixed TEST policy. No production bootstrap change.
- No authenticated operator UI for reconciliation.

## NOT DONE: native Anvil host fixture (exact remaining steps; no pass claimed)

Not attempted in this task (time). Required next, as one test file plus a runner, Anvil/public fixture keys only:

1. Start an owned Anvil with `--chain-id 8453` bound to 127.0.0.1 only; the test must assert the RPC URL host is a
   loopback literal, `eth_chainId` is 0x2105, the node reports `anvil` in `web3_clientVersion`, and the relayer/owner keys
   are the public Anvil mnemonic accounts; refuse otherwise. Native P-256 precompile (Osaka) required, no verifier shim,
   no `--code-size-limit` override, no skips (fail if anvil/forge/artifacts are missing).
2. Deploy from session-r1 `out/` artifacts (fail closed if missing): FundingGasLib and FundingSessionVaultLib, link them
   into the FundingSessionVault implementation, FundingSessionVaultFactory, LeaseGasDexAdapter, plus the original legacy
   factory/implementation, book and ledger via the production deploy scripts as host-queue-r1 staging did. DEX pool,
   QuoterV2, swap router and reserve as clearly labelled MOCKS (the actual Base contracts were qualified separately in
   dex-fork-r1/session-fork-r1); build the activation manifest from the deployed code hashes.
3. Run the composed host (`generated/relay/sessions.mjs`) through its real HTTP `handle()` on a loopback server with a
   real viem wallet client for the Anvil relayer key, the SAME TxQueue, the actual fee-policy envelope guard, and a TEST
   quote policy object (or the reviewed policy with a scripted feed if root prefers); activation only inside the test.
4. Client side with client-r1 codecs: owner EIP-712 domain-2 grant signature (Anvil key) → `/funding/open` with an
   EIP-3009 deposit; session key from Node `generateKeyPairSync("ec", P-256)`; `/funding/quote` → sign the gas.fund
   intent → `/funding/execute`. Assert on chain: actual USDC debit + refund = signed maximum, one relay fee, reserve
   top-up/ETH out, journal intent `done`, index exactly once; then invalid signature (409, no reservation, no send),
   non-granted action (403/409), `/funding/end` and `/funding/owner` revokeAll/terminate; legacy vault and wallet-held
   ledger ownership unchanged.
5. Repeat one execute with a forced lost response (drop the HTTP reply) and retry: one broadcast, same hash.

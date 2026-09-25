# The pVM runner lifecycle agent (DESIGN; the slice built so far is listed at the end)

**What this is for.** A Pixel pVM that serves one app needs an owner-side process to keep its lease working on the
ledger. In PROOF-KEY.md "Activation, exactly", step 4 (registration and claim), step 5 (proofs), heartbeats, renewals and
the final release are all the OWNER's operator-key transactions. The proof-posting agent (runner/proof-agent.mjs) already
does step 5. This agent adds the rest around it, from the same operator key, through the same journal.
- The contract calls it makes are the metal supervisor's (supervisor.js `registerOnChain`, `renewLeases`, `releaseLease`,
  `proveFinalPeriod`).
- Nothing new is put on-chain: no contract changes and no new wire format.

LAB until the owner supplies the production inputs listed at the end. It runs on a local chain with synthetic operator
keys. No invented production wallet, price, fee cap, deployment, pins or route is used.

## What the contracts require (read from the source)

| call | contract | who | requires | effect |
|---|---|---|---|---|
| `register(endpoint, repo, measurement, cpuPrice6, gpuPrice6, proofKey)` | EnclaveRegistry | anyone first, then only the entry's operator | a cpu price > 0 | creates or RE-STATES the whole entry: active, prices, proof key, `lastSeen` |
| `setProofKey(id, key)` | EnclaveRegistry | operator | the entry exists | the key only; allowed mid-lease |
| `heartbeat(id)` | EnclaveRegistry | operator | the entry exists | `lastSeen = now`, and **`active = true`**: a heartbeat revives a deregistered entry |
| `deregister(id)` | EnclaveRegistry | operator | the entry exists | `active = false`; the key and the entry stay |
| `claim(id, enclaveId)` | EnclaveDeployments | the entry's operator | the deployment active and unleased (`now > leaseUntil`); the entry active with price > 0; a proof key (rev 9); a bond when `claimBond6 > 0`; funded at this runner's rate | runner, operator and `leaseUntil = now + quantum` are set; **`provenUntil = now`** |
| `renew(id)` | EnclaveDeployments | the lease's operator | active, `now <= leaseUntil` | burns one more quantum of the TENANT's balance and extends from `leaseUntil` |
| `release(id)` | EnclaveDeployments | the lease's operator | none | credits the time held, refunds the tail, **clears `provenUntil`** |

Four facts drive the design:
1. **A second `renew` spends the tenant's money.** supervisor.js records a live incident where a missed receipt renewed
   again every cycle.
2. **`release` clears the watermark.** The final checkpoint must be confirmed BEFORE `release`.
3. **A heartbeat re-activates an entry.** The agent must never heartbeat an entry it found inactive, unless the owner's
   config says to serve.
4. **A claim needs the proof key already registered,** and the prover pays only for proven time. The agent claims only
   after the VM's attested key is the registered one.

## The design

**One operator key, one journal, one transaction in flight.** Every transaction is signed locally and journaled before
any node can see it: checkpoints and lifecycle calls alike. This extends the proof agent's engine with an "intent" record
(the op, the contract, the calldata, the event it must produce).
- A tick first RESOLVES whatever the journal says may be in flight, by rebroadcast, replacement at the same nonce, or
  confirmation.
- Only then does it read the chain and decide.
- So an interrupted renew is followed to its end, never re-decided while it may still land.
- Two transactions at the same nonce can never both land. That is what makes a fee-bumped replacement of a renew safe.

**Decisions are read from the chain, never remembered.** Each tick takes these in order and sends at most ONE
lifecycle transaction, settled before anything else:
1. **The entry.**
   - Missing: `register` if the owner configured `register` (repo, measurement, price); otherwise stop with
     `registry-missing`.
   - Another operator's: stop with `endpoint-taken`. Never touched.
   - Inactive: re-`register` only if configured to register; otherwise stop with `registry-inactive`. It is never revived
     by a heartbeat.
   - Its proof key is not the VM's attested key: `setProofKey` to the attested key (the only source of that key is
     `verifyPvmProofKey` over the agent's own nonce).
2. **The lease.**
   - Ours and live, and within `renewMarginSec` of its end (default 600, as supervisor.js): `renew`, but ONLY if the
     proofs show the app serving, meaning the prover's `lastProofAt` is within `2 x intervalSec` of now. A dead app's
     lease lapses instead of spending the tenant's balance.
     - The signal is NOT `provenUntil`. The prover advances `provenUntil` by at most the time elapsed since the last
       proof. So after any outage longer than its window, `provenUntil` trails now by the outage for the rest of the
       lease, even while fresh proofs land. Gating on it would never renew again.
     - The local test first surfaced this through its own time jumps.
   - Open, and `claim` configured: `claim`, after a simulation (which refuses an unfunded, capped or already-taken
     deployment with the ledger's own reason) and the attested statement naming THIS deployment. Open means unleased, or our own lease lapsed, which is re-claimed in place.
   - A bond the owner did not authorize: `bond-required`, and no claim.
   - Another runner's live lease: nothing.
3. **The heartbeat**, if the entry is active and `now - lastSeen >= heartbeatSec` (default 900, as supervisor.js).
4. **The proof:** the posting agent's tick, unchanged, while the lease is ours.

**Stop and release.** `stop({ release: true })` takes these steps in order. Each is settled before the next, and each is
journaled so a restart resumes at the right point:
1. It resolves anything in flight.
2. It posts a final checkpoint. This waits, bounded, for the VM's 60 s signing gap. It is skipped if the VM no longer
   signs, in which case the unproven tail is forfeit, as the contract intends.
3. It sends `release`, and confirms the `Released` event and the cleared row.
A restart after step 2 goes straight to 3; the watermark already covers the served time.

**The events each call must produce** (from the call's own contract, for this id):
- `Registered` or `Updated`, for register;
- `ProofKeySet`;
- `Heartbeat`;
- `Claimed` (its `until` becomes the lease);
- `Renewed`;
- `Released`.
A mined transaction without its event is a failure, not a success.

## Interruption: what a restart must never do

| interrupted after | the journal holds | the restart does | never |
|---|---|---|---|
| journaling a renew, before any broadcast | intent + raw tx | rebroadcasts the SAME bytes, then follows them | a second, different renew |
| broadcast, before the receipt | intent + raw tx | follows the receipt; if it never mines, replaces at the same nonce | a new renew at the next nonce |
| the renew landed, before `done` was written | intent + raw tx | finds the receipt, records it, re-reads the lease (now outside the margin) | a renew whose lease is already extended |
| the final checkpoint, before release | a done checkpoint | `release` | a release before the proof |
| a claim that lost the race | (simulation refused, nothing sent) | reads the new runner and does nothing | a claim over a live lease |

## Built in this slice (runner/runner-agent.mjs, and the transaction engine in runner/proof-agent.mjs)

These are built and tested on the local chain, with synthetic operator keys: register (with the ATTESTED key),
`setProofKey`, claim (including an in-place re-claim of a lapsed lease), renew (gated on recent proofs), heartbeat, and
stop-with-release after a final proof. They share one journal with the checkpoints.
- **The CLI.** `runner/proof-agent-cli.mjs` takes a runner config (format `enclave-pvm-runner-agent/v1`), with
  `--release` for a final proof then release. The key comes only from a 0600 file, and the RPC only from the environment.
- **test/pvm-runner-agent.test.mjs, 8/8.** The real contracts on anvil, a fake VM, and nothing pre-registered or
  pre-claimed. It covers:
  - the whole lifecycle;
  - another operator's endpoint, a missing or deactivated entry (not revived, no heartbeat), and an old key replaced by
    the attested one;
  - an unauthorized bond, and a claim race lost at simulation (nothing sent);
  - a lease whose app stopped serving left to lapse, then re-claimed;
  - a mined call without its event, recorded as a failure;
  - interruptions: a claim, a renew and a release each journaled but never delivered, each delivered ONCE after a
    restart (the tenant pays one quantum); a renew still in the mempool followed, never repeated;
  - the CLI.
- **test/mutate-pvm-runner-agent.mjs.** A control plus 10 mutations, each caught by the test it names. The posting agent's
  own harness still catches its 23.
- **Next: the device check** (results/pvm-cpu-runner-agent). The lifecycle runs against the Pixel's real VM, as the
  posting agent's did.

## What production still needs (the owner's; none of it is invented here)

Everything in PROOF-KEY.md "Exactly what production still needs", plus:
- **`register`:** `repo`, `measurement` (the production build's code hash) and `cpuPricePerSec6`, the runner's price.
  These are the owner's.
- **Whether to claim, and which deployment.**
- **A bond ceiling,** if the ledger asks for a bond. The default is none: the agent then refuses to claim.
- **The margins, only if the defaults do not suit:** `renewMarginSec` and `heartbeatSec`.

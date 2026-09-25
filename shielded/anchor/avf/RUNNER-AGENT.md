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
   - **A key goes on-chain only from a FRESH statement.** Both `register` and `setProofKey` re-attest over a new nonce
     immediately before sending. An attestation from an earlier tick may name a key a re-provisioned VM no longer holds.
     (enclave-99's review of e4ecc4aa.)
   - **The published measurement is the attested build's.** The config is refused unless `register.measurement` is one
     of the evidence's `allowedCodeHashes`, and THE one when exactly one is pinned. (Also enclave-99's review.)
     `register` publishes EXACTLY the build the fresh statement attests: `verifyPvmProofKey`'s claims now carry
     `codeHash` as bare lowercase 64-hex. A config naming a different pinned build stops with `measurement-mismatch`.
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
4. **Earnings:** `withdrawEarnings(payout.to)` once `earned6` reaches the owner's `payout.minWithdraw6`. The event must
   name this operator and that address. With no `payout` configured, it never withdraws.
5. **The proof:** the posting agent's tick, unchanged, while the lease is ours.

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

## Before the lease, and attaching once registered (the real relay; reviewed with the verifier session)

Running the runner through the REAL relay (relay/api-relay.js) instead of the lab hub exposed three gaps. All three are
closed or bounded here, with no weakening of any check.

**C, fixed: no pre-lease path to the VM.**
- The problem: the relay's `/x/<id>/pvm` route resolves the deployment's ON-CHAIN runner, so it exists only after a claim.
  A claim needs the attested proof key registered, and the relay is the only path to the VM. So nothing could fetch the
  first statement.
- The fix: `POST /t/<name>/pvm/evidence` (relay/pvm-serving.mjs), carrying the EVIDENCE kind only:
  - it goes to the pVM tunnel attached under `<name>`, and api-relay.js claims the path only when the hub's own verdict
    for that name is an AVF (pVM) tunnel. Every other tunnel's `/t/` is untouched;
  - it has the /x route's bounds, a per-client rate, a per-TUNNEL rate, sizes-only logging and plain refusals;
  - it never carries the sealed kind, which would be unpaid serving before a lease;
  - it is behind `PVM_SERVING`.
- **It is never a source of instance trust.** Before registration a name is first-come, so the agent's `instanceIds` come
  out of band from the owner's own device (PROOF-KEY.md "Activation" step 3).
- **Residual:** name squatting before registration is a bootstrap denial of service. A same-build VM holds the name, and
  the owner's agent refuses its evidence. An unguessable name mitigates it.

**A, fixed: a registered name could never be attached again.**
- The problem: once https://<relay>/t/<name> is registered, the hub (relay/tunnel.js) takes an attach under it only with
  the registry OPERATOR's signature over "enclave-tunnel-attach:<name>:<nonce b64>". The phone never holds that key, so
  every VM restart would have lost the name.
- The fix: the owner-side attach co-signer (runner/attach-cosigner.mjs), started by the CLI from `lifecycle.attach`
  (loopback only). It signs only for the owner's OWN INSTANCE:
  1. **The payload's instance proof.** At boot, before the app, the payload signs its OWN pad-bind transcript B (domain ||
     its transport SPKI || its pad key || the relay's nonce) with its instance key, under "enclave-pvm-attach-instance-v1\n"
     (payload/anchor_attach_instance.h). It prints `INSTANCEATTACH key=<SPKI> sig=<sig>` and nothing else. A foreign
     transcript gets nothing, and the instance secret never leaves the payload (pinned natively and by a source scan,
     mutations P01-P04).
  2. **The co-signer's checks:**
     - its own name only, and never a requested one;
     - the nonce: exactly 32 bytes, canonical, and never signed twice (journaled with fsync, across restarts);
     - the rad, checked with the hub's own `verifyAvfEvidence` over B under the owner's pinned build(s), authority and
       Google's roots. The build pin is what separates the pinned build from any other build the same authority signs:
       the instance secret is stable across same-key updates;
     - sha256(instance SPKI) in the owner's out-of-band `instanceIds`;
     - the instance signature over THIS B, which pairs the instance with this boot's transport key and nonce;
     - a rate limit.
     The `relay` field of a request is only a configuration sanity check. What binds a co-signature to one relay
     connection is the nonce, which is single-use at the relay that issued it.
  3. **The Android host** forwards the request (`--es attach_signer http(s)://…/attach-sign`) and puts the returned
     `operatorSig` in its attest frame. It holds no key.
- Tested on the real hub: a registered name without a signature is refused; a co-signed attach by the owner's instance
  is accepted; a co-signature for nonce N is refused on a connection with nonce N'; a second, validly co-signed attach
  with another transport key is refused while the owner's tunnel is live; every co-signer refusal leaves nothing signed;
  two concurrent requests for one nonce get one signature (test/pvm-attach-cosigner.test.mjs; test/mutate-pvm-attach.mjs,
  17/17).

**B, a gap, documented: no in-place re-attach.**
- The attach certificate is made at VM boot. If the relay drops, the tunnel stays gone until the VM restarts, and the
  restart re-attaches with the co-signature.
- A true in-place re-attach needs a payload control path that certifies a NEW relay nonce while the app runs. That is
  not built.

**The device check through the real relay: PASS, LAB** (results/pvm-cpu-relay-route, check.txt and NOTES.md;
cpu/relay-route-run.mjs; runtime/conformance/check-relay-route.mjs). It ran at **43601dee**, on the Pixel 10, with a
lab relay process on loopback and the real contracts on a local chain. The steps:
- **Attach and bootstrap:** an unregistered attach; the bootstrap statement; register and claim.
- **Serving:** the /x route; proofs; the built client served as bound. Another instance, another build and a stale
  answer were each refused before sealing.
- **An interrupted checkpoint** was delivered once after a restart.
- **A relay drop:** gap B held (the tunnel stayed gone). Then restarts:
  - with no co-signer: refused;
  - co-signed by another operator: refused;
  - co-signed by the owner: accepted, with the same instance and key.
- **A relay pinning another build** refused the co-signed attach.
- **A final proof, then release.**

The checker re-verifies every co-signature, statement and checkpoint offline; its coverage test mutates the run 25
ways. The run found no integration gap in the code. It left two open items (NOTES.md "Observed, open"):
- the VM's evidence budget is shared by every caller, which is an availability issue for the agent's proofs;
- the phone's "co-signed by the owner" log line is printed for any co-signer.

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
- **test/pvm-runner-agent.test.mjs, 12/12.** This includes a re-provisioned VM: its re-registration, and its setProofKey
  in the three-key case (registry K0, earlier attestation K1, VM K2), must carry the NEW key. It also includes a config
  naming another pinned build, which registers nothing. The real contracts on anvil, a fake VM, and nothing pre-registered or
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
- **Earnings withdrawal** (a local-chain slice after the device run): only to the owner's payout address, only at the
  owner's minimum, and once.
- **test/mutate-pvm-runner-agent.mjs.** A control plus 16 mutations, each caught by the test it names. The posting agent's
  own harness still catches its 23.
- **The device check: PASS** (results/pvm-cpu-proof-agent-lifecycle, check.txt; cpu/runner-agent-run.mjs;
  runtime/conformance/check-runner-agent.mjs). On the Pixel's real VM, with nothing pre-registered, the agent:
  - registered exactly the attested key and claimed the lease;
  - proved, and sent heartbeats when due;
  - renewed once, inside the margin;
  - after being stopped with a renew never delivered, delivered those SAME bytes once on restart (the tenant paid exactly
    one renew);
  - sent a final proof, then released.
  17 chain events reconcile with 17 journaled landings. That run exercised cd939a7a.
  - **Run 2** (results/pvm-cpu-proof-agent-lifecycle-2) exercised **5d2d115d**. The registered measurement is exactly the
    attested `codeHash`, and after the release an agent with the owner's payout config withdrew all earnings to the
    payout address, once. Its check.txt PASSES, and the checker's coverage test mutates it 15 ways.

## What production still needs (the owner's; none of it is invented here)

Everything in PROOF-KEY.md "Exactly what production still needs", plus:
- **`register`:** `repo`, `measurement` (the production build's code hash) and `cpuPricePerSec6`, the runner's price.
  These are the owner's.
- **Whether to claim, and which deployment.**
- **A bond ceiling,** if the ledger asks for a bond. The default is none: the agent then refuses to claim.
- **Where earnings go:** `payout.to` and `payout.minWithdraw6`. The default is none: earnings stay on the ledger.
- **The attach co-signer's channel** from the phone to the owner's agent (`lifecycle.attach`), which listens on loopback
  only. The lab uses adb reverse. In production it is the owner's choice of transport (their LAN, a tunnel or the host
  app), and the co-signer's own checks are what hold regardless.
- **On the production relay (the relay owner's):**
  - `PVM_SERVING` set;
  - the production `METAL_AVF_*`, `PVM_CPU_*` and `PVM_APP_*` values;
  - `TUNNEL_PUBLIC_ORIGIN` equal to the origin the runner registers under.
- **The margins, only if the defaults do not suit:** `renewMarginSec` and `heartbeatSec`.

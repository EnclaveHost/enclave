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

**B, a gap: no in-place re-attach (as of 43601dee).**
- The attach certificate is made at VM boot. If the relay drops, the tunnel stays gone until the VM restarts, and the
  restart re-attaches with the co-signature.
- A true in-place re-attach needs a payload control path that certifies a NEW relay nonce while the app runs. The
  design follows ("Reconnect in place").

### Reconnect in place (gap B; design reviewed with the verifier session: go, with its structural change and conditions below)

**The goal.** After a relay drop, the RUNNING VM attaches again, without a restart:
- a fresh relay challenge, and freshly bound VM, instance and operator signatures;
- the owner's instance and build pins unchanged;
- never two live tunnels for the name, and never an old attach replayed.

**What the relay already gives (read from relay/tunnel.js; no relay change):**
- Every connection gets a fresh 32-byte nonce. The attest frame must bind it: the AVF certificate's challenge is
  sha256(B), and the attested key signs B. A registered name also needs the operator's personal_sign over that nonce.
- **One tunnel per name.** A name held by a live tunnel can be re-taken only by the SAME attested transport key (keyFp),
  and `bind()` terminates the previous socket (newest wins). A relay restart starts from an empty map.
- Each new tunnel issues a fresh ABI/2 nonce and judges one caps frame against ITS attach nonce.
- `/x` routing needs the row in the relay's live list (every attached tunnel's row, whatever its tier) with the
  registered `publicUrl`. Evidence streams need `t.pvm`; app streams also need `t.pvmApp`.

**The restriction, and the smallest change.**
- The payload certifies an attach transcript only at boot (`BOUND`/`CHAL`, then `ATTEST end`).
- While the app serves, its control loop takes `STOP` only, into a 64-byte buffer.
- So one payload command is added, and nothing else in the VM changes: the transport key, pad key, instance, app,
  TLS, evidence endpoint and proof key all stay.

1. **The payload: `REATTACH <nonce hex>`**, accepted only while the app serves. The rules live in
   payload/anchor_reattach.h, which is tested natively under ASan/UBSan.
   - **The relay's nonce is the only input:** exactly 64 lowercase hex characters, judged on the byte count the line
     reader returned. An odd length, 63 or 65 characters, non-hex, uppercase, an embedded NUL, trailing bytes or an
     over-long line each get NOTHING.
   - **B is built by the VM** from the transport and pad keys copied when it was armed at boot. There is no foreign
     transcript to judge (enclave-99's structural change): `sh_avf_pad_binding_valid` is an internal assertion.
   - **The boot keys never change:** a re-attach refuses if the live keys ever differ from the armed copies.
   - **At most one per 5 s,** on the VM's own clock. A malformed line does not spend the window, and a clock that went
     backwards is refused.
     - Measured on the Pixel 10: every attestation of 14 device runs (125 chains over 105 fresh leaf keys) hangs off
       ONE provisioned AVF key. A call consumes no remotely provisioned key, so the bound is about load, not a key pool.
   - **The output** is framed `REATTACH begin` … `REATTACH end`, with the same lines as boot: `INSTANCEATTACH`, a NEW
     AVF attestation over sha256(B) (`CERTi[...]`), and the attested key's signature over B (`SIG[...]`).
   - **Separate state:** it never touches the caps state (the attach time, the caps nonce) or the app's ABI/2 state; a
     source check pins this.
   - **One lock:** every attestation request goes through one call site, whose lock covers the request alone (the
     evidence server's thread asks too).
2. **ABI/2 for the new tunnel,** from the endpoint that already exists.
   - The hub's fresh `abi2-challenge` is answered with `EVIDENCE3 <hub nonce>` on the VM's evidence endpoint (vsock
     7787). That is the same `abi2_certify` the boot path uses, with the same identity, self-test tuple and instance
     signature.
   - The host copies the v3 answer's `chain`, `identity`, `selftest`, `app`, `instanceKey` and `instanceSig` into the
     `abi2` frame, and the hub verifies it against ITS nonce and THIS attach's transport key.
   - This adds no signing capability: that endpoint already answers anyone's nonce, and it keeps its 1-per-2 s budget.
     The host retries a rate refusal at most 3 times, about 2.5 s apart.
   - **The host passes the VM's bytes through.** Copying fields is acceptable only because the hub re-verifies all of
     them against ITS nonce and THIS tunnel's attested transport key; a slip in the copy only fails.
   - test/pvm-reattach-hub.test.mjs shows, on the real hub, that another genuine VM's evidence is refused on a
     reconnected tunnel.
3. **The host: one reconnector,** with at most one serving RelayAttach at any time.
   - **Triggers:** the tunnel's serve loop ends, or no frame arrives from the hub for 95 s (the hub pings every 30 s
     and drops a tunnel after 90 s). The socket gets connect and read timeouts, so a frozen relay cannot hang the
     phone.
   - **The old socket is closed first.**
   - **Backoff:** 2 s, doubling to 60 s, and reset after a tunnel stays up for 60 s. It stops when the VM's session
     ends.
   - **Each attempt:**
     - a new socket and a new nonce;
     - `REATTACH` (a 30 s wait for the VM's answer);
     - the co-signer, with the unchanged request;
     - the attest frame;
     - on acceptance: `hello`, serving, and ABI/2 as in item 2.
   - **Refusals** (no co-signature, the wrong operator, the build) end that attempt and are logged with the hub's
     reason. The next attempt waits for the backoff.
4. **The log line** says "operatorSig attached (the hub judges it)" instead of "co-signed by the owner", which the
   phone cannot know (enclave-99).

**Not restored in place: the pVM CPU tier (caps).**
- The relay admits a capability report only when its self-test FOLLOWS the attach, within `maxReportAgeMs`
  (relay/pvm-cpu-tier.mjs). So the boot self-test re-signed with the new nonce is refused, correctly.
- A fresh self-test needs an engine hook: `engine_local_main` runs it once, at start.
- So a tunnel reconnected in place routes `/t` and `/x` (evidence and the verified app), but its row carries no
  inference-lane tier until the VM restarts.
- The relay's policy is NOT relaxed. A later option: an engine self-test on demand, while idle.

**Replay and duplication.**
- **An old attest frame on a new connection:** its certificate and signature cover the old nonce. The hub refuses it.
- **An old operatorSig:** it signs the old nonce, so it recovers to another address. The hub refuses it: a registered
  name.
- **The co-signer** never signs a nonce twice (its journal), and it checks the instance over THIS B and the build.
- **REATTACH** cannot sign a foreign transcript, and it cannot run faster than 1 per 5 s.
- **The name:** a live name moves only to the same transport key, newest wins, so the relay holds one tunnel. The phone
  closes its old socket before dialling.
- **Residual, as before:** an UNREGISTERED name stays first-come (the bootstrap residual).

**Built (tested before the device):**
- payload/anchor_reattach.h and its wiring in anchor_payload.c;
- host/app/RelayKeeper.java, with RelayAttach's watchdog, `onClosed` and ABI/2 from the evidence endpoint, and Ws's
  connect and read timeouts;
- test/anchor-reattach.test.mjs, natively plus the payload source;
- test/pvm-reattach-hub.test.mjs, on the real hub:
  - the same key re-takes its live name on a fresh nonce, newest wins, one tunnel and one row;
  - another nonce's certificate, an old co-signature, a whole old frame and another VM's evidence are refused;
  - ABI/2 from EVIDENCE3 verifies;
  - repeated re-attaches work the same way;
- test/mutate-pvm-attach.mjs X01-X10 (and P03/P04 moved with the one `INSTANCEATTACH` line).

**The lab check** (cpu/relay-reconnect-run.mjs and runtime/conformance/check-relay-reconnect.mjs; the isolated lab: a
loopback relay, anvil, the Pixel; ONE VM boot throughout):
- **R1:** three relay stop/start cycles. Each time the route returns, the client is served as bound, and a proof lands.
  The VM log shows one boot, and the keyFp, instance and proof key stay the same.
- **R2:** a frozen relay (SIGSTOP, half-open), then SIGCONT. The phone's watchdog reconnects, and the relay ends with
  exactly one tunnel for the name.
- **R3:** with a harness co-signer proxy:
  - co-signer down: refused and retried;
  - the wrong operator: refused;
  - a STALE owner signature (one issued earlier, replayed): refused;
  - the owner: accepted;
  - a captured attest frame (rad and operatorSig) replayed by the harness on a fresh socket: refused.
- **R4:** exactly once.
  - A checkpoint is journaled and never delivered, and the agent stops. The relay drops and returns, the VM
    re-attaches in place, and the restarted agent delivers the SAME transaction once.
  - A request cut by a drop sends nothing.
- **R5:** a relay pinning another build refuses the attach in place; the right relay accepts it.
- **The end:** a final proof, then release.
- **Checker coverage, as enclave-99 asked:**
  - at most one live tunnel on the phone: every in-place acceptance follows exactly one loss;
  - one tunnel row at every sample;
  - the in-place row has no tier and is never serving or eligible.

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
- **The VM's evidence budget is shared** (seen in results/pvm-cpu-relay-route):
  - **The problem:** the payload answers one evidence-endpoint request per 2 s, for EVERY caller. Through `/t/` and
    `/x`, the only other limit is the relay's per-tunnel and per-deployment bucket, which every client shares.
  - **The retry:** the agent retries the payload's exact refusal at most twice (policy `rateRetries`, capped at 5), 2.5 s
    apart (`rateRetryMs`, at least 2.1 s). Each retry is journaled (`rate-retry`), a refusal is never taken as an answer,
    and any other error is judged once. This is test/pvm-proof-agent.test.mjs's budget test and mutations A25-A27.
  - **Residual (availability, not safety):** a per-kind budget in the payload would stop cross-kind starvation, but not
    a same-kind flood. The contract's 15 min proof window, with a proof every 5 min, absorbs occasional misses.
    (enclave-99's review.)
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

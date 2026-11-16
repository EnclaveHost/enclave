# Proof of capacity: a host is paid while others vouch for it and it has vouched for them

Status, 2026-11-16: **source and tests only.** Nothing here is deployed or bound into a ledger, and no host has
the setting on.

## The rule

A host is credited for time it proves (the proof of time, unchanged) only while it is **in standing** for the
current epoch. Standing looks at the epoch before:

1. **Duty.** The host reported on every host it was assigned to check: pass, fail or unreachable.
2. **Capacity.** Of the hosts assigned to check it: two or more fails and it is not paid this epoch. No fail and
   at least one pass and it is in standing. Anything in between (nobody reported, one fail, only "unreachable")
   and it also needs its own proof of capacity for this epoch.
3. **Alone or new.** A host that was not credited in the epoch before that has nobody assigned to it and no duty:
   its own proof of capacity is its standing.

So a lone host proves capacity for itself, two hosts check each other, and beyond that every host is checked by
`min(checkersPerHost, n - 1)` others. Nobody can remove a host: one that is dead or fails is simply not credited,
and a host that is not credited is off the next roster with no transaction from anyone.

## Where it is enforced: the ledger's prover

`contracts/EnclaveProofOfCapacity.sol` takes the place `EnclaveProofOfTime` holds: the ledger's `prover`, the one
caller of `creditProven`. It was the only place the rule can bind money:

- a wrapper around `checkpoint` (as the fee router is) cannot withhold anything, because the proof-of-time contract
  takes checkpoints from anyone and credits at once;
- a ledger revision has almost no bytecode room left;
- the prover decides whether the watermark moves at all.

**The ledger deployed today cannot take it.** `setProver` is set once and refuses a second value. Binding this
contract means deploying a ledger (the same code will do), importing the records and repointing the address book:
an owner's action, with the escrow question that every ledger replacement has.

## How it works

- **Epochs** of `epochSec`. The **roster** of an epoch is the hosts this contract credited in the epoch before, in
  the order their first checkpoint landed; it is frozen when the epoch begins.
- **Seed**: the previous block's hash as the epoch's first transaction here sees it.
- **Assignment**: the checkers of the host at roster position `p` are the hosts at `p + o_j (mod n)`, the offsets
  `o_j` drawn from the seed, distinct and never 0. Read backwards the same offsets give a checker its targets, so
  both directions cost `k` reads whatever the size of the network.
- **Report**: `CapacityReport(epoch, checker, target, verdict, seed, evidence)`, EIP-712, signed by the checker's
  registry **proof key** (the in-enclave key that signs its proofs of time). Accepted during its epoch and for
  `reportGraceSec` after, once per (epoch, checker, target), from anyone who carries it.
- **Own proof**: `CapacitySelf(epoch, host, anchorBlock, anchorHash, evidence)`, signed by the host's proof key, for
  the current epoch, over a recent block (as a proof of time is), not over the seed: the seed is fixed by the
  epoch's first transaction, and a lone host's own proof must be able to be in that transaction.
- **Checkpoint**: `EnclaveProofOfTime`'s, with `standing` required in front of it and the roster kept behind it.
- No owner, no parameter that can change after deployment.

`network/proof-of-capacity.mjs` is the hosts' side: the three messages (their digests are pinned to the contract's
in both test suites), a round of duty (`dutyRound`: ask the contract for this epoch's targets, run the caller's
check on each, sign a report) and what a host still needs (`standingRound`: the contract's own `standing`, and its
own proof only when that is what is missing).

## What it does not do

- **It does not judge a check.** A pass is the checker's enclave saying so; `evidence` is a digest the contract
  stores and does not read. Hosts assigned to each other can collude. Unpredictable assignment and several checkers
  bound that; with fewer hosts than that it is not bounded (two hosts of one owner pass each other, which is no
  weaker than the own proof a lone host is allowed).
- **An own proof is the host vouching for itself**: as strong as that host's attestation, no stronger.
- **The seed can be leaned on** by whoever orders the epoch's first transaction (on Base, the sequencer).
- **It pays nobody for carrying a transaction.** Checkpoints and reports are open to any carrier, but the ledger
  credits only the runner's operator. Taking the carrier's gas out of what a checkpoint unlocks needs the operator
  key's executor (`EnclaveLeaseExecutor`) to grow a checkpoint-and-reimburse path, or a ledger that credits a
  submitter's share. Until then a host with an empty operator key still cannot checkpoint by itself.
- **A fail costs one epoch**, and a failed host must keep checking the others in it or it loses the next one too.
- **Reports can arrive late.** A host that checkpoints at the very start of an epoch, before its checkers' reports
  for the epoch before have landed, is asked for its own proof or has to wait for them.

## The hosts (wired 2026-11-16, off by default)

`network/proof-of-capacity-host.mjs`, used by both platforms:

- **The check** is measured work whose answer the checker computes itself, **as much of it as the host says it has
  free**. The checker reads the capacity record the host's operator key signs (`/v1/host/capacity`, the one its
  customers' readers use; it must be the host's own, for this chain and registry, current and signed by its registry
  operator) and asks for as many **lanes** as the record has free vCPUs (16 at most), each with its share of the
  free memory (64 MiB a lane at most). Every lane fills its memory from its own seed and mixes it (300,000 rounds by
  default: between one and two seconds of one processor), all lanes at once, in worker threads; the digest over the
  lanes is the answer, signed by the host's proof key.
- **The clock.** Before it asks, the checker runs one lane itself. The answer must come back within three times
  that, plus 1.5 s. Lanes run side by side fit; a host that advertises eight free vCPUs and has one runs them one
  after another and is late by a factor no slack covers: `fail`, "the capacity it advertises as free was not there".
  So a pass says the host did, now, while whatever else it runs kept running, as much parallel CPU and memory work
  as it tells the market it has free. The clock does not tell two or three advertised vCPUs from one (the slack
  covers that much), and a host with no claim the checker can verify is asked for one lane, with the reason recorded.
- **Further checks** of a host that passed the work plug in (`also`): one that fails makes the verdict a fail with its
  reason, one that throws is no verdict this round. None is built in (below).
- **A host answers** `POST /v1/host/capacity-check` only from a host the contract assigned to check it this epoch,
  over that host's proof-key signature, one check at a time and one per checker and epoch.
- **Verdicts**: `pass` - the digest is the checker's own, signed by the target's proof key, in time. `fail` - a
  wrong digest, another key, an answer to another challenge, too late, or a further check that failed. `unreachable` - no row in the registry, no
  answer, an HTTP error. No verdict (tried again next round): the checker itself cannot reach the chain, or the
  target says busy, not this epoch, or already checked.
- **The agent** (`createCapacityAgent`), every `PROOF_OF_CAPACITY_SEC` (300): fixes the epoch's seed if nobody has
  and this host holds a paid lease; checks and reports on every host it was assigned and has not reported on; and
  sends its own proof only when the contract's `standing` says that is what is missing. Each transaction goes
  through the host's own operator queue; one that fails is logged and tried on the next round.

**The setting.** `PROOF_OF_CAPACITY=1` on a host, and only then. With it:

- the proof of time is signed under the name `EnclaveProofOfCapacity` (the same message, that contract's domain),
  so it must be set exactly when the ledger's prover is one;
- before anything else the prover's `proofSchema` must read 3; otherwise all of the above stays off and the host
  says why once.

Wired in `supervisor.js` (route, timer, proof-of-time domain) and in the Windows node
(`windows/node/proof-of-capacity.mjs`, the route in `agent.mjs`, the timer in `host.mjs`, the domain in
`chain.mjs`). The Linux image copies the two shared modules (`Dockerfile`); they import no package, since the
Windows box has no `node_modules` outside its own folder.

## What else a pass says: the three further checks (2026-11-16, source and tests)

After the work, a checker runs further checks on the host (`createCapacityChecker`'s `also`). Each has a setting on
the checker, `enforce` (the default), `record` or `off`: `PROOF_OF_CAPACITY_APP`, `PROOF_OF_CAPACITY_CARD`,
`PROOF_OF_CAPACITY_KEY`. A check that was made and refused turns the pass into a fail. A check that could not be made
(a relay that is busy, a guest still starting, nothing to check) is written into the record as **not judged** with
its reason and leaves the verdict to the rest: a checker never fails a host for what the checker or the relay could
not do. Every check's outcome is in the record whose hash goes on chain.

### The app it serves (`network/proof-of-capacity-app.mjs`)

The check a customer's own page runs, with the same code: the independent browser verifier as shipped
(`verifier/web/dist/enclave-verifier-web.js`, one file with no dependencies; it runs under Node, and both host
images now carry it).

- Which app: the public apps the relay lists for the host's box, of those only the ones **the ledger** says are
  leased to this host now (the checker's own chain read), and of those one chosen from the epoch's seed and the
  checker's id. The host cannot know which before the seed is fixed.
- What is verified: the host first (a confidential server's AMD report, an Enclave Shield box's TPM session, a
  phone's protected-VM chain, each over the checker's own nonce), then the app guest's report over a second nonce:
  the vendor's chain, the binding of the TLS key, the app, the deployment, the measurement.
- What counts against the host: only the verifier's `rejected` with a check that came out false. Its `error`, a
  refusal with no failed check ("the relay answered for another nonce"), no leased app, an unknown tier: not judged.
- What it leans on, and says in the record: which box is the host's, which measurements are admitted and which app
  a deployment names are the relay's statements (the verifier's "limited" and its omissions). The relay cannot forge
  a report. It can withhold one (nothing is judged), and it can state a wrong expectation: then an honest host is
  refused by every checker alike. `record` is the setting for anyone who will not carry that.
- Cost to a Shield host: one TPM quote and one partition report per check. The relay allows one check per box per
  20 s; a second checker inside that gets "busy", which is not judged.

### A card it sells (`network/proof-of-capacity-card.mjs`)

For the card of a confidential server that is sold by masked offload (the worker on the untrusted host, driven from
inside the VM). The work is the operation the card is sold for, the worker's `FIELD_GEMM`, fed back into itself on
the card: `x' = ((x.W + pad) mod 63) - 31`, round after round, for 32 rows side by side, on a matrix, starting rows
and pads the checker's seeds determine. That is a new command of the worker, `FIELD_CHAIN` (protocol 1.5, below).
Every 16 products the worker keeps the rows and hashes them, and only those digests cross the link. The checker
repeats none of it: it asks to see a few stretches of 16 products and checks each product with preprocessed
Freivalds, the check the guest runs on every product. One pass over the matrix, then 2 K operations a product,
against K x K for whoever computes it.

Three requests, `POST /v1/host/card-check`, under the same rule as the work (only a checker the contract assigned,
over its proof key's signature, once per checker and epoch, one check at a time):

1. **prepare**: the signed challenge. The host derives the matrix and installs it on the card. Not timed.
2. **run**: a value the checker draws only now. The starting rows and the pads come from it. The host answers with
   the root of a Merkle tree over the digests, signed by its proof key. Timed.
3. **open**: 24 stretches the checker picks after it holds that root. For each the host shows the rows it started
   from and the 16 products after them. The start must be the state committed before it (or the seed's rows), every
   product must pass Freivalds, and the end must be the state committed after it. A host that made up a tenth of
   the stretches is caught 92 times in 100.

Nothing of a run can be worked before the run's value is known. The matrix is known at prepare, and without the pad
a host could work stretches from rows of its own choosing during prepare and commit to those; the pad enters every
step, so every product after the first of a stretch waits for the run's value, and a stretch that does not join the
committed states on both sides fails when opened.

How much is asked follows the host's own signed capacity record: the card's stated rate (`shieldedCards[].gmacPerSec`,
the worker's measurement) times the share of the card it says is free now, for four seconds of it; the run must come
back within 1.5 times that plus 2.5 s. So a card must deliver about 47% of the free rate it advertises
(1 / (1.5 + 2.5 / 4)): the 1.5 is for a card shared with tenants, the 2.5 s for the request's own travel. Each
record states the floor its clock enforced (`enforcedGmacPerSec`). Defaults: K = 4096, 32 rows (0.54 G products a
round), 2,048 kept states at most (268 MB of the card; a card past 4,400 G/s free is then timed over a shorter run,
and its floor is lower: the record says what it was).

What a pass says: that many correct field products were made in that time by whatever answers at the card's
endpoint, with the kernel and the shape a tenant's products take. What it does not say: which silicon made them (a
processor fast enough is a card of that rate), and nothing about the card's memory (the matrix is 16 MB). A host
that advertises a card and answers 404 for it fails; so does one whose worker has no `FIELD_CHAIN` (it answers
501): a card that is advertised and cannot show its rate. A host whose card is fully sold is not judged.

**The worker's side: `FIELD_CHAIN`** (`shielded/protocol.py` for the rule, `shielded/worker.py` the reference,
`shielded/worker-cuda/worker.cu` the card). One installed square node, the caller's rows and pads, `rounds`
products in strides; after each stride the state goes to a trace region inside an 'activations' buffer the link
already holds, and its rows are hashed on the worker's thread while the card works the next stride. The reply is
the digests. A kept state is read back only as a declared output of the installed graph, as everything is. It is
the one op of the worker that is not linear in what it is sent, and it stays inside the worker's boundary: it
returns a function of what its caller sent on that connection and of public weights, a digest of it at that, and
it does none of the work a model has. Bounded: 2^20 rounds, 4,096 kept states, the node's own row limit. The card
is taken one stride at a time, so tenants' exchanges run in between, and a link with no reservation runs a chain
at the weight of everything that is not reserved (a check of what is free gets what is free; a tenant keeps the
share it reserved). The Vulkan build does not have it and says so in its HELLO.

Checked against the real worker: `shielded/worker.py` in its reference mode (no card) works the chain the driver
asks for, digest for digest and kept state for kept state the chain worked in software, and a whole check passes
over it (`test/proof-of-capacity-card.test.mjs`).

**Run on a card (2026-11-16).** The CUDA worker built from this source, a private copy on this workstation's
desktop card (RTX 3070 Ti, not sold), on its own port and outside the shared GPU daemon; the two production workers
were not touched, and the private worker was stopped afterwards. The worker states 2,826 G products a second for
that card.

- The card's chain at K = 4096 is the chain worked in software, every digest and every kept state, in both weight
  forms (the kernel's q8_0 form and the pre-encoded one).
- Advertising its own figure: 11,304 G products asked, answered in 3.82 s (2,961 G/s), 24 stretches verified;
  passes. The time is the card's: of a 6.43 s run the worker held the card 6.27 s.
- Advertising 2 times its figure: passes, at 6.45 s of 7.17 s allowed. That is the slack, and the cap on kept
  states (17,592 G asked where 22,600 would be four seconds of the claim).
- Advertising 3 times: fails (6.42 s, 5.61 s allowed). Advertising 10 times: fails (6.43 s, 3.43 s allowed).

The first form of this check, run earlier the same day on the same card with the production binary, moved every vector in
and every product out over the worker's socket: the link set the time, about 260 G/s whatever the card, the clock
enforced 52 G/s (2% of the card's rate), and a host advertising ten times the rate passed. That form is gone.

What is not measured: a run answered through the relay or from another machine (the answer to open is 8.5 MB of
JSON; here it crossed a function call), a card shared with a working tenant, and any card but this one.

Wired in `supervisor.js` (the route, and the check among a checker's further checks); a Windows box sells no such
card and answers no such check, but checks one like any other checker.

### Where an Enclave Shield host's proof key lives (the capacity partition)

On a confidential server the supervisor runs in the confidential VM and makes its proof key there. On an Enclave
Shield host the supervisor is a process of the host OS, so its proof key was a file of the host and its answers the
host's word about itself. Now:

**In the guest** (`isolation/m2/capacity`, `isolation/m2/front/capacity.go`). The front of a partition makes a
secp256k1 key in its memory at start and serves three paths, only when the image says this domain's app is the
host's capacity app (`/rt/host-capacity-apps` in the measured initrd lists app ids; every image without the file and
every domain running another app leaves the paths to the app, so no customer's domain can be made to work or sign
for a host):

- `GET /.well-known/enclave-capacity-key`: the key's address, signed by the domain's TLS key (the key the
  partition's hardware report binds).
- `POST /.well-known/enclave-capacity`: a challenge. The work runs there, in as many goroutines as lanes, and the
  answer is signed there over the digest that code computed. No signature exists for work not done in the partition.
- `POST /.well-known/enclave-capacity-sign`: the other messages the proof key signs (reports on other hosts, the
  own proof, proofs of time, the challenges it sends), as fixed types assembled there from their fields. Never a
  caller's digest, never an answer. The partition does not judge these: it cannot know whether the host served an
  app or checked a peer. What it adds is that only a running partition of that image, on that boot of that machine,
  can have signed them.

The Go work and messages are held to the hosts' JavaScript bit for bit: `testdata/vectors.json` is written by the
hosts' code and viem, checked by `go test`, and a JS test refuses a stale file. Signatures from the Go code are
byte-identical to viem's. Keccak is written out in the package so the measured image takes no further module.

**On the host** (`windows/node/shield-capacity.mjs`, `chain.mjs`, `agent.mjs`). With `SHIELD_CAPACITY_CONFIG` (a
pinned record like the readiness witness's) and proof of capacity on, the node keeps one host-owned partition
`host-capacity-v1`, asks it for its key, and from then on the box's proof key is that key: answers to checks are
forwarded into the partition, every other signature is made there, and the registry is brought to the new key after
each start of the partition. The file key is then never used or published, even while the partition is down
(nothing is proven or registered until the partition has stated its key). `GET /v1/host/capacity-key?nonce=` hands
a checker the partition's attestation and key statement; without a partition it answers 404, and that is the answer.
The manager sizes by catalog policy alone only the pinned witness and the one app id its operator pins
(`ENCLAVE_HOST_CAPACITY_APP_ID`).

**On the checker** (`network/proof-of-capacity-partition.mjs`). For a host the relay says is an Enclave Shield box,
the checker verifies the capacity partition as a customer's page verifies a Shield app, with the independent
verifier unchanged: the host's TPM session through the relay first, then the partition's report under that boot's
key. The one request the relay would answer (the app's attestation) is answered from the host instead, and beside
it the checker puts **its own** expectation: the capacity app its own copy of the Shield policy pins
(`capacity: {appSha256, runtimeId}` in `enclave-shield-app-policy/1`) and the images that policy admits for that
runtime. Then the key statement must be the attested TLS key's, and its address the proof key the registry
publishes. A verified key is remembered for a day, for as long as the registry publishes it.

An Enclave Shield host that serves no partition key, or whose registered key is not the partition's, **fails**.
With no capacity app pinned in the checker's policy the check is not judged. That is the state today: the policy
in the repository pins none, so nothing changes for any host until one is pinned.

What a pass says: the key that signs this host's answers and proofs was made in, and has never left, a partition
of an admitted image running the pinned capacity app, on a boot whose TPM the checker just heard from. What it
does not say: that the host OS cannot read that partition (the Shield tier's standing limit: `hostExcluded` stays
false), or that the partition judged anything but the work.

**What activation needs, none of it done:**

1. A guest image built with `/rt/host-capacity-apps` naming the capacity app, measured, and its measurement added to
   the Shield policy's `images`. No image was built; the front change compiles into every variant and its tests
   pass, but nothing of it ran in a partition.
2. A capacity app in the catalog (the bundle the partition runs; its policy sizes the partition: a check asks for
   as many lanes at once as the host advertises free vCPUs, 16 at most, so a partition with fewer processors
   answers late), and its id pinned in the policy as `capacity` and on the manager.
3. The pinned config on the box, and `PROOF_OF_CAPACITY=1`.

Every restart of the partition is a new proof key and one `register` transaction; proofs signed by the old key and
not yet landed are lost.

**Two bugs this work found in the Windows path (fixed):** the node's route read the request body from a name that
does not exist there, so every challenge was answered 400 and a checker filed the box as unreachable; and the relay
refused the request before it reached the box (a Windows host's registered endpoint is the relay's `/t/<name>`,
where only GET of a few paths passed), which a checker took as "try again" every round - and then the CHECKERS were
the ones out of standing, for not having checked it. The relay now forwards exactly `POST /v1/host/capacity-check`.

## A host with no ETH: carried proofs (2026-11-16, source and tests)

The ledger credits a host's earnings to its operator key and only that key can withdraw them, so a host needed ETH
on that key to send its own proofs. `contracts/EnclaveHostExecutor.sol` is the operator key's EIP-7702 delegate in
the place `EnclaveLeaseExecutor` holds (it inherits it: `lease` is the same code, signatures and nonces) with one
function more:

- The operator key signs, with no ETH, a `Carry` order: these exact calls to this prover in this order (its
  checkpoints, and its reports, its own proof and the epoch's seed with them), this fee in the ledger's USDC to this
  carrier or to whoever sends it, and the rest of the key's earnings to this payout address or left where they are.
- Anyone sends it. The code runs as the operator key: it makes the calls (all must succeed), reads how much the
  key's earned balance on the ledger grew, and reverts everything unless that growth covers the fee. Then one
  withdrawal, the fee to the carrier, the rest to the payout.
- So the fee comes out of what the order itself unlocked, never out of earlier earnings, and a carrier that asks
  the chain first risks nothing. The host names the fee; nothing prices gas and there is no oracle.

`network/host-carry.mjs`: the order as the host signs it (`signCarry`; its digest and its commitment to the calls
are pinned to the contract's in both test suites) and a carrier's side (`carryOrder`: enough fee, still standing,
payable to it, and it would not revert; then send).

Limits: calls that unlock nothing in the same transaction cannot be paid for this way (a duty report goes with the
round's checkpoints, or is paid for). The first transaction of a key through a new delegate carries its EIP-7702
authorization, 25,000 gas the host's fee should cover. With no payout named and a fee, the rest of the earnings end
up as USDC on the operator key, since the ledger has no partial withdrawal.

Checked: `contracts/foundry/test/EnclaveHostExecutor.t.sol`, 8 tests with the executor's code on an operator key
that never holds ETH, against the real ledger, registry and `EnclaveProofOfCapacity`: credited and the carrier paid;
a fee above what was unlocked reverts everything; the fee never reaches earlier earnings; only the key's own order,
these calls, once and in time; the named carrier is paid whoever sends; a failing call takes the order with it.
`test/host-carry.test.mjs`, 4 tests.

Not done: the hosts do not use it (they still send their own transactions from the operator key), no carrier
runs anywhere, and no operator key is delegated to it. Moving a key to this delegate is one EIP-7702 authorization.

## End to end on a local chain (2026-11-16)

`test/proof-of-capacity-e2e.test.mjs`, on anvil (chain id 8453, Prague): the repository's ledger and registry,
`EnclaveProofOfCapacity` as the ledger's prover, `EnclaveHostExecutor` as the EIP-7702 delegate of each operator
key, three hosts running the real host code (agent, checker, responder over real HTTP) and one carrier. Operator
keys hold no ETH whenever an order is carried; they are given ETH only to register and to claim or renew a lease
(the paymaster's and the lease-gas reserve's paths in production, not what this test is about).

| epoch | what happens |
|---|---|
| 0 | three new hosts: each its own proof and its checkpoint in one carried transaction (the key's first, with its delegation); all credited |
| 1 | on the roster, not yet checked: own proof once more; they check each other over HTTP. Host C answers with the digest of less work: both of its checkers report a fail |
| 2 | A and B in standing with no proof of their own. C's order would revert (`failed its capacity checks`): the carrier does not send it, C is not credited. C stops answering: A and B report it unreachable |
| 3 | the roster is A and B, one checker each. C is back but checked nobody in epoch 2: `did not check the hosts it was assigned`, not carried |
| 4 | C is a new host again: its own proof, credited |

From the receipts: 18 orders carried, 2 not; 417,429 gas for a key's first order (with its delegation), 302,529 on
average after (reports, checkpoint, withdrawal, two transfers); the carrier received exactly the signed fee each
time (0.36 USDC in all at the test's 0.02) and the hosts 80.76 USDC to their payout addresses; no operator key held
ETH at any carry, and nothing was left on the ledger or on a key afterwards.

**What building it found.** A host's own proof was first signed over the epoch's seed. The seed is fixed by the
epoch's first transaction, so the proof could never be in that transaction, and a lone host whose transactions are
paid out of what they unlock had nobody to send the first one. The own proof now names a recent block instead.

**What it shows about ordering.** The host whose order is the first of an epoch cannot know whom to check until
that order has landed (it fixes the seed), so it does its checks on its next round; the hosts after it check at once.
Two rounds an epoch are enough for every host to do its duty.

## Not built

- Deployment tooling (`scripts/build-contract-artifacts.mjs` has no entry for it, so no ABI file is emitted).
- A carrier service, and the hosts choosing a carried order over their own transaction when the key is empty.
- A check of a card's memory, and of a card that is not sold by masked offload (a card inside the VM has no worker to
  ask; no host sells one today).
- A released card worker with `FIELD_CHAIN`. The workers on the sold cards are at protocol 1.4: with the card check
  enforced as it stands, every host that sells a card would fail it (501) until its worker is replaced. The check
  goes to `record` or stays off until then.
- The card check through the relay, and against a card a tenant is working (the fair-share weight a chain runs at
  is in the worker and has not been measured under load).
- The capacity partition's image, its catalog app and their pins (above): until then a Windows host's proof key is
  still its host's file.
- No real box has run any of this, and the end-to-end test drives the host module directly, not `supervisor.js` or
  the Windows node around it.

## Checked

- `contracts/foundry/test/EnclaveProofOfCapacity.t.sol`: 12 tests with the contract bound as the prover of the
  real `EnclaveDeployments` and `EnclaveRegistry`: a lone host; two hosts; a skipped duty; an unreachable host and
  a dead host leaving the roster; one fail against two; who may report, when and how often; an epoch with no seed;
  the proof of time's own limits; `checkpointMany`; the assignment's symmetry. Runtime size 11,900 bytes.
- `test/proof-of-capacity.test.mjs`: 5 tests of the hosts' side, with the digests pinned to the contract's.
- `test/proof-of-capacity-host.test.mjs`: 12 tests (with: a further check that could not judge; a proof key held
  elsewhere than the host process; the settings): the work; a pass between two hosts; each way to fail; each
  way to be unreachable and the cases that are no verdict; whom a host answers; the agent's round; lanes sized to
  the claim and a host that runs them one after another; the claim as the host's own signed record; further checks.
- `test/proof-of-capacity-app.test.mjs`: 8 tests: a pass and what its record names; how the app is chosen; each
  tier's verifier; refused evidence; everything that is not judged; the verifier as shipped against a dead relay.
- `test/proof-of-capacity-card.test.mjs`: 13 tests: the work from the seeds; Freivalds; the commitment; the chain
  in software; a pass sized to the claim; each way to fail (made-up digests, a chain worked before the run was
  known, a stretch from rows of the host's choosing); the clock (the same honest work passes at its own rate and at
  twice it, fails at 2.2 and at 10 times); "not now"; whom a host works its card for; the wire against
  `shielded/worker.py`; a worker without the chain; the production encoding.
- `test/shielded-protocol.test.mjs`: the chain's bounds in the worker's admission rules.
- `test/proof-of-capacity-partition.test.mjs`: 11 tests: the vectors are current; a key statement made by the Go
  code verifies; the host's use of its partition; a checked host answering from it; the checker's verification and
  each way to fail it; the node's partition module; the manager's rule. `test/windows-proof-signer.test.mjs`: the
  file key is never the box's once a partition's is expected.
- `go test ./capacity/ ./front/ -run 'Capacity|Keccak|Work|Messages|Answer|Keys|Only'` in `isolation/m2`: the work
  and every message against the vectors, signatures equal to viem's, the answer only over work done, the paths off
  unless the image lists the app.
- The end-to-end test now gives every host a card (computed in software) and runs the card check through the real
  contract's assignment: ten card checks in the run, all passed.
- `test/windows-node-proof-of-capacity.test.mjs`: 2 tests: off unless enabled and on a prover that is one; a lone
  box's own proof through the node's operator queue.
- The supervisor's, the Windows node's and the image and deploy closure suites, unchanged in what they expect
  apart from the two new files: 562 tests pass.

Run: `forge test --offline --match-contract ProofOfCapacityTest` and
`node --test test/proof-of-capacity.test.mjs test/proof-of-capacity-host.test.mjs test/windows-node-proof-of-capacity.test.mjs`.

---

# `attested` for an Enclave Shield partition (same day)

The launcher on a Windows host has always reported `attested: false` for every partition, with the reason that no
report chain was verified. That reason stopped being true on 2026-09-30: each partition's hardware report (signed
by the boot's VSM key, which is taken only from the TPM-authenticated log of that boot) **is** verified, per app,
with the image, the runtime and the TLS key the app serves on, by the relay and by the independent and browser
verifiers (`relay/shield-app-policy.mjs`). Nothing said so in a field a reader could use.

- `relay/shield-marketplace.mjs` `attestation(host, deployment)` / `attested(host, rows)`: what this relay verified
  on the host's current attachment and has not let lapse: `{attested: true, by: 'relay', evidence: 'vbs-vm-report',
  until, checkedAt, keySha256, scope}`. The host's row in `/enclaves` carries them as `attestedDeployments`.
- The launcher's constant stays `false` and now says what it is: the launcher's statement about itself, a process
  of the host, which verifies nothing. A host must never be the one to say its own partitions are attested.
- `hostExcluded` stays false. That the host OS cannot read a type-1 guest was shown once on one box; no report shows
  it for a partition running now, and the hypervisor, the firmware and physical access stay trusted.

Open in the chain itself, unchanged by this: platform firmware is recorded but not pinned (`platform-firmware-unpinned`,
the production policy says `platforms: "attested"`), so the scope reads "on an attested VBS platform", not a pinned one.

**Not live:** the relay that runs is an October build carried by patches; this field appears when a relay with it
is installed.

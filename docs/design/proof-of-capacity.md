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
- **Own proof**: `CapacitySelf(epoch, host, seed, evidence)`, signed by the host's proof key, for the current epoch.
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

- **The check** is measured work whose answer the checker computes itself: a challenge names a nonce, a number of
  rounds and an amount of memory; the work fills that memory from the epoch's seed and the nonce and mixes it for
  that many rounds; the digest is the answer (20,000 rounds over 64 MiB by default, about 0.14 s on this
  workstation, run in millisecond slices so the process's other connections are not held). The checked host signs
  its answer with its proof key and must answer inside the deadline (20 s).
- **A host answers** `POST /v1/host/capacity-check` only from a host the contract assigned to check it this epoch,
  over that host's proof-key signature, one check at a time and one per checker and epoch.
- **Verdicts**: `pass` - the digest is the checker's own, signed by the target's proof key, in time. `fail` - a
  wrong digest, another key, an answer to another challenge, too late. `unreachable` - no row in the registry, no
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

What a pass says, and does not: this host's process did this much CPU and memory work when asked. Nothing about a
GPU, about what it could do at the same time for others, or about the app it serves. On the Linux hosts the proof
key is minted in the confidential VM. **On the Windows node the proof key is a file of the node process on the
host**, so there an answer and an own proof are the host's work signed by the host, not a Shield partition's.

## Not built

- Deployment tooling (`scripts/build-contract-artifacts.mjs` has no entry for it, so no ABI file is emitted).
- Paying whoever carries a transaction (above).
- A check that runs where the apps run (inside a Shield partition or beside the app in the VM), and a GPU check.
- No host has run any of this: not on a test chain end to end, not on a real box.

## Checked

- `contracts/foundry/test/EnclaveProofOfCapacity.t.sol`: 12 tests with the contract bound as the prover of the
  real `EnclaveDeployments` and `EnclaveRegistry`: a lone host; two hosts; a skipped duty; an unreachable host and
  a dead host leaving the roster; one fail against two; who may report, when and how often; an epoch with no seed;
  the proof of time's own limits; `checkpointMany`; the assignment's symmetry. Runtime size 11,900 bytes.
- `test/proof-of-capacity.test.mjs`: 5 tests of the hosts' side, with the digests pinned to the contract's.
- `test/proof-of-capacity-host.test.mjs`: 7 tests: the work; a pass between two hosts; each way to fail; each
  way to be unreachable and the cases that are no verdict; whom a host answers; the agent's round.
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

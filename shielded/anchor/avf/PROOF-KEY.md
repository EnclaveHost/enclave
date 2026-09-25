# The pVM lease proof key (AGREED with the verifier session and the Linux isolation owner; `enclave-proof-key/v1`)

**Status.** The wire format and signing policy were agreed with the verifier session (enclave-99) and the Linux
isolation owner (enclave-5d) before the statement's bytes were written. The checkpoint bytes are the contract's own.
- **IMPLEMENTED:**
  - the VM: payload PROOFPINS, PROOFKEY and CHECKPOINT, and pvm-rt `src/proof.rs`, which matches viem byte for byte;
  - the phone: the `proof_pins` launch extra;
  - the canonical verifiers: `verifyPvmProofKey` in relay/pvm-app-attest.mjs, and relay/pvm-checkpoint.mjs.
- **CHECKED ON THE PIXEL 10** against the real contracts on a local chain (results/pvm-cpu-proof-key, PASS): the attested
  key registered by a separate operator account, and device-signed checkpoints ACCEPTED by EnclaveProofOfTime across a
  restart.
- LAB, not production. Nothing is registered on a public chain, published or funded. This was directed in this session, continuing the pVM CPU host
tier. It is not an approval for any transaction.

## Why

A rev-9 ledger (EnclaveDeployments + EnclaveProofOfTime) pays a runner only for time it PROVES it served. The proof
is an EIP-712 checkpoint signed by the secp256k1 `proofKey` the runner's registry entry publishes (schema 3). A rev-9
ledger also refuses a lease to an entry with no proof key (`claim`: "no proof key"). So a phone runner needs one, and
it must live where the untrusted Android host cannot use it: inside the pVM.

Metal boxes do the same thing, with a key minted inside the CVM by the supervisor (supervisor.js `initProofKey`,
served on the attested `/v1/attestation`). The Linux isolation tier signs from its node CVM's supervisor, not from the
per-app guests. On a phone the only TEE is the pVM, so the key and the signing policy are the VM's.

## Nothing new on-chain

The checkpoint is EXACTLY `EnclaveProofOfTime`'s. The VM produces the signature that `checkpoint(...)` recovers, and
anyone may post it.

```
domain      = EIP712Domain(name "EnclaveProofOfTime", version "1", chainId, verifyingContract = the EnclaveProofOfTime address)
type        = ProofOfTime(bytes32 id,bytes32 enclaveId,address operator,uint64 upto,uint64 anchorBlock,bytes32 anchorHash)
digest      = keccak256("\x19\x01" || domainSeparator || hashStruct(message))
signature   = 65 bytes r || s || v, v in {27, 28}, s <= n/2 (the contract's malleability guard)
```

## Two keys, two roles, kept apart

| key | where it lives | signs | set by |
|---|---|---|---|
| **operator EOA** (the gas wallet) | OUTSIDE the VM, with the owner's runner agent | `register`, `setProofKey`, `claim`, `renew`, `release`, `withdrawEarnings`, and it pays gas | the owner |
| **proof key** (secp256k1) | INSIDE the pVM only | `ProofOfTime` checkpoints, nothing else | derived by the VM |

The Android host holds neither. The operator key never enters the VM, and the proof key never leaves it.

## The proof key

- **Seed.** `seed = AVmPayload_getVmInstanceSecret("enclave-pvm-proof-key-v1", 32)`. It is instance-bound, like the
  instance key (INSTANCE-BINDING.md), and measured stable across restarts and same-key updates on the Pixel 10.
- **Secret key.** `k = seed`, read as a big-endian integer. If `k == 0` or `k >= n`, then `seed = SHA-256(seed)` and it
  is tried again. This is deterministic (probability of a retry ~2^-128).
- **Address.** `proofKey = keccak256(uncompressed public key without its 0x04 prefix)[12..32]`, the Ethereum address.
- **Lifecycle.**
  - A restart keeps the key (and the registry entry stays valid).
  - A re-provisioned instance has a new key, so the operator sends `setProofKey` (a rotation; the contract allows it
    mid-lease).
  - The key never exists outside the VM process.

## The pins: what the VM will sign for, fixed for the boot

These are given at launch (by the owner, through the host) and never changed after. They are attested (below), so a
verifier sees what the key will sign for:
`chainId` (u64), `proofOfTime` (the EnclaveProofOfTime address), `registry` (the EnclaveRegistry address),
`deployment` (bytes32, the ledger id),
`enclaveId` (bytes32, the runner id = keccak256 of the registered endpoint), `operator` (address, the lease's
`runnerOperator`).

## The attested statement: `PROOFKEY <nonce>` on the evidence port (AGREED shape, 2026-09-24)

The format is shared across tiers, as the Linux isolation owner (enclave-5d) proposed: the instance is PLATFORM-TYPED, so
an SNP guest can use the same statement with its HOST_DATA. The verifier session (enclave-99) added `registry` and made
the deployment a required expectation.

```
{ "format": "enclave-proof-key/v1", "evidence": <the platform's attested evidence for this nonce: here an
  enclave-pvm-app-evidence/v3 envelope>, "instance": { "type": "pvm-instance-id", "value": hex64 }, "sigAlg": "ed25519",
  "proofKey": "0x" hex40, "chainId": "<u64 decimal>", "proofOfTime": "0x" hex40, "registry": "0x" hex40,
  "deployment": "0x" hex64, "enclaveId": "0x" hex64, "operator": "0x" hex40, "sig": hex128 }

message = "enclave-proof-key-v1\n" || nonce (32) || AppID (32) || instanceType (1) || instanceValue (32) || sigAlg (1)
          || proofKey (20) || chainId (8, big-endian) || proofOfTime (20) || registry (20) || deployment (32) || enclaveId (32)
          || operator (20)
sig     = by the ATTESTED transport key, with the algorithm sigAlg names (pVM: Ed25519, the v3 envelope's spki)
instanceType: 0x01 = "pvm-instance-id" (the v3 InstanceID), 0x02 = "snp-host-data" (the SNP tier: the deployment id's 32 bytes)
sigAlg:       0x01 = "ed25519",  0x02 = "ecdsa-p256-sha256" (the SNP tier's front key, per enclave-5d)
```

The algorithm is TYPED and signed, never implied. A pVM statement must be `pvm-instance-id` with `ed25519`.

- **The message is exactly 271 bytes:** 21 + 32 + 32 + 1 + 32 + 1 + 20 + 8 + 20 + 20 + 32 + 32 + 20. The VM refuses to
  send a statement whose message is any other length.
- **`ed25519`** is RFC 8032 pure Ed25519 (no prehash, empty context) over those bytes. The signature is 64 bytes, hex128.
- **`ecdsa-p256-sha256`** (the SNP tier) is ECDSA P-256 over SHA-256 of the same bytes. The signature is raw `r || s`
  (64 bytes, hex128, r and s in 1..n-1), and DER is refused. That keeps the closed key set free of an encoding member.
- **`sigAlg` must match the attested key's algorithm** as well as the tier rule. An Ed25519 SPKI with
  `ecdsa-p256-sha256` is refused by name. For the pVM the tier rule already fixes both.
- **The `instance.type` table is closed** at two rows. Any other string is refused before a byte is built.
- **SNP-tier note** (from the verifier session, for enclave-5d): with F11 the guest's HOST_DATA IS the deployment id, so
  on that tier `instance.value` duplicates `deployment`. The verifier there must still compare `instance.value` with the
  VERIFIED HOST_DATA, not with the deployment field, or the check covers nothing.

```
```

- **Canonical forms, refused rather than normalized.**
  - Every address and bytes32 is `0x` plus lowercase hex of exactly its length, and `instance.value` is 64 lowercase
    hex.
  - `chainId` is digits only: no sign, and no leading zero except "0" itself. It is a number in 1..2^64-1, encoded as 8
    bytes big-endian.
  - `proofKey` is not the zero address.
  - The object is closed: exactly these keys, and `instance` exactly `{type, value}`.
- **The verifier** (`verifyPvmProofKey(doc, expect)` in relay/pvm-app-attest.mjs, the canonical module; its WebCrypto
  copy is held equal by test):
  1. `doc.evidence` goes through the canonical `verifyPvmAppEvidence` with the caller's nonce and pins (and
     `instanceIds` when the deployment is bound). This is the only evidence parser.
  2. The InstanceID and AppID come from the VERIFIED envelope only. `instance.value` must equal the verified InstanceID,
     and `instance.type` must be "pvm-instance-id".
  3. **`expect.deployment` is REQUIRED** (the client's selected policy entry), and `deployment` must equal it byte for
     byte. This is the pVM's analogue of SNP's HOST_DATA: the statement is a fact about THIS deployment, not a hint the
     caller may forget to compare.
  4. The message is rebuilt from the verified values and the stated fields, and `sig` is checked under the attested
     transport key.
  5. It returns the claims `{ proofKey, chainId, proofOfTime, registry, deployment, enclaveId, operator, instanceId,
     appId }`.
  The caller (and the verifier session's gate) compares them with its own pins: `chainId`, `proofOfTime` and `registry`
  from the address book, `operator` and `enclaveId` from the ledger row, and `proofKey` with
  `EnclaveRegistry.get(enclaveId).proofKey`. It releases nothing on a mismatch.
- **The proof key signs nothing here.** It signs only checkpoints.

**What a checkpoint means** (stated for both plans, so nobody infers more): it attests that the VM was running and its
app serving, on the VM's own account of itself, over an anchor the host supplied and the chain bounds. It is not
evidence that the app was reachable or served anyone. The relay and the ledger decide reachability.

## Checkpoints: `CHECKPOINT <upto> <anchorBlock> <anchorHash>` on the evidence port

The VM answers one JSON line:

```
{ "format": "enclave-pvm-checkpoint/v1", "deployment", "enclaveId", "operator", "chainId", "proofOfTime", "registry",
  "upto": "<u64 decimal>", "anchorBlock": "<u64 decimal>", "anchorHash": "0x" hex64, "sig": "0x" hex130 }
```

**The VM's signing policy.** Each refusal is a one-line `{"error": ...}` naming the rule.
- **Only a ProofOfTime digest the VM builds itself,** from its pins plus the request's `upto`, `anchorBlock` and
  `anchorHash`. The host chooses no domain, no id, no enclave and no operator: there is no raw-digest signing path.
- **Only while its app is serving** (the app runtime is running in this VM).
- **Strictly increasing `upto`** and non-decreasing `anchorBlock` within a boot.
- **At most one signature per 60 s.**
- **No pins, no signature.**
- **What the chain still decides:** the anchor must be a real block within the last 256, the proof may advance by at
  most one window and by no more than the elapsed time, `upto` is clamped to now and to `leaseUntil`, and a replay
  reverts ("nothing to prove"). The VM cannot see the chain, and the contract already enforces these.

## Tests before any activation

- **Local lease verification.** The real EnclaveRegistry, EnclaveDeployments and EnclaveProofOfTime (compiled with the
  repo's solc-js pipeline) run on a local anvil chain.
  - The operator is its own anvil account, and a mock USDC stands in: no funds, and nothing public.
  - Register the entry with the VM's attested `proofKey`, create and fund a deployment, and claim it with the operator.
  - Then post VM-signed checkpoints: `provenUntil` advances.
- **Negatives** (the verifier session's list included):
  - at the verifier, additionally: a statement for a deployment other than the selected one; a statement over a v3
    envelope for another nonce, or the same statement replayed under a new nonce (it must fail at the nonce); a
    non-canonical `chainId` ("0x…", a leading zero, 2^64); an uppercase or short address or bytes32; the zero
    `proofKey`; a checkpoint signature with a high s, or v outside 27/28;
  - on the chain: a checkpoint signed by another key; a replay; a signature for deployment D posted for D2; a wrong
    enclaveId or operator; a stale anchor; `setProofKey` from a non-operator;
  - at the VM: a request while the app is not serving, a non-increasing `upto`, the rate limit, a malformed request;
  - at the verifier: a statement for another nonce, another instance or another app; a statement signed by a key other
    than the attested transport key; any edited field; a v2 envelope in place of v3.
- **Lifecycle.** The same `proofKey` across a restart, measured on the device.
- **The device check (bounded).** The Pixel's VM signs checkpoints over anchors from the LOCAL chain (its pins name the
  local chain id and contracts). They are posted to the local contracts, and must be accepted, and refused when
  replayed.

## Activation, exactly (the owner's steps; nothing here is done)

1. **A production anchor build.** It needs the production APK signing key and a non-debuggable manifest; its code hash
   `C` is from pins.py. The device checks here used the LAB key.
2. **Launch the VM with the lease's pins:**
   `--es proof_pins "8453 <EnclaveProofOfTime> <EnclaveRegistry> <deployment id> <runner id> <operator>"`
   - The contract addresses come from the address book (EnclaveAddressBook `0xab214342d5A490150A4A977063A2f88E21F80907`,
     keys `proofOfTime` and `registry`).
   - The runner id is `keccak256("https://api.enclave.host/t/<name>")`.
   - The operator is the operator EOA's address.
3. **Read the attested proof key.** Send `PROOFKEY <fresh nonce>` over the carrier and verify it with
   `verifyPvmProofKey`. Use the build's pins, the deployment and the policy's InstanceID. The result is `P`.
4. **Operator transactions** (the owner's EOA, on Base):
   - `EnclaveRegistry.register("https://api.enclave.host/t/<name>", repo, measurement, cpuPricePerSec6, 0, P)`, or
     `setProofKey(runnerId, P)` if the entry already exists;
   - then `EnclaveDeployments.claim(deployment, runnerId)`.
5. **The posting agent: BUILT** (`runner/proof-agent.mjs`, CLI `runner/proof-agent-cli.mjs`; "The posting agent" below).
   Run it as the owner's process, with the key file and RPC from the environment and a config holding only public values.
   Every `intervalSec` (default 300) it does the following:
   1. Reads the lease.
   2. Takes the parent of the newest block as the anchor.
   3. Sends `CHECKPOINT <min(head time, leaseUntil)> <anchorBlock> <anchorHash>` to the VM through the carrier.
   4. Verifies the answer against the attested key and the exact request.
   5. Simulates the transaction.
   6. Signs it with the operator key, journals it, then sends it.
   7. Follows it to a confirmed, canonical receipt.
6. **The relay's env and the buyers' type-2 policy** are as in RELAY-SERVING.md "Runner registration".

## The posting agent (built; device check PASS on the Pixel 10 against the real contracts on a local chain: results/pvm-cpu-proof-agent)

`runner/proof-agent.mjs` is the owner-side process of step 5, and `runner/proof-agent-cli.mjs` runs it. It holds no proof
key: the VM signs. It holds the operator key, as a local account, only to sign the transactions it sends. It trusts nothing
the carrier says, whether the carrier is the phone's Android host or the relay.

- **Pins, before anything is asked.**
  - The RPC's chain id must be the configured one.
  - The address book's `proofOfTime`, `registry` and `deployments` must equal any address the config also names.
  - The contracts' own frozen bindings must agree: `prover.deployments()`, `prover.registry()` and `ledger.prover()`.
- **The proof key** comes only from the VM's `enclave-proof-key/v1` statement, verified by the canonical `verifyPvmProofKey`
  over the agent's own fresh nonce, under the owner's evidence pins (app, runtime, code, authority, Google roots, the bound
  InstanceID) and the required deployment.
  - The statement's pins must be exactly this lease's.
  - The registry entry must publish exactly that key: active, this operator's, this endpoint's.
  - Otherwise nothing is signed (`proof-key-mismatch`, `registry-mismatch`).
- **The lease, every tick.** The ledger row must name this runner and operator, be active, and be within `leaseUntil`.
  Otherwise the VM is not asked (`not-our-lease`, `inactive`, `lease-ended`). Nothing is asked either when there is nothing
  to prove (`up-to-date`), or when the base fee is above the owner's cap (`fee-cap`).
- **A checkpoint is accepted only if both hold:**
  - `verifyPvmCheckpoint` passes (the pins, low s, v, the attested signer);
  - it answers EXACTLY the request: the same `upto`, `anchorBlock` and `anchorHash`.
  A carrier that hands back an older, genuinely signed checkpoint is refused before any chain sees it.
- **Simulate first.** "nothing to prove" (someone already posted it) costs nothing: `already-proven`. A stale anchor is
  retried on the next tick with a new one.
- **Idempotency and recovery.** Each transaction is signed locally and journaled (the raw bytes and the hash) BEFORE any node
  can see it, and the journal is fsynced. After a crash, the next start follows exactly what the journal says may be in
  flight: it rebroadcasts the same bytes while the anchor is fresh, and asks the VM for nothing new first. There is one
  agent per state directory (an O_EXCL lock).
- **Bounded waits.** The carrier, the receipt wait, the confirmations (the receipt must still be canonical afterwards) and
  the replacements are all bounded:
  - A send that does not mine is REPLACED at the same nonce, bidding at least 25 % more on both fee fields, up to
    `maxReplacements`, and never above the owner's `maxFeePerGasWei`.
  - A nonce whose proof's anchor has aged out, or was reorganized away, is taken by the next tick's FRESH proof.
  - When there is nothing to prove, such a nonce is CANCELLED with a 0-value self-transfer, so it never blocks the
    operator's other transactions (claim, renew, heartbeat).
  - A receipt reorganized away is rebroadcast while its anchor stands.
- **Tests.**
  - `test/pvm-proof-agent.test.mjs` runs on anvil with the real contracts, a fake VM speaking the device protocol, a
    carrier that turns hostile, and a fresh random operator key per test. It covers every rule above, plus the CLI's
    refusals and one real CLI tick.
  - `node test/mutate-pvm-proof-agent.mjs` is the mutation check: a control, then 19 mutations, each caught by the test it
    names.
- **Device check.** `cpu/proof-agent-run.mjs` runs the real VM on the Pixel 10, through the real hub and web carrier, against
  a local chain that mines a block every 2 s. The run plan covers:
  - the first attestation, and an unclaimed lease;
  - a landing;
  - a hostile replay;
  - a mempool replacement;
  - a reorganization;
  - a crash and its recovery;
  - a stuck nonce taken by a fresh proof;
  - a VM restart, followed by another landing.

  `runtime/conformance/check-proof-agent.mjs` re-checks it offline from the run's own records (results/pvm-cpu-proof-agent).
  It PASSES: 6 proofs landed, and the reorganization was noticed after the receipt was seen, with the same bytes landing
  in another block. The checker's own test mutates a copy of the run 15 ways, and each must fail.
  - Run 1 is kept with its checker FAIL: its reorganization hook fired before the agent saw the receipt
    (results/pvm-cpu-proof-agent-run1/NOTES.md).
- **The rest of the lifecycle** (register or `setProofKey`, `claim`, `renew`, `release` after a final proof, and
  `heartbeat`) is the runner lifecycle agent. It is built on this agent's transaction engine, in RUNNER-AGENT.md.
  `withdrawEarnings` is not built.

**Exactly what production still needs** (all the owner's; nothing here is set):
1. `PROOF_AGENT_RPC`: a Base RPC URL.
2. `OPERATOR_KEY_FILE`: the operator EOA's key, in a 0600 file, with Base gas.
   - The agent must be the only sender from that key, or run as a dedicated posting account.
   - Posting is permissionless, but the lab ran it as the operator.
3. The config (format `enclave-pvm-proof-agent/v1`):
   - `chainId` "8453";
   - `addressBook` `0xab214342d5a490150a4a977063a2f88e21f80907`;
   - `deployment`;
   - `endpoint` `https://api.enclave.host/t/<name>`;
   - `operator`;
   - `maxFeePerGasWei`, the owner's gas price cap;
   - `evidence`: the PRODUCTION build's code hash and authority, the pvm-rt runtime id, the app id, and the InstanceID from
     `pvm-client instance`. Google's roots are as in the client.
4. `carrier`: a route to the VM's evidence port. The platform route `https://api.enclave.host/x/<deployment>/pvm/evidence`
   exists only with `PVM_SERVING` set (RELAY-SERVING.md), which is the owner's decision. Otherwise the owner runs their own
   carrier to the phone.
5. The production anchor build (step 1), and steps 2-4 above.

**Inputs only the owner has:**
- the operator EOA and its Base gas;
- the production APK signing key;
- which deployment;
- the runner's price, and the registry's repo and measurement strings;
- the decision to set `PVM_SERVING`.

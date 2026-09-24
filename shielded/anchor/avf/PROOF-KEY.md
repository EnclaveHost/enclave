# The pVM lease proof key (PROPOSED to the verifier session and the Linux isolation owner; `enclave-pvm-proof-key/v1`)

**Status.** A proposed wire format and signing policy, sent for agreement before any bytes are written. LAB, not
production. Nothing is registered, published or funded. This was directed in this session, continuing the pVM CPU host
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
`chainId` (u64), `proofOfTime` (the EnclaveProofOfTime address), `deployment` (bytes32, the ledger id),
`enclaveId` (bytes32, the runner id = keccak256 of the registered endpoint), `operator` (address, the lease's
`runnerOperator`).

## The attested statement: `PROOFKEY <nonce>` on the evidence port

The VM answers one JSON line:

```
{ "format": "enclave-pvm-proof-key/v1", "evidence": <the enclave-pvm-app-evidence/v3 envelope for this nonce>,
  "proofKey": "0x" hex40, "chainId": "<u64 decimal>", "proofOfTime": "0x" hex40, "deployment": "0x" hex64,
  "enclaveId": "0x" hex64, "operator": "0x" hex40, "sig": hex128 }

sig = Ed25519_transport("enclave-pvm-proof-key-v1\n" || nonce (32) || AppID (32) || InstanceID (32) || proofKey (20)
                        || chainId (8, big-endian) || proofOfTime (20) || deployment (32) || enclaveId (32) || operator (20))
```

- The embedded envelope is ordinary v3, verified by the canonical `verifyPvmAppEvidence`. There is no second parser.
  Its transport key signs the statement, and Bind3 ties that key to the nonce, the runtime, the InstanceID and the AppID.
- **The statement binds** the proof key to the app, to THIS instance (the enrolled one, by the type-2 policy) and to
  the exact domain and lease fields the key will sign.
- **The proof key signs nothing here.** It signs only checkpoints, so no request can make it sign anything else.
- **The verifier** (a new function in relay/pvm-app-attest.mjs, the canonical module):
  1. verifies the envelope (v3, the caller's nonce and pins, and the caller's instance expectation when the deployment
     is bound);
  2. rebuilds the message from the verified nonce, AppID and InstanceID and the stated fields;
  3. checks `sig` under the attested transport key;
  4. checks the fields' forms (lowercase hex, `chainId` in 1..2^64-1).
  The caller then compares `proofKey` with `EnclaveRegistry.get(enclaveId).proofKey`, and the pins with the ledger row
  (runner == enclaveId, runnerOperator == operator).

## Checkpoints: `CHECKPOINT <upto> <anchorBlock> <anchorHash>` on the evidence port

The VM answers one JSON line:

```
{ "format": "enclave-pvm-checkpoint/v1", "deployment", "enclaveId", "operator", "chainId", "proofOfTime",
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
- **Negatives:**
  - on the chain: a checkpoint signed by another key; a replay; a signature for deployment D posted for D2; a wrong
    enclaveId or operator; a stale anchor; `setProofKey` from a non-operator;
  - at the VM: a request while the app is not serving, a non-increasing `upto`, the rate limit, a malformed request;
  - at the verifier: a statement for another nonce, another instance or another app; a statement signed by a key other
    than the attested transport key; any edited field; a v2 envelope in place of v3.
- **Lifecycle.** The same `proofKey` across a restart, measured on the device.
- **The device check (bounded).** The Pixel's VM signs checkpoints over anchors from the LOCAL chain (its pins name the
  local chain id and contracts). They are posted to the local contracts, and must be accepted, and refused when
  replayed.

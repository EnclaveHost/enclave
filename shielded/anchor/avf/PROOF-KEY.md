# The pVM lease proof key (AGREED with the verifier session and the Linux isolation owner; `enclave-proof-key/v1`)

**Status.** The wire format and signing policy were agreed with the verifier session (enclave-99) and the Linux
isolation owner (enclave-5d) before the statement's bytes were written. The checkpoint bytes are the contract's own.
LAB, not production. Nothing is registered, published or funded. This was directed in this session, continuing the pVM CPU host
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
  enclave-pvm-app-evidence/v3 envelope>, "instance": { "type": "pvm-instance-id", "value": hex64 },
  "proofKey": "0x" hex40, "chainId": "<u64 decimal>", "proofOfTime": "0x" hex40, "registry": "0x" hex40,
  "deployment": "0x" hex64, "enclaveId": "0x" hex64, "operator": "0x" hex40, "sig": hex128 }

message = "enclave-proof-key-v1\n" || nonce (32) || AppID (32) || instanceType (1) || instanceValue (32) || proofKey (20)
          || chainId (8, big-endian) || proofOfTime (20) || registry (20) || deployment (32) || enclaveId (32) || operator (20)
sig     = Ed25519 by the ATTESTED transport key (pVM: the v3 envelope's spki) over message
instanceType: 0x01 = "pvm-instance-id" (the v3 InstanceID), 0x02 = "snp-host-data" (reserved for the SNP tier)
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

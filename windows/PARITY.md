# nucbox-k11 against metal0: what is actually the same, and what is not

The VBS box (`windows/node`) sells app hosting on the same ledger as the platform's confidential
VMs. This is the capability-by-capability comparison, by **behaviour and evidence** rather than by
whether a flag is `true` — a flag that is true while the behaviour differs is worse than one that
is false, because the relay AND-folds these across the fleet and clients act on them.

Evidence is one of: **measured** on the box, **cross-checked** against the platform runner's own
self-test seam, or **live** (the thing is running now).

## Done — 18 of 21

| capability | what it means on metal0 | on nucbox-k11 | evidence |
|---|---|---|---|
| `configOverride` | the envelope's `config` replaces the version's | same | live: 3 of 4 apps carry one |
| `configCid` | a rev-7 catalog version's config lives at a CID | same, via `versionConfigCid`, CID-verified | live chain: catalog schema rev 9 |
| `configCidOverride` | the envelope's `configCid` namespace | same, CID-verified | live: `0xa69dcbba` runs on one |
| `configEdit` | `setConfig` reaches a LIVE deployment | same: rules swap in place, config relaunches | cross-checked: 13 records vs `CFG_EDIT_SELFTEST`, zero divergence |
| `shareResize` | `setShares` re-slices a live deployment | card share relaunches (it gates the model); node share is admission+billing here, stated | measured: the exclusion arithmetic is tested |
| `waf` | per-address rate/concurrency/body caps + method, path, agent filters | same, at both doors | cross-checked: 34 cases vs `WAF_SELFTEST`, zero divergence, error strings included |
| `secrets` | relay-staged values into the guest env | same, operator-signed | live: 5 names for the adapter, 6 for the MCP app |
| `secretsInConfig` | `$NAME` resolved inside the app config | same | cross-checked: 8 cases byte-identical to `_subst_secrets`; live log shows 5 resolved |
| `cpuFallback` | a version's `cpuFallback` sizes a coreless placement | same | tested |
| `gpuOptional` | `{"gpu":{"optional":true}}` lets a card deployment run on cores | same | tested |
| `networkOptions` | the `network` namespace is understood | same | live: the adapter carries `{"network":{"relay":"us-west"}}` |
| `rateCap` | prices off its own registry entry, asks the ledger first | same | live: refusals quote the numbers |
| `proofOfTime` | EIP-712 checkpoints from the registry's proof key | same; the key lives in VTL0 here and `/v1/attestation` says so | live |
| `mem64` | 64-bit linear memories | same | measured in VTL1: 4 GiB grow, store/load at byte `0x1_0000_0000`, OOB traps, memory released |
| `customDomains` | owner-attached hostnames, certified, `ENCLAVE_HOSTS` | same; certificate chosen by SNI | live: the fetch runs each tick; failure path proved itself on its first timeout |
| `selfHostFree` | the declared payout wallet's own deployments run free | same | live |
| **private deployments** | served to the owner alone, proved by an ES256 session | same; SIWE routes byte-compatible with the platform's | live: signed in over the tunnel, replay refused, tampering refused |
| `devDeploy` | a PENDING catalog version runs on a PRIVATE deployment | same; public deployments of a pending version stay refused | tested |

## Not done — 5, with the actual blocker

| capability | blocker | state |
|---|---|---|
| `set` | **soundness, not the atomics.** Pulley has the atomic instructions now (litmus: 400000 of 400000 exact; 110618 with an injected defect) and ordinary shared accesses are relaxed atomics. What remains is mixed-width overlap, bulk ops, host accesses and growth — see `wasm/PULLEY-ATOMICS.md`. **Refused, fail-closed.** |
| `p3` | wasip3 in the enclave runtime: a second WASI host surface against the p3 WITs. No design blocker, not started. |
| `coopThreads` | cooperative threads. Same shape as p3: runtime work, no design blocker. |
| `volumes` | attested model volumes. metal0 puts an ext4+dm-verity digest in SNP `HOST_DATA`; VBS has no equivalent, so this needs a Merkle-verified read-only file provider **inside** VTL1, plus a real `wasi:filesystem` (today it is empty and refusing). The design is clear; it is the largest remaining item. |

## Differences that are NOT capability gaps, and are published rather than implied

- **App traffic is carried by VTL0.** The agent holds the socket and the TLS key
  (`availability.appTls.keyIn = "host-process"`). The app's code and memory are in VTL1; its bytes
  are not. metal0 terminates in-CVM.
- **Rate limits are per-address on `/x/<id>` and per-deployment on the app's own hostname.** The
  relay inserts a forwarded header on the first (measured: `x-forwarded-for: 4.15.13.178`) and
  splices TLS without terminating it on the second, so there is no address to read there and
  trusting a caller-supplied one would be no limit at all.
- **The node share is admission and billing, not a slice.** An app here is interpreted bytecode on
  the enclave's own threads; there is no cgroup to widen.
- **The RAM pool is the enclave's fixed size**, not the machine's: 64 GB, less the 1879 MB the
  engine holds (measured, asked of the enclave before any app is claimed).
- **The card is outside the enclave.** It is used by masked offload and the row says `gpu`, not
  `tee gpu`.
## The one that is a SECURITY GAP, not a difference

**The session-signing key and the app-zone TLS key are held by the host, not the enclave.** metal0
mints both inside the measured guest: its operator never sees the private half and therefore cannot
forge a session for somebody else's wallet, nor terminate a tenant's TLS. Here both are in the
agent's process in VTL0, so the machine owner can do either.

**Disclosing this does not close it.** `/availability` carries `session.keyIn` and `appTls.keyIn`
so a tenant is told rather than left to assume, and it is consistent with what this box already
concedes about app traffic — but "the operator is trusted here and is not trusted there" is a
difference in the SECURITY MODEL, and no amount of documentation makes the two equivalent. A tenant
whose threat model includes the machine owner should not choose this box for a private deployment,
and nothing here should be read as saying otherwise.

Closing it means minting and using both keys inside VTL1. That is not done, but it is no longer an
open question in the same way for both halves, because the first has now been measured.

### Measured: ES256 in VTL1 works (windows/vbs/enclave/p256*)

The enclave's own crypto is TweetNaCl - Ed25519 and X25519, no P-256 - so the first question was
whether an enclave can do ECDSA at all, or whether the enclave-flavoured `bcrypt.dll` offers only
the RNG it is already used for. It offers the whole thing. A spike that mints a P-256 key inside
the enclave and signs a digest the host chose:

| | |
|---|---|
| mint a key + first signature | **1.51 ms** |
| each further signature | **0.146 ms** |
| key lifetime | per enclave, not per call (second call reports `reused: 1`) |
| signature shape | 64 bytes of **R\|\|S** - exactly what an ES256 JWT carries, no re-encoding |
| what crosses the gate | the public key and the signature. The request struct has no field for a private key |

Verified out of band by `@noble/curves`, not by the enclave's own say-so, including that a signature
is rejected for a digest it was not made for. (`node:crypto`'s `verify(null, …)` HASHES its data for
an EC key, so it reports a good signature over a digest as invalid - it did, and the enclave was not
at fault.) Recorded rather than claimed: the enclave *can* export its own private blob from inside.
The property is that nothing does, not that the platform forbids it.

So the session-key half is now a wiring job, not a research question.

### But moving the key is NOT sufficient, and this is the part worth being clear about

An enclave-held signing key stops the operator READING the key. It does not stop them USING it: the
host decides what digest to hand in, so an operator who can call the enclave can have it sign a
token naming any wallet they like. Moving the key alone converts "forge a session at will, forever,
even after the fact" into "forge a session at will while the box is running", which is an
improvement and is not the property metal0 has.

To actually close it the enclave has to own the DECISION, not just the signature: verify the SIWE
message and its ERC-4361 fields inside VTL1, build the claims there, and sign what it built. The
key never leaving is then a consequence rather than the point.

### The TLS half is a different problem and this spike does not touch it

A signing oracle is enough for a JWT because the token is built from a digest. It is not enough for
TLS: Node's `tls` cannot delegate a handshake signature to an external signer, so terminating a
tenant's TLS in VTL1 means a TLS stack inside the enclave, or a terminator that is not Node. Still
open, and larger than the session half.

## A trap worth keeping: catalog declarations are wrong in both directions

`s3-ipfs-adapter:1.0.10` declares `set: true` and `threads: true` and runs perfectly well without
either. `risc-box:0.6.15` declares neither and its artifact contains shared memories. The claim gate
reads the declaration; only the compiler reads the bytes. So the gate refuses apps that would work,
and admits apps that cannot — and the second one had this box holding a lease it could never honour
until a compile failure naming a missing feature was made permanent.

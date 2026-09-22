# nucbox-k11 against metal0: what is actually the same, and what is not

The VBS box (`windows/node`) sells app hosting on the same ledger as the platform's confidential
VMs. This is the capability-by-capability comparison, by **behaviour and evidence** rather than by
whether a flag is `true` — a flag that is true while the behaviour differs is worse than one that
is false, because the relay AND-folds these across the fleet and clients act on them.

Evidence is one of: **measured** on the box, **cross-checked** against the platform runner's own
self-test seam, or **live** (the thing is running now).

## Done — 16 of 21

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

## Not done — 5, with the actual blocker

| capability | blocker | state |
|---|---|---|
| `set` | **soundness, not the atomics.** Pulley has the atomic instructions now (litmus: 400000 of 400000 exact; 110618 with an injected defect) and ordinary shared accesses are relaxed atomics. What remains is mixed-width overlap, bulk ops, host accesses and growth — see `wasm/PULLEY-ATOMICS.md`. **Refused, fail-closed.** |
| `p3` | wasip3 in the enclave runtime: a second WASI host surface against the p3 WITs. No design blocker, not started. |
| `coopThreads` | cooperative threads. Same shape as p3: runtime work, no design blocker. |
| `volumes` | attested model volumes. metal0 puts an ext4+dm-verity digest in SNP `HOST_DATA`; VBS has no equivalent, so this needs a Merkle-verified read-only file provider **inside** VTL1, plus a real `wasi:filesystem` (today it is empty and refusing). The design is clear; it is the largest remaining item. |
| `devDeploy` | depends on PRIVATE deployments, which this box refuses because it verifies no session token. That needs an ES256 session key minted in the enclave, a JWKS endpoint, the SIWE hand-off and an app-origin cookie. Security-sensitive; deliberately not rushed. |

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

## A trap worth keeping: catalog declarations are wrong in both directions

`s3-ipfs-adapter:1.0.10` declares `set: true` and `threads: true` and runs perfectly well without
either. `risc-box:0.6.15` declares neither and its artifact contains shared memories. The claim gate
reads the declaration; only the compiler reads the bytes. So the gate refuses apps that would work,
and admits apps that cannot — and the second one had this box holding a lease it could never honour
until a compile failure naming a missing feature was made permanent.

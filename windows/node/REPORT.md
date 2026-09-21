# The Windows consumer node: attested, listed, and hosting an app

What the NucBox K11 does on enclave.host as of 2026-09-21, and the boundaries of it. The pieces:
`agent.mjs` (the tunnel and the public surface), `host.mjs` (leases and app lifecycle),
`chain.mjs` (registry, ledger, proofs), `apprun.mjs` (the wasmtime launcher), `host-onchain.mjs`
(the owner's three transactions), `keys.mjs` (the box's own keys), plus the VBS enclave engine in
`windows/enclave-engine` and the Vulkan worker in `windows/worker-win`.

## What is live

| | |
|---|---|
| Attested to the relay | mode `vbs`, tier `vbs-dev`, `teeCpu windows-vbs-enclave` (windows/vbs/EVIDENCE.md) |
| On the registry | `https://api.enclave.host/t/nucbox-k11`, id `0xd497d065…`, operator `0x389C3f03…` (a key generated on the box), price 12/sec for a whole node, proof key `0x84f627aF…`, measurement `0xce450a96…` = the enclave build the relay verified |
| Holding a lease | deployment `0xca141665…`, hello-world 1.0.4 from the catalog, claimed by this box, rate **0** (the box's declared payout wallet owns it, so `_hostRate` is zero) |
| Serving that app | `https://api.enclave.host/x/0xca1416…/` → `Hello World!` in 0.70 s through the relay; the node fetched the artifact by CID, verified it against that CID, and runs it under stock wasmtime |
| Serving inference | the 0.5B model inside the VBS enclave, masked-offloaded to the Radeon 780M, sealed sessions (windows/enclave-engine/REPORT.md) |

## Where an app runs, and why that is the honest part

An app is a `wasi:http` component and `wasmtime serve` runs it. wasmtime cannot run inside a VBS
enclave (no JIT, no mmap, no Rust std in VTL1), so a hosted app runs in **VTL0**, the ordinary
Windows session, which the machine's owner can read. The enclave holds the model, the pads and the
keys; the app does not. The node says exactly that in `/availability`:

```json
"apps": { "isolation": "host-process", "inTee": false, "runtime": "wasmtime", "world": "wasi:http",
          "scope": "owner-only", "running": 1,
          "note": "apps run on the Windows host, not inside the VBS enclave; the enclave holds the model and the pads" }
```

and the fleet row renders it as "1 app on the host, outside the enclave". Every other box in the
fleet runs apps inside the TEE its quote covers; this one does not, and nothing in the protocol
would have caught the difference, so the node states it rather than letting the badge imply it.

## The scope, enforced in code

`chain.mjs claimPolicy` refuses, by name, anything this box cannot honour:

- **owner-only**: the deployment's owner must be the wallet the registry records as this box's
  payout wallet. A stranger's deployment is refused, so nobody is sold host-process isolation.
- **public-only**: a private deployment's gate is a session token this node does not verify.
- **no GPU share**: the card is reserved for the enclave's masked inference.
- **no unsupported options**: a WAF, relay-staged secrets, or an envelope at a CID are refused
  rather than silently ignored.
- and it never advertises `claimEnabled`, so it stays **out of the relay's serving set**. That is
  not modesty: `aggregateAvailability()` ANDs `waf`, `configOverride`, `configEdit`, `shareResize`,
  `cpuFallback`, `gpuOptional`, `networkOptions`, `secrets` and more across every serving box, so a
  minimal host that joined would switch those features off for every customer on the platform.

## Stock wasmtime: what works and what is missing

Measured on the box (wasmtime 49.0.0 for Windows, the platform's own engine line, 125 commits
ahead of its pin): a real catalog component serves in **53 ms cold, ~5 ms warm**. The platform's
serve line works as written except four flags a stock build rejects outright, before it reads the
module:

| missing | consequence |
|---|---|
| `-S loopback-allow` | no cross-app loopback wall, which is why this node runs one owner's apps and caps the count |
| `-S egress` | outbound leaves from this machine's address, never a deployment's dedicated IPv6 |
| `-S nn-graph=ggml` (and `sd`, `nvenc`) | no LLM or diffusion app can run here; ONNX does work, but a GPU target silently lands on the CPU without the platform's strict-GPU patch, so this node does not offer it |
| `-W set-epochs` | no SET-parallel app |

Also absent: the raw-stream frames, so no streaming, no SSE and no app-subdomain TLS path. An app
here is reachable at `/x/<id>` through the relay, buffered, inside the 30 s frame deadline.

## The lease, and the money

`create` → `claim` → `renew` every quantum (1800 s), `release` on stop. The rate is 0 because the
box declared its owner's payout wallet, so the deployment needs no balance and nothing is charged.
Proof-of-time checkpoints are **skipped while the rate is zero**: they would spend the box's gas
every five minutes to credit a meter multiplied by zero. On a paid lease they resume.

The box's operator key holds a small gas tank and nothing else; earnings would go to the payout
wallet, which the operator key cannot change. The proof key sits beside it on the host, so on this
node a checkpoint is worth what the owner's word is worth. On a fleet enclave that key is minted
inside the CVM; here it is not, and `keys.mjs` says so.

## Bring-up

```
node keys.mjs                                   # the box's operator + proof keys, printed
OWNER_KEY=0x… node host-onchain.mjs fund-operator <0xoperator> 0.0004
                                                # the box registers itself on its next tick
OWNER_KEY=0x… node host-onchain.mjs declare-payout
OWNER_KEY=0x… node host-onchain.mjs deploy catalog://<appId>/<index> [cpu%] [maxRate $/h]
```
`enclave deploy` is the normal route for the last step; it needs a serving enclave to quote a price
from, which a fleet of owner-only nodes does not have, so `host-onchain.mjs deploy` is the direct
equivalent. `POST /v1/host/run {appRef}` on the loopback surface runs an app with no lease at all,
for bring-up.

## Open, in one line each

Streaming and the app subdomain need the raw-stream splice and an in-process TLS terminator; the
tier stays `vbs-dev` until Artifact Signing; apps are not in the enclave and cannot be until a
component runtime exists for VTL1; multi-owner hosting needs the loopback wall, i.e. a patched
wasmtime for Windows; and the fleet-AND capability set is what stands between this node and
`claimEnabled`.

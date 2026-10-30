# pVM CPU slots by share, in production (2026-10-09)

The phone (`pixel10-pvm-cpu`, Pixel 10 Pro XL) serves several buyers' apps at once, one protected VM per app, each sized
to what its app bought (PVM-CPU.md "Slots by share"). Build `9f38fd611fa9…` (release key), host agent `5ed8aa2b3`, relay
`e926cf744` (capacity) on top of `269963f08` (sibling evidence).

## The switch (09:39-09:43Z)

| time (UTC) | event |
|---|---|
| 09:38:50 | relay restarted with the new build pinned (`PVM_CPU_CODE_HASHES`) and the slot-pool capacity (CI, relay job only) |
| 09:39:31 | host agent started with `slots {count 4, poolMemMb 3072, routerPort 17780}`; the one-VM state moved to slot 1 |
| 09:40:13 | host VM serving the idle app: same instance (`cd3358eb…`) and proof key (`0x26c1d63d…`) as before the APK update |
| 09:40:25 | slot 1 (384 MiB VM) serving `0x77e75476…` 10 s after launch |
| 09:40:26 | the host's key handed to slot 1 in the VMs (KEYNONCE / KEYREQ / KEYGRANT / KEYINSTALL), kept in its store; 0.3 s |
| 09:40:32 | the entry re-stated for the new build (`register`, landed) |
| 09:40:41 | the relay released the app's secret sealed to SLOT 1's seal key, after the sibling check |
| 09:41:15 | relay: `verified pixel10-pvm-cpu/0x77e75476 … instance 800e8230de07 (a sibling VM holding the host's proof key)` |
| 09:42:44 | certificate installed in slot 1 |

Then, over the public URL: 401 without the app's API key (the sealed secret resolved in the VM), MCP initialize /
tools/list, `tools/call` returning `bytecodealliance/wasmtime` (the VM's egress through its own TUNA route), the WAF's
method and path answers.

## Three apps at once (09:43-09:53Z)

Two stopped test purchases were resumed by their owner (`setActive`, gas only), and the sweep took each into its own slot:

| slot | deployment | app | VM | key handed | claimed | certificate |
|---|---|---|---|---|---|---|
| 1 | `0x77e75476…` | MCP adapter (wasi:http, sealed secret, waf, egress) | 384 MiB | 09:40:26 | (moved, lease kept) | 09:42:44 |
| 2 | `0xf14fa921…` | pixelboard (socket server, 256 MiB) | 384 MiB | 09:44:43 | 09:44:56 | 09:46:57 |
| 3 | `0x7f45af3e…` | hello-world (wasi:http) | 384 MiB | 09:46:01 | 09:46:14 | 09:48:19 |

- The relay verified each from its own VM: instances `800e8230…`, `0fe74a0a…`, `178e764a…`, each with its own TLS key,
  each "a sibling VM holding the host's proof key".
- Proofs landed for every slot (09:46:53 slot 1, 09:50:04 slot 2, 09:51:18 slot 3, a renew for slot 1 at 09:52:04), one
  transaction at a time.
- Public URLs, WebPKI TLS ending in each VM, through the agent's SNI router: `77e75476` 200 (0.73 s), `f14fa921` "pixel
  board" (0.84 s), `7f45af3e` "Hello World!" (0.96 s, after TUNA's provider allocation).
- `/enclaves`: `nodeRamGb 3, ramGbFree 1.9, cpuShareFree 0.25, nodeGflops 1.45, cpuGflopsFree 0.36, slots 4,
  nodeSlotsFree 1`, `capacitySource "pvm-capability-report + the owner's slot pool"`.
- The phone with four VMs (host + three slots): MemAvailable 5.88 GB of 15.9 GB (6.40 GB earlier the same day with only the host VM running);
  crosvm RSS 218 MB (host VM, 2 GiB configured), 167 / 163 / 154 MB (the 384 MiB slots).

## Rollback

`~/enclave-prod/pvm-host/config.json.bak-slots-20261009` (and `current -> release-70f28761a`), the TUNA config's
`.bak-slots-20261009` (appPort 17786), nan's `api-relay.env.bak-slots-20261009`. The `ad6ec91d` APK was not kept: a
rollback rebuilds the one-VM commit and pins ITS code hash (relay, TUNA, agent). This build is kept at
`~/enclave-prod/pvm-host/apk/anchor-pvm-cpu-release-9f38fd61.apk` (+ idsig). The one-VM agent reads `current`, which the
slot agent no longer writes: a rollback serves from the idle state and re-takes.

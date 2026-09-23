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

## TEMPORARY RELAXATIONS, 2026-09-22 (restore and audit these)

Taken under an explicit instruction to get risc-box running and defer hardening. Each is listed
with what it turns off and how to undo it.

| what | where | why | undo |
|---|---|---|---|
| Pulley's THREADS refusal lifted | `wasmtime-set` `crates/wasmtime/src/config.rs` | risc-box cannot be COMPILED at all while it stands, so nothing downstream can be tried | restore the `unsupported \|= WasmFeatures::THREADS` line |
| `thread.spawn` left out | `set_threads.rs` stays `all(std, threads)` | it needs `mpsc`, `io`, `process::abort`; wait/notify and shared memory do not | finish the no_std port of that module |
| card share need not reach the model | `ENCLAVE_ALLOW_CARD_WITHOUT_MODEL=1`, `host.mjs` | risc-box bought 1% of the card but is wasi:cli, so `generate` is unreachable | have the publisher declare `gpuOptional`, then unset |
| IPFS gateway moved off the local adapter | `node-config.cmd` | the adapter was failing S3 with `RequestTimeTooSkewed`, so every artifact fetch got `IncompleteRead(0 bytes)` | restore once the adapter's clock is fixed |
| bytecode ceiling 64 MB -> 512 MB | `ee-app.cpp`, `ee-host.c` | risc-box is 85 MB of Pulley bytecode | keep; 64 MB was never the real constraint |
| memory budget from the app's own config | `host.mjs` | the catalog declares 3072 MB, the config asks for a 21764 MiB guest | arguably correct behaviour; audit it |

Also still open from the audits, deferred rather than closed: three thread-lifetime fixes whose
mutants still pass (release/entry window, host-lied-about-spawn, `done` ordering), the token
capacity and release-barrier work, and the fact that an atomic racing an ordinary access can tear
here where hardware would not.

## The shared-memory budget is one global, and nothing gives it back

`SHARED_RESERVE` (`enclave-rt/src/lib.rs`) is a single process-wide number, written from
`ENCLAVE_MEM_MB` by *whichever app opens last*, and read by every shared memory any app creates
afterwards. This enclave hosts five deployments, so one tenant's declared RAM is the ceiling on the
next tenant's shared memory — cross-tenant by construction, and invisible until an app is refused
memory it paid for. It happens to have worked here only because a shared memory's capacity is
fixed when it is created and the opens are serialised, so each app's own memory is sized while its
own value is still installed.

The budget is also a per-memory ceiling with no running total: `new_memory` reserves
`min(declared max, budget)` for each shared memory, so two of them each reserve the whole enclave,
and dropping one refunds nothing because there is nothing to refund to. What we log today reads
reassuringly and means less than it looks: `memory.grow: 634 MiB -> 1274 MiB (capacity 23940 MiB)`
names the WHOLE budget as one memory's capacity.

The fix is a claim/release pair rather than a getter — `wasmtime_shared_reserve_claim(want, min)`
answering what was actually granted out of what is left, and a release on `MallocMemory`'s drop —
which means touching `memory.rs` and `malloc.rs` in the `wasmtime-set` tree, plus per-app budgets
keyed by slot instead of one static. Not done here: it needs an engine rebuild, and the rebuild
costs the running risc-box instance a ~12 minute snapshot restore.

## A trap worth keeping: catalog declarations are wrong in both directions

`s3-ipfs-adapter:1.0.10` declares `set: true` and `threads: true` and runs perfectly well without
either — and on 2026-09-22 that stopped being a note and became an outage on this box. The engine
was rebuilt several times in a row for the SET work; the node was down long enough for the lease on
`0x7ae476a3` to expire at 12:32:29; and the re-claim was then refused, by name, for features the
app had never used. It had been serving from inside the enclave twenty minutes earlier. A forced
claim-hint does not help: `force` clears a previous failure, it does not overrule `claimPolicy`.

The published service was unaffected (`ipfs.enclave.host` still answers), because the gateway is
served elsewhere. What was lost is this box's ability to host an app it had been hosting. Until the
version is republished without the false declaration, or this box genuinely offers SET, that
deployment cannot come back here. `risc-box:0.6.15` declares neither and its artifact contains shared memories. The claim gate
reads the declaration; only the compiler reads the bytes. So the gate refuses apps that would work,
and admits apps that cannot — and the second one had this box holding a lease it could never honour
until a compile failure naming a missing feature was made permanent.

## Why the guest never got past OpenSBI: a host clock and a 0.5 MIPS guest

The console stopped at OpenSBI's hand-off to Linux and stayed there through 1.8G dispatched
steps. It is not a broken image, not the snapshot, not the enclave: the same kernel and rootfs,
with the same 21764 MiB and the same settings, boot fine natively, and the same emulator built to
wasm boots them under Cranelift AND under Pulley.

What differs is the CLOCK. risc-box's config sets `realtime: true`, which drives the guest's mtime
from the HOST's clock - the right choice for anything that paces itself, like the DOOM this
machine was built for, and it assumes the guest runs near real speed. In this enclave there is no
JIT: the emulator is Pulley bytecode and the guest manages ~0.5 MIPS. The 10 ms timer then lands
every ~5,000 guest instructions while the kernel's timer ISR costs ~31,000, so the guest can never
finish servicing one tick before the next is due. It executes flat out, retires almost nothing,
and never reaches the code that would print. OpenSBI is unaffected because it runs before Linux
enables the timer - which is exactly where the console stops.

Measured under Pulley, same images, only the clock changed:

```
instruction-driven   65M instructions to "Linux version"
wall-clock          121M instructions to "Linux version"   (1.86x, at 3.6 MIPS)
```

and the gap grows as the guest slows, because the ISR cost is fixed while the instructions between
ticks scale with MIPS. At 3.6 MIPS there are ~36,000 instructions between ticks and it merely
costs 1.86x; at 0.5 MIPS there are ~5,000 and it does not converge.

WORKAROUND IN PLACE (operator override, not the tenant's published config): host.mjs now applies
`ENCLAVE_APP_CONFIG_PATCH`, a per-deployment patch over the resolved app config, set in
node-config.cmd to `{"0xe64f7cba…":{"realtime":false}}`. It is logged on every apply. Note it
changes the snapshot IDENTITY (which includes `realtime`), so the warm snapshot is refused and the
machine cold-boots - correct, and the reason the restore looked broken too: a restored desktop
livelocks the same way, which is why it sat at `cursor.updates=14` and ignored every `/hid` event
while reporting `guest_idle=false`.

A JIT in VTL1 is NOT the fix and cannot be: VTL1 refuses every executable page with
ERROR_DYNAMIC_CODE_BLOCKED - measured, see "VTL1 refuses executable pages" at the end of this
file. What is left is a guest clock that is neither pure host time nor pure instruction count, or
compiled code that was measured at load. Until then a paced workload cannot have both correct
pacing and forward progress on this box.

## The page serves; the machine inside does not run

`e64f7cba` answers on its own hostname — HTTP 200, 31046 bytes, 2.7 s, on a real ZeroSSL
certificate (`CN=e64f7cba.app.enclave.host`, ECC DV, verified, expires 2026-12-21) — and the
emulator is genuinely executing Pulley bytecode in VTL1. The GUEST is another matter, and the
page loading says nothing about it.

Measured on the restored instance, six samples 25 s apart:

```
instret 411.6M -> 477.6M : +13.2M every 25 s, five times, to the digit
cursorUpdates 14         : unchanged
gpu flushes 9570         : unchanged, scanSum unchanged
net tx 0 rx 0            : no frame in either direction
consoleBytes 0           : nothing on the console, ever
```

A `POST /hid` move to the far corner is ACCEPTED (`{"ok":true,"events":1}`) and changes nothing:
the emulator's own `cursor.updates` stays 14 and `/fb.png` comes back byte-identical (md5
`7e34e7944bff`). A newline through `/input`, with the console stream held open for 180 s, draws
nothing. So the Fluxbox desktop in the screenshot is the picture the SNAPSHOT contained, not
something being drawn now.

Instruction retirement that constant, with no device activity of any kind, is a machine parked in
one place — a `wfi` spin is the obvious shape — and every symptom follows from interrupts not
being delivered after a snapshot restore: no timer tick, so no scheduler, so X never redraws; and
the virtio-input event has no IRQ to arrive on, which is why an accepted `/hid` never lands. Stated
as the likely mechanism, not a proven one: what is measured is that the guest executes and is
inert.

Two things this closes out. `/exec` cannot be the probe here — it caps its prompt wait at
`(timeout/2).min(10s)` while this UART polls once per ~230k ticks, about a byte a second at 0.5
MIPS — and this snapshot (`risc-perf-agent/warm960-palette.snap`) has no getty on ttyS0 at all.
And the restore is not cheap: 663 s, during which the app answers no HTTP, so "restoring" and
"wedged" look identical from outside.

## Two traps that cost hours, and the wall we are on now

CORRECTION: `GET /status` does NOT kill the tenant. The "trap in `status_json`" read as a panic was
`status -4` - how `ee_rt_run` reports an app interrupted by the STOP EPOCH - and it landed ~830 s
into the enclave, exactly when the expired leases made the node stop its apps. The backtrace only
shows where risc-box was (serving a poll) when the stop arrived; a Rust panic would have printed
`panicked at`, and none did. The later "trap" in `clock_nanosleep` is the same thing. Polling
`/status` is safe; a `status -4` backtrace means "stopped", not "crashed".

`/status`'s `instret` IS NOT INSTRUCTIONS RETIRED. It is the dispatched step budget - every turn
adds its whole batch, and `cpu::run` consumes a burst in WFI without executing - so a parked guest
reports 0.95G and 0.6 MIPS while getting nowhere. Fixed upstream (enclave-apps 56e8f61): a real
retired counter, `guestIdle` beside it, the budget kept as `steps`. Not deployed here; that needs
an owner publish.

BLOCKED, and not on anything technical: **the box's operator wallet is out of Base ETH**
(`0x389C3f030a209D04D026228D2D053fEB75DbadcA`, measured 2.4e-7 ETH). Every lease renewal and
re-claim is a transaction, so `e64f7cba`, `a77d0c57`, `a69dcbba` and `7ae476a3` all expired at
once - `renew` reverts "lease expired", the node cannot pay to re-claim, and it loops
`taking` -> `stopped`. Only `d9798e4c` still holds a lease. Nothing further can be verified on the
guest until that wallet is funded.

## The terminal: four layers, measured on the live instance

`e64f7cba`'s web terminal is the SERIAL path: xterm.js -> `POST /input` per keystroke (HTTPS
through the relay) -> the app's UART -> the guest's `ttyS0` root shell -> echo back over the
`/console` stream. (The desktop keyboard is a different path: `/hid` -> virtio-input -> X.)
Measured on a copy-on-write fork of the running machine, public hostname vs loopback:

| | public | loopback |
|---|---|---|
| `POST /input` returns | 0.8 s warm, ~2 s cold (TLS) | 0.5-0.75 s |
| key-to-echo | 2.8-3.4 s | 1.4-2.1 s |
| Enter -> next prompt, no-op command | 3.2-3.3 s | 3.0-3.4 s |
| sustained typing (passive, restoreExec) | 878 ms/char (two machines busy) | |

1. **The relay** adds little once warm (+50-100 ms); a cold POST pays a TLS handshake (~1.2 s).
2. **The app's loop turn** is the biggest single-key term: HTTP is served only between emulator
   batches, and a batch was a fixed 400,000 instructions - "the ~6 ms a batch takes" on the host it
   was tuned for, ~800 ms at the enclave's 0.5 MIPS. FIX (enclave-apps b07bdb2): turns sized by TIME
   (40 ms target, capped at the old batch, so a fast host is unchanged).
3. **The UART** took a typed byte only every 230,400 instructions (upstream "arbitrary... Fix me"),
   ~0.46 s/char at 0.5 MIPS: it dominates anything longer than one key. FIX (d6d11b9): 1,024;
   A/B on the same snapshot and command 14M -> 6M instructions typed-to-result.
4. **The page** fired an un-awaited POST per key, so keys raced each other: against a jittery link
   the deployed page delivered 20/20 fast-typed lines SCRAMBLED ("uname -a" -> "amuen a-"). FIX
   (e966242): one request in flight, in order, coalescing the rest (31 keys -> 5 requests).

Beneath all four, the interpreter: 1.5 MIPS stock Pulley on this CPU, 0.9 with the enclave's memory
setup (no guard pages -> explicit bounds checks), 0.5-0.6 in production.

**Deployed how:** the fixes are in the app, and the app's catalog entry and the deployment both
belong to the governance hardware wallet (publisher and owner 0x0b2d...eE61), so their permanent form
is two signatures on that device: `publishVersion` (risc-box 0.6.55) then `setAppRef` on e64f7cba.
Until then `ENCLAVE_APP_ARTIFACT_PATCH` (host.mjs 0e5983d7) runs the fixed build, pinned by sha256,
logged on every apply and recorded on the deployment as `artifactOverride`. REMOVE IT once the
signed version is live.

**The build is plain wasm64 + `aot`, not the deployed wasm64 + SET.** The 0.6.54 artifact's recipe
was never committed, and it cannot be rebuilt from what is: the SET wasi-libc patch's C side is
wasm64-aware (32-bit spawn args, a "low start_args pool") but the patch has no wasm64 thread-entry
assembly (`wasi_set_thread_start.s` is i32-only and fails to assemble for wasm64) and no
`__enclave_set_low_args_alloc`, which its own comments cite. It makes no difference on this box:
the enclave runtime has no SET `thread.spawn` yet, so the deployed build's `pthread_create` already
fails ("no display worker") exactly as a non-SET build's `worker()` returns false. It also drops
the 22 GiB up-front shared-memory reservation that locked risc-box out of a long-lived enclave.


## VTL1 refuses executable pages: measured, not assumed

Everything above rests on "there is no JIT in the enclave". That was inferred from the design
(`/INTEGRITYCHECK`, page-hash signing, an image hashed by `InitializeEnclave`) rather than tested,
and it decides something larger than risc-box: whether COMPILED wasm could ever be loaded into a
running enclave the way Pulley bytecode is today. It is now tested.
`windows/vbs/enclave/vxprobe.c` asks the secure kernel for one page at each protection, from
inside a signed, initialized enclave, and records the answer. It writes no instructions and calls
nothing it allocates - the refusal is the entire result.

```
  alloc then  result   err
  RW    -     ALLOWED  0       control
  R     -     ALLOWED  0       control
  RWX   -     REFUSED  1655
  RX    -     REFUSED  1655
  X     -     REFUSED  1655
  RW    RX    REFUSED  1655    the JIT pattern
  RW    RWX   REFUSED  1655
  RW    R     ALLOWED  0       control: reprotection ITSELF works
```

1655 is `ERROR_DYNAMIC_CODE_BLOCKED`, "the operation was blocked as the process prohibits dynamic
code generation". The last row is what makes it conclusive: `VirtualProtect` is not stubbed out in
VTL1 - it moves RW to R happily. It is the EXECUTE bit alone that the secure kernel refuses, at
allocation and at reprotection alike.

The rest of the surface agrees by omission:

- the entire host-side API is eight functions (`enclaveapi.h`), and the only one taking a page
  protection, `LoadEnclaveData`, is documented "loads data into an UNINITIALIZED enclave" and
  "only supported [for] enclaves that have the `ENCLAVE_TYPE_SGX` and `ENCLAVE_TYPE_SGX2` enclave
  types" - both pre-init only AND unavailable to VBS.
- the enclave-side API (`winenclaveapi.h`) is ten functions: attestation, sealing, trustlet
  encryption, enclave information, and the two memory accessors. Nothing allocates, accepts or
  commits a page. SGX2's EDMM requires the enclave to ACCEPT a page it was handed; VBS exposes no
  equivalent.
- `vertdll.dll` DOES export `VirtualAlloc`/`VirtualProtect`/`VirtualFree`/`VirtualQuery`, which is
  exactly why this had to be measured rather than argued from the export list.

**What it settles.** Native code runs in VTL1 only if it was part of the image that
`InitializeEnclave` measured. A compiled app therefore cannot be loaded at runtime into a running
enclave the way a cwasm is today: it would have to be linked into a signed enclave DLL and present
before initialization, which costs the dynamic, unsigned, architecture-portable app loading that
`ee_rt_open` gives us now (8 slots, bytecode in as data, nothing re-measured). Pulley is not a
workaround for a missing feature - it is the only shape that fits, and the interpreter's penalty
over a JIT is structural, not a tuning problem.

**What it does NOT settle.** The gap between stock Pulley (1.5 MIPS here) and production
(0.4-0.6) is ours, not the secure kernel's, and that IS a tuning problem.

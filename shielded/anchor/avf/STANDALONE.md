# The Enclave app hosts on its own (no computer)

Status: in progress (2026-10-12). Steven: make the Android host app host by itself before enclave.host/host offers it
for download beside Windows and Linux.

Today (PVM-CPU.md "Serving buyers") the phone runs the VMs and the owner's computer runs everything else over adb: the
host agent (`runner/host-agent.mjs`: registration, sweep, claims, proofs, certificates, secrets, egress, the SNI router,
the attach co-signer) and the Enclave network (`network/privacy-agent.mjs` pvm mode + one `enclave-wg` per circuit).
Standalone moves all of it onto the phone, unchanged where possible.

## Shape

| piece | where it runs on the phone | how |
|---|---|---|
| Node 22 (android-arm64, built from the official source with the NDK) | `nativeLibraryDir/libnode.so`, executed as a program | Android allows exec only from the APK's extracted native libs: `extractNativeLibs=true` |
| `enclave-wg` (GOOS=android GOARCH=arm64, unchanged source) | `nativeLibraryDir/libenclavewg.so` | same; userspace netstack, no VPN interface, no root (measured running on the Pixel 10 2026-10-12) |
| host agent + privacy agent | one esbuild bundle (assets), run by Node in the app's `:agent` process | `AgentService` (foreground, its own process: stopping the host VM, which is the main process, must not stop the agent) |
| `pvm-device` | `runner/pvm-device-local.mjs`: same interface as `pvm-device.mjs` | files are the app's own; launch/stop/alive go to `AgentService`'s control endpoint |
| ports 18187/18188/18189, 17786+ | plain loopback | no adb forward/reverse |
| IPFS fetch (was `python3 fetch-cid.py`) | JS CAR verifier | Node only |

Loopback on a phone is shared by every app on it, not "the owner's machine": every agent-side listener takes a
per-boot token (the attach co-signer keeps its rad/instance/nonce checks; the egress port already takes a token).

## Owner setup (once, in the app)

1. **The VM permission.** `MANAGE_VIRTUAL_MACHINE` is `signature|development|preinstalled` (read on the Pixel 10,
   Android 17): an installed app gets it only by `pm grant`. The app grants it to itself over the phone's own Wireless
   debugging (pair with the code Android shows; the same mechanism LADB and Shizuku use), and in the same session
   lifts the phantom-process cap (`max_phantom_processes`) so Node and the circuits are not killed. No computer.
2. **Battery.** Exempt from battery optimization (lets the agent start VM services from the background, and survive Doze).
3. **Keys.** The operator key is generated on the phone (app-private files). The host's name is derived from it.
4. **Payout and price.** Payout address (already in Settings); price defaults to the market default.
5. **Gas.** The operator pays its own Base gas (registration, heartbeats, claims, proofs). The app shows its address
   and balance. The registration sponsor (EnclaveHostPaymaster) keys on a TPM's EK certificate; a phone has no
   Sybil-resistant hardware id the relay can read today (the AVF chain gives a per-instance id, renewed on reinstall),
   so a sponsored first registration for phones is a later step.

## Relay

A stranger's phone running the pinned release build is admitted with no allowlist (tunnel.js AVF attach, pvm-market):
its own operator key, its own registered name, its own attach signature. Each release changes the APK's code hash
(the v4 Merkle root covers the whole APK), so each release re-pins `PVM_CPU_CODE_HASHES` on nan.

## Phases

1. Node for Android: build, run on the Pixel as the app's uid from nativeLibraryDir.
2. `pvm-device-local.mjs` + `AgentService` (control endpoint, alive files, boot start); agent config from the app.
3. JS CID fetch; one bundle; APK packaging (native programs, assets); tokens on loopback listeners.
4. Onboarding screens: self-pairing + grant, battery, key, gas.
5. Steven's phone switches to the standalone build (same package: keeps its instances and registration); the
   computer's units stop.
6. Publish the pinned APK at a fixed URL; the Host page offers it beside Windows and Linux.

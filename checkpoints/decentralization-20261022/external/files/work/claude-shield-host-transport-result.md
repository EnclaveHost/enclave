# Windows Shield host transport for direct custody + F3 image selection: result (claude worker, 2026-10-19)

Repo: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`. Source only.
- No commits, SSH, VM, chain, wallet, Wine, GUI, production or activation.
- Nothing was registered, and the coordinator's candidate image (c7084346…) is not pinned anywhere in source.

Interfaces:
- `work/shield-host-transport-interface.txt` (transport);
- `work/shield-image-selection-interface.txt`, section "F3 FINAL" (image selection, with the coordinator decisions applied).

## Evidence class: FIXTURE ONLY. No hardware evidence exists for any of this.

**What is real in the tests:**
- the WmiHyperVLauncher, driven by injected PowerShell answers;
- the Manager and its HTTP server;
- the custody transport and its pinned-bridge lifecycle;
- the node pump and custodyAuthorization (with a real secp256k1 *test* key, all 0x7f);
- shield-startup materialize over the existing fake quorum RPC.

**What stands in:**
- `shielded-bridge.exe` is `windows/vbslike/manager/testdata/fake-custody-bridge.py`, a loopback relay. It reads the peer
  partition from a `VM <guid>` line where the real bridge reads the hv_sock peer VmId.
- The guest is a socket writing the Go guest's exact line.
- The fake Hyper-V answers each image's hash by its path.

**Never exercised:**
- hv_sock 9445/9446 on Hyper-V, or the GuestCommunicationServices registration;
- a real Shield-direct IGVM boot, or a real VBS report;
- a real custodian release, or a TPM session at a custodian;
- `verifyImage` against real files on Windows.

## 1. Interruption and cleanup (this turn)

**The interruption.** The earlier session ended during the custody mutation run.
- Mutation m6 ("replay allowed") had been killed: its lifecycle test failed.
- That failing test left two fixture bridges running, so the node test process could not exit. It hung until the runner's
  150 s timeout.
- The orphans were my own: mutate.py, runmon, the node test runner, and two `fake-custody-bridge.mjs` children of
  /tmp/custody-mut-TtsM. I killed them, restored the mutated scratch `server.mjs` from source, and verified that no
  fixture process remained.

**Shared /tmp tooling.** `/tmp/mutate.py` had since been overwritten by another worker's Rust mutation script. I did not
touch it. My tooling now lives under unique names:
- `/tmp/claude-shield-runmon.sh`
- `/tmp/claude-shield-mutate.py`
- `/tmp/claude-shield-mutate-f3.py`

**Test hygiene fixes:**
- The fixture bridge is now Python. A node child was about 51 MB; this keeps the transport job at or under about 228 MB.
- Every fixture child is tracked: killed per test (`t.after(reap())`) and again in `after`.
- Refusal assertions are time-bounded (`within`), so a regression fails in about 1 s instead of hanging.
- The restart test's child "manager" is killed in `t.after`.
- The /proc scan for the bridge pid is gone; the test uses the tracked child.

**Probing.** I did not import test modules to find missing scratch dependencies. An earlier import probe had actually run
tests, so the scratch was built by copying the modules each failed run named.

## 2. Direct custody transport (completed, validated)

Files:
- `windows/vbslike/manager/custody-transport.mjs` (new);
- `server.mjs`, `wmi-launcher.mjs` and `main.mjs` (hooks);
- `windows/node/shield-custody.mjs` (new pump);
- `secrets.mjs` (`custodyAuthorization`);
- `shield-startup.mjs` and `shield-sessions.mjs` (custody machines and session targets);
- `agent.mjs` (wiring);
- `shield-secrets.mjs` (relay courier skips direct domains).

Behaviour is as in the transport interface:
- The bounded loopback channel takes one v2 line per connection and lists only this partition's deployment and vault.
- An authenticated, single-use HMAC callback carries the node's answer.
- The node re-verifies startup and lease (fresh quorum, `needLease`) and refreshes the custodians' sessions before
  signing.
- `record.id === startup.deployment` exactly, with no fallback.
- Any failure closes the channel; a bridge exit fails the domain.

**Mutation testing (isolated scratch copy, every file restored): 25 killed, 2 equivalent, of 27.**
- **m1 and m26 were re-run** after the refusal and timeout waits were bounded. They are now killed cleanly (assertion,
  not timeout).
- **m5 replaced.** The original "accept v1" mutant was equivalent: a v1 line has 3 fields and still fails the length
  check. m5 is now "newline not required", and it is killed.
- **m21 and m22 survived; both are equivalent.**
  - m21: a `hasSecrets:true` plan always derives V6/V7.
  - m22: the earlier custodyV2 refusal fires first.

## 3. F3: separate pinned legacy / Shield-direct images (implemented)

**Coordinator decisions applied:**
- no grace and no relabelling;
- distinct explicit direct path, hash and runtime identity;
- no silent downgrade;
- legacy-public only as explicit operation, with `guestAuthority=false`;
- names, custody and independent mode require direct;
- equal RuntimeIDs are legal, so the node pins the direct IGVM sha256 as well.

**Manager:**
- **`main.mjs`.** `ENCLAVE_SHIELD_DIRECT=1` requires all of:
  - `ENCLAVE_SHIELD_DIRECT_IGVM`, `_IGVM_SHA256` and `_RUNTIME_IDENTITY`;
  - egress;
  - the legacy image.
  The direct path and hash must differ from the legacy ones. Anything else exits 2.
  `ENCLAVE_SHIELD_CUSTODY_IMAGE_SHA256` must equal the direct hash, never the legacy one.
  There are three role-pinned launchers (legacy, shield-direct, gpu). Only the direct one has the package and custody
  hooks. With neither extra image configured, the legacy launcher alone runs, exactly as before.
- **`shield-profile.mjs` `ImageLauncher`.** A package goes to direct, inference to gpu, everything else to legacy. A
  missing image only refuses; it never falls back. The direct image's preflight is merged in, prefixed.
- **`wmi-launcher.mjs`:**
  - `imageRole`; the direct image refuses a spawn without a package, and a non-direct image refuses packages and custody,
    both before any PowerShell;
  - only the direct image may hold the package and custody hooks;
  - the role is stated in the handle and in Notes. Legacy Notes are byte-identical, and absent means legacy.
- **`server.mjs`:**
  - `images` option; the direct pins are required for `directBootstrap` and must be distinct from the legacy image;
  - role = package ? shield-direct : inference ? gpu : legacy, and the RuntimeID is checked per role;
  - after start, the launcher's `imageRole` and IGVM hash must match the role, or the domain fails and its channels close
    (the VM is left for DELETE);
  - readiness `expectRuntime` follows the role, and `recover()` reads the role from Notes;
  - `/health.images` is added; the top-level runtime is unchanged.

**Node:**
- **`shield-startup.mjs`:**
  - `startupImages(env)` reads `ENCLAVE_ISOLATION_DIRECT_RUNTIME_ID` + `ENCLAVE_ISOLATION_DIRECT_IMAGE_SHA256` (both or
    neither) and `ENCLAVE_STARTUP_LEGACY_PUBLIC=1`. The latter is exclusive with the direct pins and refused in
    independent mode.
  - `materialize` routes DIRECT only if the manager's stated `images.shieldDirect` matches **both** of this node's pins.
    Otherwise it refuses by name: `manager`, `package.runtimeId`, `names`, `secretsMode` or `guestBootstrap`.
  - LEGACY-PUBLIC carries no package, and its startup has `guestAuthority:false` and `imageRole:"legacy"`.
  - Adoption requires the role, the package hash and `view.igvmSha256 === this node's pin`. A legacy-public startup is
    never adopted onto the direct image.
- **`host.mjs`:** one narrow hook, passing `startupImages(process.env)` into `createShieldStartup`.
- **`isolation-client.mjs`:** the view exposes `imageRole` (default legacy) and `igvmSha256`.
- **`secrets.mjs` `custodyAuthorization`:** also requires the asking partition to be on the pinned direct image.

**Preserved on the correct image:**
- the witness, public, relay-secret V6/V7 and GPU spawns (no `bootstrap`) stay on legacy or gpu, with unchanged bodies,
  egress and RuntimeID pin;
- relay-sealed secrets still skip direct domains;
- the manager's existing suites pass unchanged.

**F3 mutation testing (scratch copy): 25 of 25 killed.** f9 (the non-direct role contract) first survived. I added a
contract-break test, and it is now killed.

## 4. Focused test results (working tree, serial, `--test-concurrency=1`)

Peak RSS is the whole process tree.

| file | pass/fail | peak RSS |
|---|---|---|
| test/windows-shield-custody-transport.test.mjs | 10/0 | 228 MB |
| test/windows-shield-image-selection.test.mjs (new) | 12/0 | 199 MB |
| test/windows-shield-startup.test.mjs | 15/0 | 189 MB |
| test/windows-shield-package-transport.test.mjs | 5/0 | 12 MB |
| manager server / wmi-launcher / restart / liveness / regressions / shield-profile | 46 / 64 / 11 / 4 / 23 / 5, all 0 fail | ≤ 134 MB |
| manager main.test.mjs | 13/0 (see note) | 190 MB |
| windows-isolation-manager-restart, isolation-client, node isolation-host / reboot-recovery / vanished-domain / version-change / node-secrets | 5 / 27 / 15 / 5 / 4 / 2 / 8, all 0 fail | ≤ 179 MB |

**Notes:**
- **`main.test.mjs`.** In the batch run, my wrapper captured no counts for this file. Re-run alone: 13/13.
- **Memory.** The RAM floor held throughout: 16.9–18 GiB available.
- **Over-budget runs.**
  - In the earlier transport session, `test/shield-dns-challenge.test.mjs` (pre-existing, not mine) peaked at 276 MB. I did
    not run it again.
  - Some custody-transport mutant runs peaked at 258–261 MB before per-test reaping existed; after it, ≤ 229 MB.

**Test changes forced by the coordinator's decisions:**
- **Tests now configure the new pins.** The startup, package-transport and custody tests got pins and fixture launchers
  for the direct image, so the earlier tests run on it.
- **Two old expectations were inverted, deliberately.** I changed these test assertions; please confirm:
  - a direct node now refuses a manager with no direct image (input `manager`), instead of starting the package there;
  - custody on a manager whose image is not Shield-direct is now refused as `manager`, not `secretsMode`.

## 5. Open items and limits (for the coordinator)

**Integration:**
- **Untracked files.** These are not ignored and must be added at integration:
  - `custody-transport.mjs`, `testdata/fake-custody-bridge.py`;
  - `shield-custody.mjs`, `shield-startup.mjs`, `shield-sessions.mjs`;
  - the two new test files.
  `shield-startup.mjs` and `shield-sessions.mjs` are imported by tracked code.
- **Shared files.** `host.mjs`, `agent.mjs`, `secrets.mjs` and `shield-startup.mjs` also carry other workers' uncommitted
  edits. Mine are additive and narrow.

**Not done:**
- **No startup image verification.** I deliberately did not add a `verifyImage()` of the direct image at manager start.
  Every `start()` already hashes the pinned IGVM before defining a VM, and a startup check would stop a manager that has
  no PowerShell (Linux tests). Say if you want it at boot.
- **No docs.** `docs/network/independent-shield-image.md` was not edited.

**Explicit activation still needed on hardware:**
- register the 9446 and 9445 services under GuestCommunicationServices;
- set the direct pins on the manager and the node;
- set `ENCLAVE_SHIELD_CUSTODY_V2=1`;
- provision the callback key file.
Preflight reports the registrations; nothing writes them.

**Hardware limits:** none of the following has been exercised or measured:
- the bridge's real VmId check on 9445/9446;
- Hyper-V behaviour when a guest dials an unregistered service;
- a real IGVM's measured RuntimeID matching its runtime.json;
- custodians accepting the node's TPM session and the guest's VBS report;
- the guest's 2-minute custody window under real egress latency.

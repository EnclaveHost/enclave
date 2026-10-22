# Shield Windows final closure: gate fix, commit inventory, hardware canary plan

**Repository:** `wo/work/enclave`, HEAD `2eabb9e3`.

**Constraints kept:** nothing staged or committed (the index is empty); no production, wallet, chain or real-key use; no
Wine or GUI.

**One incident:** I made a brief, unauthorized host change while validating scripts. It was reverted and verified within
a minute (section 4).

## 1. Bridge credential gate fix (`windows/vbslike/manager/bridge-auth.mjs`)

**What changed:**
- **Whole-line decisions only.** The gate makes its decision only on a complete 88-byte credential line, with one
  constant-time comparison. Until the line is complete, every connection is treated identically, whatever it has sent.
- **Endings are uniform:**
  - a full line that doesn't match is rejected;
  - EOF before a full line, or the read deadline (2 s), closes the connection uniformly;
  - none of these consumes request budget, a pending slot or a package serve.
- **Eviction is content-blind:** when `maxUnauthenticated` connections are waiting, the oldest is evicted, regardless of
  what it has sent.
- **Unchanged:** the deadline, the concurrency and buffer bounds, the credential format and the Rust bridge.

**Tests** (`test/windows-shield-local-auth.test.mjs`, now 9; 3 consecutive serial runs, all passing):
- **Same treatment for partial lines.** Partial lines with correct and with incorrect content were each held until the
  deadline and closed alike, at 1, 8, 32, 63 and 87 bytes past the prefix, and neither spent any budget.
- **Full lines.** A full mismatching line is refused promptly, and the full correct line is admitted.
- **Flood.** A flood of partial-line connections cannot keep the bridge out.

**Isolated mutations** (in a copy; restored and deleted afterwards):
- restoring the old per-prefix comparison makes the new test fail;
- restoring the old content-dependent eviction makes the flood test fail.

**Regression:** custody transport 10/10, package transport 5/5.

**Native interop (minipc staging).** I re-ran it with the same real bridge binary (`8912ac7d…`):
- package: 30 hostile local connections spent nothing, and then the guest received its frame;
- custody: the same, then the guest's request was answered;
- no credential appeared in any output, and no bridge was left running.

## 2. Added for canary safety: VM name scope (Windows source, in the commit set)

**The problem it fixes.** Production VMs carry the manager's Notes marker, and the launcher's survey matches by name
prefix *or* that marker. So a second manager on this host would recover and sweep all 12 production VMs.

**The change:**
- `wmi-launcher.mjs`: `DEFAULT_VM_PREFIX`, `VM_PREFIX_RE`, and `survey(prefixOnly)`. With a non-default prefix, the
  survey matches by name prefix only.
- `main.mjs`: `ENCLAVE_VM_PREFIX`, validated first; a malformed value exits 2. It is passed to every launcher.
- Default (production) behaviour is unchanged.

**Tests:**
- New `test/windows-manager-vm-scope.test.mjs`, 3/3: the default survey keeps its Notes clause, and a canary-scoped
  manager's recovery sees only its own VM out of four mixed ones.
- Regressions:

| Suite | Pass |
| --- | --- |
| launcher | 64 |
| restart | 11 |
| liveness | 4 |
| main | 13 |
| server | 46 |
| restart-accept | 5 |
| multi-accept | 9 |
| isolation restart | 5 |
| image selection | 12 |
| custody transport | 10 |

All 0 fail.

**The remaining gap is the reverse direction:** the production manager still surveys by Notes marker. The canary plan
therefore pauses `\Enclave\Update` (which would restart the production manager) while a canary VM exists.

## 3. Windows commit closure (`work/windows-final-source-inventory.json`)

**Generation.** Produced by `work/claude-windows-inventory.gen.mjs`, which is read-only; re-run it from `work/enclave`
right before committing.

**The set: 48 files** (20 modified, 28 untracked), each with its status and sha256:
- **installer:** `EnclaveSetup.cs`, `install-host.ps1`, `update-host.ps1`;
- **node:** `agent`, `apptls`, `domains`, `host-onchain`, `host`, `isolation-client`, `keys`, `secrets`,
  `shield-secrets`, `host-ownership`, `shield-custody`, `shield-startup`;
- **datapath:** `node-bridge`;
- **manager:**
  - modified: `main`, `server`, `shield-profile`, `wmi-launcher`;
  - new: `bridge-auth`, `custody-key-file`, `custody-transport`, `package-transport`, and
    `testdata/fake-custody-bridge.py`;
- **native bridge:** `shielded-bridge.rs`, plus the new `bridge-auth-check.rs`;
- **relay:**
  - `shield-independent-verifier.mjs`, `shield-market-evidence.mjs`;
  - the reviewed `shield-marketplace.mjs` hunk, a 12-line extraction;
- **scripts:** `scripts/network/shield-verifier.mjs`, `scripts/publish-windows-host.sh`;
- **docs:** `docs/network/independent-windows.md`;
- **tests:**
  - `windows-host-identity`, `windows-installer-independence`, `windows-publish-host`;
  - `windows-shield-custody-transport`, `-image-selection`, `-local-auth`, `-package-transport`, `-startup`,
    `-verifier`;
  - `windows-manager-vm-scope`;
  - `test/windows-native/*` (5 files).

**Closure:**
- **JS imports.** Taken from esbuild over the manager, the node agent, `keys`, `host-onchain`, the relay verifier
  modules, the verifier script, every set test and the 17 manager tests. **No dirty dependency** lies outside the set.
- **Already committed:** `windows/node/shield-sessions.mjs` and `shield-verdict.mjs` (`ee8beb38`).
- **One non-JS dependency blocker:** `test/windows-native/run.ps1` loads `cli/host.ps1`, which is modified and owned by
  the supervisor/CLI/management worker (10514). Commit that first, or hold back `test/windows-native/`.
- **Excluded by ownership:**
  - DNS responder files, committed in `2eabb9e3`;
  - CLI, management and `registry-schema4` (10514);
  - site, sdk and vendor (83383);
  - README and site files.

**Set tests run this session, all passing:**

| Suite | Pass |
| --- | --- |
| host identity | 10 |
| installer independence | 9 |
| publish host | 3 |
| verifier | 6 |
| startup | 15 |
| image selection | 12 |
| local auth | 9 |
| VM scope | 3 |
| package transport | 5 |
| custody transport | 10 |

**Release coupling.** The rebuilt `shielded-bridge.exe` must ship with this manager: an old bridge rejects the new
argument, so it fails closed. Its pin in `build-bundle.ps1` must also be updated from a reproducible build at the
commit.

## 4. Hardware canary (`work/shield-hardware-canary/`)

**The plan.** `plan.json` has eight phases, numbered 0-7:
- **0, read-only baseline:** already done;
- **1, staging** from a bundle built at the committed source;
- **2, scoped manager, survey only:** proves the canary sees 0 of the 12 VMs on real Hyper-V;
- **3, registration** of 9445/9446 (the host has 9443 registered and lacks these two);
- **4, two direct partitions** on the staged c7084346 guest: real per-VmId package routing, a fresh VMGS per run, and
  real readiness reports;
- **5, custody transport** with the callback running as SYSTEM, using a scratch key and a throwaway signer;
- **6, restart and per-boot state;**
- **7, cleanup** with invariant checks.

**Safety rules in the plan:**
- Every state change requires `-Apply` **and** an approval line.
- Invariants run before and after each phase.
- The driver refuses the production port.

**Not proven by the plan:**
- A real custodian release: that needs the activated `ee8beb38` custodian and a registered operator.
- The bridge's cross-partition refusal: per-VmId routing makes it unreachable by construction.

**Inputs still needed** (not invented):
- the commit SHA;
- the built bundle;
- the direct guest's runtime identity;
- test deployments, which need owner chain writes;
- pins, RPCs and gateways.

**Scripts:**
- `lib.ps1`, `baseline.ps1`, `invariants.ps1`;
- `stage.ps1`, `gcs.ps1`, `update-pause.ps1`, `run-manager.ps1`, `cleanup.ps1`;
- `guard-selftest.ps1`, `installer-key-block.ps1` (verbatim from the installer);
- `canary.mjs`.

All of them parse on the host. Only the read-only ones, and the scratch-only self-test, have been run.

**Incident (2026-10-20 ~03:56Z).** While validating, I ran `gcs.ps1` and `update-pause.ps1` without `-Apply`, and they
**applied**:
- **What changed:** two GuestCommunicationServices entries (9445, 9446) were added, and `\Enclave\Update` was disabled.
- **Cause:** a PowerShell guard bug. The function returned an array, which the `-not` check treated as false.
- **Reverted within a minute, and verified:**
  - registrations back to the baseline five;
  - Update `Ready`, with no missed run;
  - the 12 production VMs unchanged;
  - no canary VM existed at the time.
- **Fix:** the guard now returns a strict boolean and writes nothing to the pipeline, and every caller checks
  `-ne $true`. `guard-selftest.ps1` passes 5/5 on the host, against scratch only.

**Host baseline** (`host-baseline-readonly.json`):
- 12 production VMs, all Running;
- the staged guest verified (77,056,796 bytes, sha256 `c7084346…`);
- installed release 2026.10.12.47, whose bridge is the old one.

**Minipc staging.** `C:\Users\claude\enclave-staging\claude-shield-local-auth` holds the built binaries, the sources and
the canary scripts, and no key files.

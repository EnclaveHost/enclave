# M4b handoff, 2026-09-24 (updated the same day, after the runtime-set increment)

## Current state - read this before the historical handoff below

Branch `isolation/portable-runtime-jit`. Nothing merged to main, no release, no production touched, no host
setting changed, nothing installed or activated, no reboot. The independent reviewer is still unavailable, so
**nothing after `39b5a5e4` is independently reviewed**, this update included.

This session worked under a scope the coordinator (Codex) set on 2026-09-24 after Steven pointed out that an
earlier documentation-only restriction was too broad: (1) measured runtime dependency coverage for the one-plane
app, (2) a read-only host change/recovery plan, (3) reconciling evidence and docs. The same scope excludes the
provider-rejected caller/VMPL `CREATE_VCPU` investigation, any two-plane campaign, and any host change.

| status | item | where |
|---|---|---|
| **accepted evidence, reviewed** | step 2, measured boot 15/15; handshake-key binding 8/8 - one app, one plane, each scoped by its own "does not establish" section | `evidence/step2-measured-boot-2026-09-24.txt`, `evidence/plane-handshake-binding-2026-09-24.txt` (review boundary `39b5a5e4`) |
| **new evidence, NOT reviewed** | the runtime SET admitted whole: interpreter + libc + libm + libgcc_s + wasmtime + runtime.json; good plane 10/10; a flipped libc byte and a missing libgcc_s each REFUSED `0x80001004` and powered off; running runtime maps only admitted code; local 14/14; SVSM unit tests 44/44 | `evidence/runtime-set-2026-09-24.txt`, run `~/enclave-bench/m4b-rtset-083233`; code `9d678395`, harness `f3825d92` |
| **new documentation, NOT reviewed** | the read-only host change/recovery plan; README and this file reconciled | `HOST-CHANGE-PLAN.md`, `svsm/README.md` |
| **new evidence, NOT reviewed** | the served component is cut from the ADMITTED bundle (sealed memfd, no `/app.wasm`): good 11/11, a planted decoy component never served, truncated and missing bundles refused | `evidence/app-binding-2026-09-24.txt`, run `~/enclave-bench/m4b-app-085652`; code `d094410c`, harness `14eb1104` |
| **new, NOT reviewed: the deployment path** | `../DEPLOYMENT-PATH.md` maps enclave.host's real deployment path; the vehicle is M4a (one SNP guest per app), which is NOT gated by the second-plane blocker. Built: **guestd** (host-side `/vms` manager over M4a guests, off unless `GUESTD_ENABLE=1`): 12 unit tests, hardware 7/7 (`evidence/guestd-2026-09-24.txt`, run `guestd-test-091307`); **image reproducibility fix** (`pack-initrd.sh`, found when guestd's first run FAILED G3/G4, preserved); **supervisor claim gate** off unless `ISOLATION_BACKEND` is set (`test/isolation-claim-gate.test.mjs` 9/9, supervisor suites 452/454 with 2 pre-existing skips) | commits `e280abf3`, `61578689`, `5e1de672`, `69a4fe9b` |
| **new, NOT reviewed: C2 and C6 (verifier half)** | catalog-to-bundle derivation `enclave-catalog-bundle/1` (`contract/catalog`, independent Python reference); guestd `/prefetch` + an immutable, digest-verified mapping store over the platform's own CAR verifier; a pinned domain release from which `expected-measurement.sh` reproduced BOTH live measurements of the guestd hardware run. A regression was found and fixed: catalog code in the contract package moved every measurement via the front (`ba445c72`) | `evidence/catalog-and-release-2026-09-24.txt`; commits `e4bab5b9`, `304e0eb7`, `ba445c72`, `af33b25c` |
| **new, NOT reviewed: verifier hardening and C7** | `expected-measurement.sh` accepts only with an explicit pin (inspection is a separate, labelled mode), snapshots the release and bundle once, and emits the runtime identity from the snapshot; `release-manifest.py` parses strictly. `guestd-control/1` authenticates the supervisor-to-guestd channel (pairing key, instance-bound mutual handshake, MAC'd and replay-proof requests, signed answers, expiry). The per-version fixed policy is recorded as the branch design assumption in `contract/catalog/DERIVE.md` | `evidence/control-and-verifier-2026-09-24.txt` (clean tree `0cef0cab`); commits `fcd2d940`, `cbf239fa`, `2e5c965b` |
| **new, NOT reviewed: client hardening and the supervisor transport** | the reported concurrent-handshake race in `control-client.mjs` (availability, not auth bypass) is fixed: single-flight handshake, an immutable session per request, bounded time and bytes, no blind resend of a mutating call on an unsigned 401. The regression test still FAILS against the preserved a40f1019 client. With `ISOLATION_BACKEND` set (default off), the supervisor's `vmReq` reaches guestd ONLY over `guestd-control/1`, fails closed without a private key, and reconciles a launch by name | `evidence/control-client-and-transport-2026-09-24.txt` (clean tree `93a54bab`); commits `ddd02589`, `95d21529` |
| **unresolved limitations** | ONE app on ONE plane; the maps check is one reading at load and is the plane's word; the step-2 fixture now stages the set but was NOT re-run on hardware; second-plane preconditions 2, 3 and 5 not started | `evidence/runtime-set-2026-09-24.txt` limits; `svsm/README.md` |
| **provider-blocked** | the precondition-4 mechanism: what the SVSM's `core_create_vcpu` checks about the calling plane, and so whether the README's "the SVSM is not in that path" holds for our topology. Not continued, delegated or retried | "Unfinished investigation" below |
| **needs Steven's decision** | whether the precondition-4 remedy needs a host change at all, and if so the window; the installer must first be parameterised or it would replace (or, on failure, delete) today's planes kernel; a second-plane campaign | `HOST-CHANGE-PLAN.md` |
| **blocker, unchanged** | no run is scored as isolation until precondition 4 is resolved AND a second plane is tested for the property | `svsm/README.md` precondition 4 |

A fact worth knowing before reading any failed run: warden-host runs the planes kernel from the **non-default**
GRUB entry, so any reboot (an unclean one included) comes back on the distro kernel without KVM planes, and every
M3b/M4b run then fails with `KVM plane 2 is not supported`. Select the planes entry at the GRUB menu.

Pending, in the order worth doing:
1. an independent review of `9d678395`, `f3825d92` and this documentation, when a reviewer is available;
2. ~~the same fix for the component~~ done: `evidence/app-binding-2026-09-24.txt`;
3. re-running `verify-measured-boot.sh` against the current admission fixture, if the step-2 record should cover
   it rather than stay scoped to the ELF-only fixture;
4. precondition 3 (the per-plane validated-page map), which is SVSM-local and was not part of this scope;
5. the deployment path's C2 and C4-C8 (`../DEPLOYMENT-PATH.md`); C2 needs a decision (bundles in the catalog, or
   derived), C7 needs an authenticated CVM-to-host channel, and C8 is the staging acceptance run.

---

# Historical handoff (2026-09-24, before the update above)

Written for the next agent session picking up this work. Branch `isolation/portable-runtime-jit` at `3b082cc7`,
working tree clean, everything pushed. Nothing merged to main; no production touched.

## Read these first, in this order

1. `m4/svsm/README.md` — the authority, both closed steps, the five second-plane preconditions and their sizes.
2. `m4/evidence/step2-measured-boot-2026-09-24.txt` — the measured-artifact binding, 15/15.
3. `m4/evidence/plane-handshake-binding-2026-09-24.txt` — the handshake-key binding, 8/8.

Both evidence files end with a "what this does not establish" section. Those sections are load-bearing: they are
the scope the results were accepted at, and they must not be widened without new runs.

## Standing constraints (prior coordinator direction under Steven's standing scope)

- **Do not reboot, install or activate anything, or change production.** The host kernel prerequisite is his
  decision and has not been approved. Preparing a plan for it is authorized; acting on it is not.
- **The independent reviewer (enclave-59) currently has a provider safety rejection.** Do not route around that
  rejection, do not keep sending it review requests, and **do not describe any new increment as independently
  reviewed** until review is actually available again. Everything up to and including `39b5a5e4` was reviewed;
  nothing after it is.
- **Preserve the second-plane blocker.** Do not score any run as isolation, and do not use the lead in
  "Unfinished investigation" below to dissolve the blocker unilaterally.
- Existing accepted one-plane evidence stays scoped exactly as recorded.
- Commit and push tested increments to this branch. Do not alter permission settings.

## What is closed (one app, one plane)

**Step 2 — the launch measurement covers the executing artifacts.** 15/15 on hardware, DEBUG and RELEASE AmdSev
firmware. The firmware verifies kernel, initrd and cmdline; a substituted initrd is refused; the SVSM neither
zeroes nor withholds the hash page; the report's MEASUREMENT equals `igvmmeasure` of the launched file and the
AMD chain verifies at VMPL 2.

**The monitor integration — the handshake key is the key the SVSM binds.** 8/8. The front registers its
`domtls`-minted SPKI once and then sends only a nonce; the SVSM computes both halves of `report_data`. Verdict
attested, gate open, one real app request served. Four verifier-side negatives reject.

Reproduce either with:

    m4/verify-measured-boot.sh <good.cpio.gz> <other.cpio.gz>   # RELEASE_FW= adds cases 6/7
    m4/verify-plane.sh <app.bundle>                             # builds, boots, verifies, saves transcripts
    m4/write-step2-evidence.sh <workdir>  /  m4/write-plane-evidence.sh <workdir>

Latest runs: `~/enclave-bench/m4b-plane-025811`, `~/enclave-bench/m4b-step2-021717`.

## The four tasks, as prior coordinator direction stated them (not verbatim from Steven)

1. **Continue the per-plane page-ownership validation** — precondition 3: a per-plane validated-page map recorded
   in `core_pvalidate_one`, keyed by the calling plane. There is no RMPQUERY in COCONUT, so this map is the
   practical ownership oracle. `core_pvalidate_one` is already the choke point and already takes
   `PVALIDATE_LOCK`. Not started.
2. **Complete measured runtime dependency coverage** — today only the `wasmtime` ELF is admitted. Its ELF
   interpreter (`ld-linux-x86-64.so.2`) and its shared libraries are copied into `/rt` and executed but never
   admitted, so the executing bytes include unadmitted code. Both evidence files say so. This means extending
   admission to those files (a third artifact kind, or a digest over the set), updating
   `ENCLAVE_RUNTIME_SHA256`'s meaning, and re-running. **Done 2026-09-24 as a digest over the set** - see the
   current-state section at the top.
3. **Preserve the second-plane blocker.** Nothing to build; a constraint on wording and scoring.
4. **Prepare a read-only change/recovery plan for the host kernel prerequisite** — exact host and patch,
   build/config and current boot identity, workloads affected, validation, rollback and recovery. Write it;
   do not install, activate or reboot. **Written 2026-09-24: `HOST-CHANGE-PLAN.md`**, without a patch, because
   none is established.

## The blocker, and why it gates the label

Precondition 4 is the AP_CREATE restriction. As recorded in `m4/svsm/README.md`, the planes kernel's
`sev_snp_ap_creation` checks only `vmpl < VMPL_MAX` and that VMPL0 is replaced only by a VMPL0 vCPU. Until that
is addressed, a second plane built on preconditions 1, 2, 3 and 5 would run and would **not** be isolated, and
the cross-plane negatives would all pass while the property was false — because the breach is a VMSA creation
that never touches protocol 6. That is why no run may be scored as isolation first.

Sizes, measured in the kit tree rather than estimated (details in the README):

- **1** is already satisfied in code (`copy_with_no_vmpck` clears `0..VMPL_MAX`) and evidenced across all four
  VMPCKs, each refused with the kernel's own `Empty VMPCK<n> communication key`.
- **3** is SVSM-local at an existing choke point.
- **2 and 5** are a rewrite of COCONUT's guest-entry path, not a patch: `enter_guest` calls
  `switch_to_vmpl(GUEST_VMPL)` once and a CPU holds exactly one `guest_vmsa: SpinLock<GuestVmsaRef>`, so
  deriving the caller's VMPL first requires there to be more than one VMSA to exit from. ~26 call sites, plus a
  plane-selection policy that does not exist, per-plane CAA request flags, and 85 `GUEST_VMPL` references.
- **4** is Steven's.

## Unfinished investigation — a lead, not a finding

While sizing precondition 4 I started checking its stated mechanism and did not finish. Treat all of this as
unverified and do **not** act on it to change the blocker's status.

What I did establish from source: in `arch/x86/coco/sev/core.c:475`, `snp_set_vmsa` branches on `snp_vmpl`.
When the guest is **not** at VMPL0 — which is our plane at VMPL 2 — it does not use RMPADJUST at all; it issues
the SVSM's `SVSM_CORE_CREATE_VCPU` (protocol 0, call 2). RMPADJUST is used only in the `else` branch, for a
VMPL0 guest. So for a non-VMPL0 plane the SVSM does appear in that path, which is in tension with the README's
sentence "the SVSM is not in that path".

What I did **not** establish: what `core_create_vcpu` (`kernel/src/protocols/core.rs:111`) validates about the
**calling** plane, and whether it constrains the VMPL the new VMSA targets. I read as far as its alignment,
overlap, `valid_phys_region`, APIC-id lookup, `PERCPU_VMSAS.register`, guest-access revocation and `check_vmsa`
checks. Whether any of that ties the request to the caller's own plane is the open question, and it is precisely
what precondition 4 turns on.

So the honest position is: the mechanism in the README may be stated wrongly for a non-VMPL0 guest, and the
precondition may be narrower or wider than written. Finish reading `core_create_vcpu` and `PERCPU_VMSAS.register`
before touching the README, and remember that a kernel at VMPL0 in a *different* topology still has the
RMPADJUST path. Do not relax the blocker on a partial read — that is the exact failure pattern this lane has
repeatedly produced.

## Traps this lane has already paid for

Every one of these cost a debugging session or produced a false result.

- **A green line that covers nothing.** Four instances here: a hash-table check comparing digests and not the
  table; a launch check grepping a line printed whether or not QEMU started; an app-id comparison skipped by a
  `len > 2` guard that still reported OK; and a VMPCK probe covering two of four keys under a sentence claiming
  all four. Ask what a check would still pass if the mechanism were entirely absent, and make that the test.
- **The SEV hash table fails OPEN.** A malformed table, a non-verifying firmware, or a table at the wrong offset
  all boot normally and verify nothing. See `memory/sev-hash-table-fail-open.md`. Compare the whole 4096-byte
  page against `construct_page(offset)`; never the digests.
- **`ENODEV` is not evidence.** `sev-guest` returns it whenever nothing binds. The reason is only in
  `/dev/kmsg`. When reading kmsg per probe, take the **last** match — reopening reads from the oldest record.
- **The distro QEMU has no `igvm-cfg` object.** Use
  `~/.cache/enclave-isolation/planeskit/qemu/build/qemu-system-x86_64`. `run-domain.sh` swallows the failure and
  the run looks like a firmware refusal.
- **`run-domain.sh start`'s positional args are `<image> <snp|plain> <tag> <workdir> [vcpus] [memMiB]`.** Passing
  memory in the vcpus slot silently launches with thousands of vCPUs.
- **Never edit a shell script while a run is executing it.** `sh` reads incrementally; the running shell resumes
  at a shifted byte offset and dies mid-scoring. Copy the script to `m4/.frozen-*.sh` (inside `m4/`, so its
  relative paths still resolve) and run the copy.
- **`admit` takes the artifact KIND, not a flag.** Writing `"1"` admits kind 1. A failed sysfs write leaves
  `result` showing the *previous* call's outcome.
- **`.ko.zst` modules need `MODULE_INIT_COMPRESSED_FILE`** (flag 4) or they fail `ENOEXEC`, which reads like a
  wrong-architecture build.
- **Evidence must be cut from files in the run directory**, never from the terminal. That is why
  `write-*-evidence.sh` exist and why `verify-plane.sh` saves `client.out` and `neg-*.out`.
- **Unauthenticated document fields carry nothing.** The attestation format label and the boundary tuple are
  both guest-written; the same report relabelled still verifies. Properties of the confining monitor belong to
  the measurement. This is why the boundary tuple was deliberately not extended with a VMPCK field.
- Changing `ENCLAVE_APP_IDS` does rebuild the SVSM (verified), so a stale identity table cannot survive — but a
  *failed* build can leave the previous binary to be measured, which is why `build-measured-igvm.sh` now fails
  loudly instead of falling back.

## Where things live

- SVSM build tree (not version control): `~/.cache/enclave-isolation/svsmkit/svsm`, base `d37095e` + PR 1209.
  The repo's copies of the changes are `m4/svsm/appid.rs`, `0001-wire-appid-protocol.diff` and
  `0002-measured-guest-hash-table.diff`; applying 0001 then 0002 to a pristine `d37095e` reproduces the tested
  tree exactly, which is worth re-verifying after any kit edit.
- Firmware: `~/.cache/enclave-isolation/fwbuild/OVMF.amdsev{,.debug}.fd`, pinned by sha256 in
  `m4/verifying-firmware.txt`. Adding a firmware there requires substitution evidence, not a name.
- VCEK / chain / min-TCB: `~/.cache/enclave-isolation/m3-clean/` and `test/fixtures/amd/Turin-cert_chain.pem`.
- Guest sources: `m4/guest/` — `planeinit.c` (serving plane), `admitinit.c` (admission fixture), `plane.h`
  (shared sysfs helpers; extracted verbatim and verified by diffing preprocessed output), `appidmod.c`.
- Relevant memory files: `m4b-plane-binding-closed.md`, `sev-hash-table-fail-open.md`,
  `checks-that-cover-nothing.md`, `attested-means-chain-verified.md`.

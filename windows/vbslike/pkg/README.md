# The NucBox own-guest package

One manifest pins, by sha256, every byte that nucbox-k11 needs to boot OUR guest and serve one small app. For each byte
it records where it comes from and how to make it again. Owned by enclave-53. The box, the manager, the launcher and
the IGVM recipe belong to enclave-d1. The guest runtime (isolation/m3) and the datapath belong to enclave-5d. Tests
belong to enclave-99. This directory copies none of their files: it pins them by commit and hash.

**What this box is.** Tier `T0-hv`: a Ryzen with no SEV-SNP and no VMPL. The root partition can read every guest's
memory. Nothing served from this package is attested, verified or host-excluded capacity, and every script and record
says so.

## Two profiles, one monitor image

| profile | boots | needs from the host | serves the app through |
|---|---|---|---|
| `igvm` (the target) | `guest/openhcl-ownguest.bin`: an OpenHCL IGVM whose VTL0 is the monitor image | the Hyper-V role: `vmms`, `root\virtualization\v2` with `FirmwareFile`, `Get-VM` | the manager's WMI launcher boots it. Loading a bundle into it needs the datapath (slot `control.datapath`) |
| `hcs-dev` (development) | `guest/wsl-kernel` + `guest/mon.cpio.gz` under the box's `vbslike-host lab` | Virtual Machine Platform only | the launcher itself (hv_sock load + TCP relay). `win/smoke-hcs.ps1` runs it end to end |

`guest/mon.cpio.gz` is the IGVM's VTL0 initrd AND the hcs-dev initrd. `pkg.mjs verify` refuses a manifest in which the
two differ. `check.ps1` reports each profile's host state live. The manifest states only what each profile needs.

## Manifests

| version | id (sha256 of the file) | guest | apps | datapath |
|---|---|---|---|---|
| 1 | `6cdaf629…` `manifests/nucbox-ownguest-1.json` | IGVM `2d735376…` around monitor `44abb52b…` (isolation/m3 at `3c077840`), WSL kernel `7fe3edb5…`, manager `8327498e` | hello-world 1.0.4 (`/1`, AppID `9c3d10f1…`), hookbin 0.1.4 (`/2`, not servable) | empty |
| 2 | `197a9e3d…` `manifests/nucbox-ownguest-2.json` | IGVM `7caf7408…` around monitor `4610d594…` (isolation/m3 at `aef54ff7`: `/2` run mode, readiness, a launcher-named certificate name), WSL kernel `7fe3edb5…`, manager + judge-hv at `261e5f03` | the same two; hello-world's answer pinned to the byte (`"Hello World!\n"`, `03ba204e…`) | `datapath.mjs` `d0a57f6a…` at `67354f3b` (nothing on the box imports it yet) |
| 3 | `f0f516e4…` `manifests/nucbox-ownguest-3.json` | as v2; the launcher's provenance recorded (built from `ef1b2077`, one untracked uncompiled `monitor.rs` present; BEHIND `c5eb2f4a`, so `/2` bundles fail at its `load`); the image a judge expects is the initrd on hcs-dev and the IGVM on igvm | as v2 | `datapath.mjs` `b187da9e…` at `09b67414` (ids are any safe token) |
| 4 | `10139942…` `manifests/nucbox-ownguest-4.json` | as v3; manager + judge at `f4f10c84` (the VM is created with `-GuestStateIsolationType OpenHCL`, Secure Boot off; `ready.mjs`); launcher `57d8c035…` from `55494efa` (loads `/2`), nightly toolchain and build root pinned; `AllowFirmwareLoadFromFile` is a gating igvm host check | as v3 | as v3 |
| 5 | `ac8d68b2…` `manifests/nucbox-ownguest-5.json` | as v4; manager + judge at `6d6c289e` (`ready.mjs` without defect 10; `/vms` speaks guestd's contract: 201, `status`, `boundary`, `relay`, `domainId`, `guestPort`, `image`) | as v4 | `datapath.mjs` `2db32e0a…` at `b339e9d4` (admits on `transportKeySha256`); caveat: the manager does not populate `transportKeySha256` yet, so the datapath refuses to admit |
| 6 | `ce02a547…` `manifests/nucbox-ownguest-6.json` | as v5; manager + judge + node client + lifecycle at `72c82fc6` (the spawn path judges readiness with the runtime IDENTITY, read by `main.mjs` from `ENCLAVE_RUNTIME_IDENTITY`; `image` from the launcher's ready line) | as v5; eight functional suites pinned (enclave-99's seven + enclave-5d's datapath suite), all measured green | as v5 |
| 7 | `f4cbffee…` `manifests/nucbox-ownguest-7.json` | as v6 (manager `72c82fc6`; enclave-d1's later `0b49f6b6`/`5a8a33e7` are not pinned) | as v6; enclave-5d's datapath suite now RUNS its interop case (5/5, no skip) | + `node-bridge.mjs` `b1483afa…` and `supervisor-splice.mjs` `88e688cd…` at `e7ec6521` (ws loaded lazily); imported by nothing on the box until d1's appzone/host/main hooks land |

**Drafts.** `drafts/` holds a prepared next version that is HELD (its `status` says why). It is verified like any
manifest, but it is not a release and is not staged on the box. When it is released, it moves to `manifests/` unchanged.
- **v8 draft** (`drafts/nucbox-ownguest-8.json`): enclave-d1's node at `d1f4b745`, enclave-5d's `node-bridge.mjs`
  `4cb8d54f`, enclave-99's suites at `1d6d9b60`, and the catalog versions as read on-chain. It is held until enclave-5d's
  phase 3 passes against the real node. 5d measured the real node path failing (d1's gate order). Nothing is served.

- **v9 draft** (`drafts/nucbox-ownguest-9.json`, id `f99f16dc…`): v8 plus the `uefi` profile. The same guest is a
  standard UEFI payload on a read-only El Torito ISO `4c387086…` (UKI `75ae6bcc…` on enclave-5d's guarded initrd
  `5bc06259…`), with a VHDX fallback (payload `disk.raw` `a50fdd05…`), under Microsoft's standard OpenHCL `48773995…`,
  which this build starts (research E8). It is STAGED on the box at `pkg\f99f16dc15a1933a\` for enclave-d1's UEFI DEV
  boot. It is not a release, and host exclusion is not established. `verify --rebuild` rebuilds the ISO and `disk.raw`
  from the pinned inputs with both UKI recipes, and checks the VHDX's payload.

- **v10 draft** (`drafts/nucbox-ownguest-10.json`, id `b341dd1f…`): v9 re-pinned on enclave-d1's `cf640825` (the launcher
  states the partition kind `wmi-openhcl-gen2`; the UEFI identity is the medium's hash at attach) and enclave-99's
  `c6554c6c`, with the rebuilt launcher `cddb70fd…` (`f45015c7`, adds `hvdial`), d1's `uefi-dev-boot.ps1` and petri's
  `hyperv.psm1` pinned, and d1's first NucBox DEV boot quoted from its log. The medium is v9's `4c387086`, unchanged.
  STAGED at `pkg\b341dd1f5b53b97f\`, with the large files reused from v9's directory after hashing. Not a release. Nothing
  is loaded into or served from the booted VM: no control exchange for a WMI-created VM exists yet.

- **v11 draft** (`drafts/nucbox-ownguest-11.json`, id `67da7c50…`): v10 with the NEXT medium, ISO `7b9b04d6…` (UKI `20a0e18e…` on
  enclave-5d's initrd `a1ff9864…`, whose ready line names the vsock transport and which refuses to start with none).
  BOOTED on the NucBox by enclave-d1's E0 (2026-09-25 01:57Z, type 16, `isolation/m3/UEFI-BOOT.md` at `a02dddfb`):
  `transport=hv_sock` measured for a1ff9864, bundle loaded with hash agreement, hello-world served its 13 pinned bytes
  through the guest's TLS; a development boot, host NOT excluded. First STAGED at `pkg\515de1fa8596cafc\` (id
  `515de1fa…`, which LACKED the `managerServing` pin: a generator guard of mine skipped it), re-cut with the pin as
  `67da7c50…` at `pkg\67da7c509b296079\` (same medium bytes), with the launcher `c2cb0c10…` (`1ba73a20`: `hvdial` and `wmiserve`) and enclave-d1's served run
  recorded verbatim: with the previous medium `4c387086`, the dev-boot script drove `wmiserve` (9001 bound, `load` with
  hash agreement, a relay) and hello-world answered its 13 pinned bytes through the guest's own TLS. Limits, d1's:
  `curl -k`, so the app SERVES and identity is not verified; type 16 is OpenHCL with no isolation. The MANAGER cannot
  serve on this path yet (`managerServing`, pinned red as measured).

- **v12 draft** (`drafts/nucbox-ownguest-12.json`, id `8dc6d5b9…`, held with v11): v11 plus the NODE TREE enclave-5d's box acceptance
  harness imports and the harness itself (`hvlab-accept.mjs`, 8bb7d111). The tree is 27 repository files at d1's
  `cf640825` under `control/` and 15 npm packages (`viem` 2.56.8 as the box runs it, `ws`, `tweetnacl`, and `viem`'s
  own set) pinned as registry tarballs with npm's sha512 integrity; `stage.ps1` unpacks them into `control/node_modules`
  at their lockfile positions, inside the package only. `verify` assembles the tree and requires every module the
  harness imports to load from it. With that tree, enclave-99's host-activation runs in the package (6/6, pinned).
  `check.ps1` prints the `HVACC_*` block. The harness has NOT run on the box: it waits for the hv_sock exchange.

- **v13 draft** (`drafts/nucbox-ownguest-13.json`): the type-1 (VBS) material as an EXPERIMENT beside the type-16 DEV
  path. The production medium is enclave-5d's `fa8b0ec2` guest: initrd `0d14db23…`, UKI `7af57aab…`, ISO `ca245eae…`
  (the tuple now states `hv_isolation=` and `paravisor=` as the hypervisor says them, and a `MON hv` line), which
  supersedes v11's `7b9b04d6` (ca245eae is NOT yet booted on the NucBox; boots on KVM+OVMF to the guard's refusal,
  `uefi/evidence/ovmf-kvm-iso-smoke-ca245eae-2026-09-25.serial.txt`). New: Microsoft's `openhcl-cvm.bin` (`cfd40ce2…`,
  the same release/1.7.2511 artifact) as the type-1 firmware; a PROBE medium (ISO `8d1fea1f…`, UKI `f6ebbc0e…`: the same
  guest plus 5d's `/probe.ko` VBS-report probe) under `guest/uefi/PROBE-NOT-PRODUCTION/`, roles `probe.*`, which the
  verifier refuses as any profile's `medium`; profile `vbs` (GuestStateIsolationType 1) whose `measured` is "Nothing";
  the manager re-pinned at d1's `c067b446` (`handle.image` is the MEDIUM's hash as a string: `managerServing` moved to
  `imageIsMediumHash=true imageType="string"`, the other five gaps still red, and `main.mjs:38` still constructs the
  launcher without a medium); 5d's harness at `484903f7` (prints the guest's tuple; `HVACC_EXPECT_HV_ISOLATION` adds a
  28th check). Both media rebuild from their pinned inputs (`--rebuild`). The type-16 `hv_isolation`/`paravisor` values
  are NOT pinned (5d's none/yes is a prediction). NO isolation claim: type 1 has booted nothing of this package. The
  bytes were staged for d1 as `pkg\type1-fa8b0ec2\` (a plain directory with `SHA256SUMS`, hashed on the box) before
  this manifest existed; v13's `boxReuse` points there, so staging v13 copies, never replaces.

- **v14 draft** (`drafts/nucbox-ownguest-14.json`, HELD, not staged; v13 stays the staged package): v13 plus enclave-5d's
  SOURCE reading of the type-1 guest-state path (`isolation/m3/VBS-ISOLATION.md` at `1e9fe97b`, section 2; openvmm
  a7b0bd4; not measured): with no stateless option, no attestation agent, a real VMGS and a vTPM, the tenant-key path
  fails non-fatally and the VMGS is host-key-protected (GSP) or unencrypted, so `vmgsProtection` says exactly that and
  `vTpmBinding` is "NOT AVAILABLE on this host" (the host can read or forge the vTPM; our guest keeps no persistent
  secret). The `diagnosticGap` gains the route without COM3: `ohcldiag-dev <VM name> kmsg` (a Windows build, d1's call;
  not run here). v14 claims no more than v13: `measured[0]` is still "CREATED AND STARTED, NOT BOOTED". It is staged
  when d1's type-1 MON lines arrive and are pinned.

- **v15 draft** (`drafts/nucbox-ownguest-15.json`, SUPERSEDED by v16: its type-1 pin REFUSED-TO-START is WITHDRAWN, see
  v16): the production medium `ca245eae` is BOOTED on the NucBox under
  type 16 (enclave-d1: hashed at attach, firmware `48773995`, boot_ms 307, `transport=hv_sock`, hello-world's 13 bytes
  served; a development boot, host NOT excluded) and the three measured console lines are pinned verbatim: the tuple
  reads `hv_isolation=n/a paravisor=n/a` because leaf 0x4000000C is not defined on this host (max leaf 0xb), NOT the
  predicted none/yes; type-16 acceptance may run with `HVACC_EXPECT_HV_ISOLATION=n/a`. Type 1 is pinned
  REFUSED-TO-START under d1's recipe as of `f140bd56` (the matrix: None+16 boots; None+1 refuses; cvm+16 refuses;
  cvm+1 refuses at GuestFeatureSet 0x201/0x601 and starts-then-triple-faults at 0x400), distinct from "not yet tried"
  and NOT a verdict on type 1 (5d, `VBS-ISOLATION.md` §4 at `10145554`: three departures from petri's recipe); no
  type-1 VM has ever produced a console line; E2/E3 NOT RUN. d1's scripts at `f140bd56` (after the 714c4709 review:
  a failed run exits non-zero, a borrowed before-state is refused, a removal is verified). `ohcldiag-dev.exe` (the
  COM3 replacement: VTL2 kmsg over the always-on diag server) was built from the pinned openvmm `a7b0bd4` for
  `x86_64-pc-windows-gnullvm` with llvm-mingw 20260922 (no Microsoft SDK) and `+crt-static`, imports system DLLs
  only, and sits on the box as `pkg\ohcldiag-dev-5f25f2e7\` with `BUILD.txt`; it is pinned in the next version with
  d1's first-run evidence, not before.

- **v16 draft** (`drafts/nucbox-ownguest-16.json`, STAGED; supersedes v15): type 1 corrected to **STARTS, THEN FAILS
  WITHIN SECONDS; reason not yet readable** (d1 `af7aab92`/`3dbe444e`): with petri's recipe (no VTL2 trio, since
  `openhcl-cvm.bin` has no relocatable region and needs VTL2 at the fixed GPA 0x8000000; one DefineSystem; a real VMGS)
  the live VM reads back `GuestStateIsolationType=1 enabled=True GuestFeatureSet=0x201 Vtl2Mode=0 Vtl2Range=0` and
  starts, then the partition is deleted exactly 120 s later (OpenHCL's start-failure timer) with zero bytes on COM1.
  Not a verdict on type 1 either way; v15's REFUSED-TO-START was d1's VTL2 auto placement, as 5d's §4 reading said.
  d1's host facts pinned: an all-zero VMGS is refused by the host at realize (0x80070570), the donor VMGS is a valid
  v3.0 store (`GUESTRTS` + 00 00 03 00), and no host event channel carries OpenHCL's error text. Two lines re-marked as
  NOISE (`Loading IGVM file from default location`, `Create compute system, result 0xC0370103`: both appear on runs
  that booted and served), here and in profile igvm. `ohcldiag-dev.exe` (`5f25f2e7…`) is pinned as `tool.windows`
  with its BUILD.txt and d1's first run (`--help` exits 0, "CLI to interact with the Underhill diagnostics server"),
  plus 5d's expected `kmsg` output as UNMEASURED (the `microsoft-hcl` version line = VTL2; `microsoft-standard-WSL2`
  must never appear; on type 1 the line that matters is `failed to start VM`). Scripts at `3dbe444e`. E2/E3 NOT RUN.

- **v17 draft** (`drafts/nucbox-ownguest-17.json`, HELD, not staged; v16 stays the staged package): v16 plus 5d's
  inference on WHERE the type-1 start fails, pinned under its own label INFERENCE PENDING KMSG and never as a
  measurement: before `get_derived_keys` (the donor VMGS is pristine, byte-identical to a fresh `vmgstool create`
  header, so neither GSP branch applies; the host's GSP lines were absent on the type-1 run; the host renders
  OpenHCL's GET events and no VMGS failure event appeared), leading candidate `validate_isolated_configuration`
  (worker.rs:2230, emits no event). Discriminators for the next runs: the kmsg chain "invalid host-provided
  configuration for isolated VM", and `ohcldiag-dev <VM> inspect -r vm/init_data/dps` on the type-16 control run for
  the general.* values that check refuses. v17 is staged with d1's first kmsg run.

- **v18 draft** (`drafts/nucbox-ownguest-18.json`, HELD; supersedes v17; v16 stays staged): d1's 03:26 `ohcldiag-dev`
  runs pinned VERBATIM: type 16 read 354 VTL2 kmsg lines (`6.12.52-microsoft-hcl+`, `runner@runnervmrw5os`, the full
  OpenHCL command line, no `microsoft-standard-WSL2`) so the tool is MEASURED working; type 1 answered exactly
  `Error: unknown service diag.UnderhillDiag` (stderr; stdout empty), pinned with d1's and 5d's reading as a CVM-mode
  reply from a RUNNING diagnostics server — positive evidence that VTL2 and OpenHCL userspace came up in an isolated
  partition, localising nothing. The type-16 inspect baseline (`build_info`: release/1.7.2511, 29e15ab8; `control_state`
  started). Two corrections: the all-zero VMGS was refused for lacking a VHD FOOTER (a fresh store is an empty 4 MiB
  store + `conectix` footer), not for content; and OpenHCL's formatter wrote the `GUESTRTS` header on open, so the
  worker DID open the guest state — v17's "pristine donor" inference reason is withdrawn (its other two stand). 5d's
  `vmgs_check.py` (file 18, PROVISIONING_MARKER). The memmarker PROBE medium (ISO `f173f15c…`, UKI `265de2cc…`, initrd
  `6dd5deeb…` reproduced byte-exact) as a second `probe.*` medium, rebuilt by `--rebuild` and refused as any profile's
  medium. Probe initrd notes corrected per 5d: the module is archived at mode 0644 (cpio records the mode) and every
  initrd pin carries builder uid/gid 1000 (caveat). The VTL2 inputs now come from durable read-only copies
  (`sources/vtl2/`) with constant-hash asserts in the generator, after a flowey run in the pinned tree overwrote the
  initrd pin on this machine and the phase-2 command restored it byte-exact; and the IGVM rebuild check now feeds d1's
  `build-ownguest.sh` a SHADOW TREE of the pinned VTL2 bytes, because the real tree's second extracted kernel package
  had made the script's `ls | head -1` pick the CVM kernel while every pin was right. E2/E3 NOT RUN; no MON line under
  vbs.

- **v19 draft** (`drafts/nucbox-ownguest-19.json`, STAGED; supersedes v16 as the staged package): the type-1 start
  failure is NAMED on the a7b0bd4 DEBUG image (d1 `81173698`, relayed by 5d `4c4a4b3b`; d1's verbatim pending):
  `failed to start VM error=failed to initialize memory: cannot safely support VTL 1 without using the alias map` at
  0.126 s, the +120 s panic being the start-failure timer — MEASURED for that build, a HYPOTHESIS for the stock 2511
  image, which the CONTROL image decides. Both probe firmwares are pinned under `probe.firmware`
  (`openhcl-cvm-VBS-DEBUG-TRUSTS-HOST-81e163ee.bin`, whose note's first words are "THIS FIRMWARE TRUSTS THE HOST
  COMMAND LINE", and `openhcl-cvm-a7b0bd4-CONTROL-32d464cc.bin`, the same code without the flag) under
  `guest/uefi/PROBE-FIRMWARE-never-a-serving-candidate/`, and the verifier refuses a `probe.*` file as ANY profile's
  `firmware` or `image` (tested by mutation on vbs, uefi and igvm). 5d's source reading (Guest VSM available + no
  `vtl0_alias_map_available` → OpenHCL bails in memory init), the next step (`Set-VMSecurity
  -VirtualizationBasedSecurityOptOut $true`, pinned as a PREDICTION), and the inspect correction (`control_state`
  "starting" ~50 ms on type-1 images). v17's inference is marked RESOLVED (the failure is in memory init, before the
  candidate it named). Type 1 stays an experiment: NO isolation claim, E2/E3 NOT RUN, no type-1 console line.

- **v20 draft** (`drafts/nucbox-ownguest-20.json`, HELD; v19 stays staged): v19's next-steps order was one step stale
  (the DEBUG run had already happened). 5d's order for d1 replaces it: (1) DEBUG image + `VirtualizationBasedSecurityOptOut`
  on the same type-1 definition with `kmsg -f -r -v`; (2) if it boots, STOCK image + the same opt-out with `inspect
  control_state` and COM1 ("started" plus MON lines would be the first booted type-1 guest; E2 next); (3) the CONTROL
  image any time, gating nothing. Two no-boot log checks ("enabling alias map" type 16 vs type 1; "empty vmgs file,
  formatting" / "failed to write vmgs provisioning marker" in the debug kmsg). Staged with d1's next type-1 run.

- **v21 draft** (`drafts/nucbox-ownguest-21.json`, STAGED; supersedes v19): **a type-1 partition BOOTS AND SERVES** on
  the a7b0bd4 CONTROL image `32d464cc…` with `Set-VMSecurity -VirtualizationBasedSecurityOptOut $true` (d1, verbatim):
  `inspect control_state` "started", `MON hv … isolation_priv=true config_b=0x1`, `MON boundary … host_excluded=no
  hv_isolation=vbs paravisor=no`, `MON ready … transport=hv_sock`, hello-world's 13 bytes (sha `03ba204e…`). The
  guest states `hv_isolation=vbs` and STILL `host_excluded=no`: a development boot of an experimental image; NO
  isolation claim; E2/E3 NOT RUN. The profile's pinned firmware stays the stock `cfd40ce2`, which does NOT boot type 1
  here (measured with the same opt-out and medium: "starting", never boots) — the image that boots stays a
  `probe.firmware`; promotion is a separate decision. DECIDED: the stock failure is 2511-specific (5d from source: the
  Guest-VSM/alias-map code at 29e15ab is identical, so 2511 fails on a different, unnamed error); the named failure was
  Guest VSM, not the debug flag, cleared by the opt-out on a7b0bd4. Two host facts in d1's terms: the opt-out is
  REQUIRED (CIM property ReadOnly; cmdlet only) and legitimate because Guest VSM is VTL1 inside the guest, which our
  guest never uses, while the partition's isolation from the host is a different, untouched mechanism; and `Save-VM`
  is REFUSED on type 1 (refused-by-host; a constraint on E3's design, NOT evidence of protection). `paravisor=no` is
  what the source expects (5d's vbs/yes prediction was wrong). The suite rule that forbade any MON line under vbs is
  replaced by a verifier rule: every quoted boundary line carrying a `host_excluded=` value must say `no` while the
  tier is not host-excluded (mutation-tested). Scripts at `c9c8cdcc` (wmiserve's hard-coded type-16 boundary string
  noted as d1's pending fix). Next: E2 on the vbsreport probe on this definition, with the host's TCG log.

- **v22 draft** (`drafts/nucbox-ownguest-22.json`, STAGED; supersedes v21): **E2 has run and decides nothing**. On the
  booting type-1 definition (a7b0bd4 CONTROL `32d464cc…`, Guest VSM opted out) the vbsreport PROBE medium `8d1fea1f…`
  reproduced the type-1 tuple and printed `VBSREPORT status=0x71 (…)` then `MON PROBE finished: No such device`, with
  no report body; 0x71 = HV_STATUS_OPERATION_FAILED (recognised, accepted, not denied, no report). Verdict (5d,
  `26eac9c2`): NEITHER GO nor NO-GO — the signing chain is not shown and "VTL0 refused / vTPM only" does not follow.
  The same boot's host TCG log is captured on the box, needed only once a report exists. Next, no new code: the debug
  image's kmsg on a type-1 + opt-out boot for OpenHCL's own VTL2 report attempt ("Failed to retrieve key-encryption
  key" — a GetAttestationReport/GetVbsReport error means no report for this partition at all; an IGVM-attest/agent
  error means VTL2 gets one and only VTL0 is turned away). E3 NOT RUN (no documented instrument on type 1). Unchanged:
  `host_excluded=no`, no isolation proof; stock 2511 is a product decision for the monitor. d1's verbatim probe lines
  pending.

- **v23 draft** (`drafts/nucbox-ownguest-23.json`, SUPERSEDED; its E2 "resolved" wording is WITHDRAWN in v25): E2 VERBATIM from d1 (run 042300, RUN OK;
  every condition read back off the live VM; the probe's entire output is one line, `[0.335899] VBSREPORT status=0x71
  (…)`, reconstructed from a console-interleaved raw line and said so; the guest's own type-1 tuple; the host TCG log
  name and size) and **E2 RESOLVED** by the debug image's kmsg of the opt-out boot that booted: OpenHCL's own VTL2
  report attempt fails at `IgvmAttest KEY_RELEASE … the size of the attestation response 0 is too small to parse`,
  an agent failure on a zero-length response, not a report-generation failure — so the VBS report WAS obtained by
  VTL2. Conclusion in d1's words: the hypervisor produces a VBS report for this partition TO VTL2 and turns VTL0
  away; the chain is not absent but reachable only through the paravisor, which makes a client-verifiable binding a
  DESIGN CHANGE rather than a guest patch, buildable here unanswered. Not an isolation claim: `host_excluded=no`,
  nothing verified, E3 NOT RUN; stock 2511 is a product decision for the monitor. d1's `b0f20482` evidence document
  is NOT yet an input (my generator missed it: git abbreviates the path in its stat line); it is pinned in the next
  version. The box launcher's hash is NOT re-pinned until d1 gives the post-rebuild one.

- **v24 draft** (`drafts/nucbox-ownguest-24.json`, SUPERSEDED; carries v23's E2 wording, WITHDRAWN in v25): enclave-5d's reading AGREES with d1's E2
  conclusion and is pinned BESIDE it, not over it (`c8529534`): (1) it is a finding, not an inference — OpenHCL calls the
  same VBS-report hypercall first and returns on failure before sending the IGVM_ATTEST request, so the empty-response
  parse error means the VTL2 report call succeeded; (2) PAIRING CAVEAT — the VTL2 success was seen on the debug image
  and the VTL0 `0x71` on the control image (same a7b0bd4 code, manifest and layout; the flag changes only OpenHCL's
  command line and digest), so one debug-firmware boot with the vbsreport probe would give both answers from one
  partition (optional, d1's call); (3) VTL2's report binds OpenHCL's own key-release claims, NOT our guest's key —
  nothing today binds the domain's TLS key to a VBS report, and the signer question (IDKS or not) is UNTESTED because
  no report has been in our hands. d1's `b0f20482` evidence (the input v23 missed) and 5d's `c8529534` review are
  inputs. Unchanged: `host_excluded=no`, E3 NOT RUN, no isolation claim.

- **v25 draft** (`drafts/nucbox-ownguest-25.json`, STAGED; supersedes v24): **E2 corrected** per d1's own record
  (`91f24619`, caught by the monitor): E2 is NOT complete and the customer chain is NOT established. VTL2 obtaining a
  VBS report is STRONGLY SUPPORTED BY INFERENCE, on the debug image only; no report bytes were captured; no signature,
  signing key or root was identified or verified; VTL0's `0x71` is not access-denied and does not show VTL0 can never
  get a report. v23/v24's "resolved" wording is withdrawn (no live field keeps it; a suite case checks), 5d's source
  reading stays beside it, classified, and d1 decided against a boot for the pairing caveat. **Launcher re-pinned** to
  d1's post-build `da16c20f…` (from `daa61749`: wmiserve takes `--isolation-type` and states the partition it was
  given), which the dev-boot script at `29ea63e5` requires; both RAN in d1's tooling canary (RUN OK, `ad5aa058`;
  the kill path not exercised) — a tooling result, not an isolation result. Review findings 4a, 4b, 5, 8–11, 12(i)(ii)
  closed. **Next milestone** recorded, nothing built: a paravisor-mediated attestation path found by d1's checked
  source trace (vTPM NV index `0x01400002` write, `0x01400001` read, a 2900-byte blob carrying a VBS report over a JSON
  containing the guest's 64 bytes), with its two limits (the launch measurement does not cover our DVD medium; with no
  VMGS encryption the vTPM's AK carries no trust); the capture-only probe is paused by 5d pending Steven; 5d's
  contract (`dd31cada`) is a design-only input; the pinned VTL0 kernel has `CONFIG_TCG_TPM=y`, `CONFIG_TCG_TIS=y`,
  `CONFIG_TCG_CRB=y` built in. Unchanged: `host_excluded=no`, E3 NOT RUN, no isolation claim.

- **v26 draft** (`drafts/nucbox-ownguest-26.json`, STAGED; supersedes v25): **the host trust root** as d1 measured it
  (`6d4adb19`), at its stated strength, under `tier.hostTrustRoot`: VERIFIED that the host's SRTM log (`0c23255a…`)
  replays to its TPM PCRs 0–14 (read locally, not a signed quote) and that the VSM_IDK/IDKS public keys are in PCR 12;
  VERIFIED GAP: Secure Boot off, test signing on, the production enclave engine signed only by a self-signed test
  cert; UNTESTED: that IDKS signs the paravisor's report, and a TPM quote. 5d's ruling (`aebd6bd7`, design only):
  Secure Boot off or test signing on is a rejection condition, so a conforming verifier rejects this box's reports
  today — Steven's decision. d1's `tcglog.py` and `tpm-pcr-read.ps1` ship as tools. **A build-only candidate**: a VBS
  IGVM with our kernel, initrd and VTL0 command line as a MEASURED Linux VTL0 (`5562e71d…`, VBS launch digest
  `246DEE1B…`), built with the pinned igvmfilegen from exactly the booted control image's paravisor components — a
  twin under the control's own vbs config reproduces its launch digest `77C66160…` — with the static paravisor
  command line exactly `OPENHCL_FORCE_LOAD_VTL0_IMAGE=linux` (required to load a Linux VTL0; no confidential-debug
  flag, checked on every verify). It is a build INPUT, never shipped; `--rebuild` remakes it and the twin in a scratch
  directory from pinned inputs only. NOT booted; untested for VBS; does not cover the host-derived memory layout,
  ACPI/device tree, or the app. `host_excluded=no` unchanged.

- **v27 draft** (`drafts/nucbox-ownguest-27.json`, STAGED; supersedes v26): **Steven's direction** (via d1): "We
  should only be using Our new isolation implementation." — the custom type-1 path is the only target; the old
  ee-engine VBS-enclave backend is marked LEGACY/UNSUPPORTED, not a recovery target (`legacy`, and notes on the two
  shipped node files that speak or cite ee-host). **The host changed**: the box rebooted at 05:32:35Z with Secure Boot
  ON (boot 68); v26's trust root is scoped to boot 67 and void for combination; boot 68's measured log shows
  SecureBoot=01, TESTSIGNING=00, VSM and HVCI on, replays to PCRs 0–14, and a fresh nonce-bound TPM quote passes every
  relay check with 7/7 negative controls refused (d1's quote session pinned file by file). **Under Secure Boot the
  custom type-1 path boots and serves** (canary 054323: Hyper-V accepted our unsigned control IGVM with
  AllowFirmwareLoadFromFile set), and the **inverse control** (054616) shows that setting gates loading our firmware
  (Worker 5142 without it). The build-only candidate gains its **debug twin** (`726d3cb5…`, trusts the host command
  line, build-only), and a finding for verifiers: igvmfilegen's identity document says `debug_build=false` even for
  confidential-debug images, so only the exact launch digest tells them apart. Dev-boot script at `a891dfae`.
  `host_excluded=no`; E2/E3 not re-run under Secure Boot; no isolation claim.

- **v28 draft** (`drafts/nucbox-ownguest-28.json`, the **handoff version**; STAGED 06:18Z on d1's word at `pkg\cb9fe5645497a0ca\`): the
  measured-VTL0 candidate rebuilt at 5d's review with `static_command_line=true` (the one requested change) and
  **shipped** with its debug twin: candidate `c567e432…` (role `candidate.igvm`, never a profile's firmware until a
  version records it booting), launch digest `A0FDAC0F…`; twin `24e7a1ff…` (`probe.firmware`, trusts the host,
  diagnosis only), `A650C020…`. **Offline mutation evidence**, re-checked on every `--rebuild`: one byte of the
  kernel, one byte of the initrd, the VTL0 command line, the static paravisor line and `static_command_line=false`
  each change the launch digest to a pinned value (the last reproduces the superseded v27 candidate `246DEE1B…`
  exactly). **Reference values** for 99's verifier ship as `reference/nucbox-vbs-reference.json`: every image's
  digest, sha256, class, confidential-debug and eligibility, re-derived from the pinned bytes on every verify; only
  the non-debug candidate is eligible, and every pinned probe/candidate firmware must be listed (mutation-tested).
  The Linux VTL0's serial path is recorded from source (OpenHCL builds its ACPI COM1 UART over the host's vmbus COM1,
  the route the UEFI runs used). Not booted; `host_excluded=no`; no chain claimed.
- **v29 draft** (`drafts/nucbox-ownguest-29.json`; supersedes v28; cut by enclave-63, who took the package over from
  enclave-53 on 2026-09-25): the candidate `c567e432…` **boots and serves** as profile `vbsLinux` (type 1, the
  measured Linux VTL0 IGVM as the firmware, no medium). It BOOTED in d1's canary 061934 (`0564ff8d`; no app loaded)
  and SERVED in canary 062450 (`88f444b3`): hello-world loaded with hash agreement (`"boot":null`, the initrd predates
  the G1 nonce) and served its 13 pinned bytes through the guest's own TLS, both lines verbatim. The launcher is
  re-pinned to d1's post-build `0160d835…` (from `8f156c9a`: `wmiserve --igvm-sha256`, the G1 boot nonce on
  stop/destroy, no default ids; its two changed sources re-hash to d1's stated `52e1b39a`/`d2fe7733`) and the dev-boot
  script to `8f156c9a`; d1's byte review and `vbsdigest` (`5ae35c7d`) and both canaries' evidence are inputs. The
  reference file's candidate entry says it served. **Served is not isolated or attested:** the `--igvm-sha256` report
  path was built but NOT exercised; identity (judge-hv), any report or chain, and host exclusion are NOT established;
  `host_excluded=no`, T0-hv.
- **v30 draft** (`drafts/nucbox-ownguest-30.json`; supersedes v29): the **G1 measured-VTL0 candidate**, built and
  reviewed, **not booted**. `a44bb55a…` (launch digest `58DFEBFE…`) is v29's candidate recipe with ONLY the VTL0
  initrd swapped for enclave-5d's G1+G3 initrd `680d40fa…` (`e8b91efd`: the per-boot nonce that stop/destroy require,
  and the front's 504 after 180 s). enclave-63 reproduced the initrd byte-exact twice. The candidate is rebuilt by
  `rebuild.vbsLinuxG1`, which is proven in the same run by reproducing `c567e432`/`A0FDAC0F…` and the twin proof
  `77C66160…`. Its debug twin `4991b3e1…` (`2A93ED16…`) is a named rejection. Mutation evidence is against the G1
  baseline. enclave-d1's independent byte review agrees (`ce26bc6e`). Role `candidate.igvm`: no profile uses it as
  firmware until a version records it booting. The reference file lists it `eligible: false` ("not booted yet") while
  `c567e432` stays the one eligible entry. The flip and `c567e432`'s supersession come in one version, after
  enclave-d1's canary, and enclave-99's verifier refuses two eligible images.
- **v31 draft** (`drafts/nucbox-ownguest-31.json`; supersedes v30): **the G1 candidate boots and serves, and its per-boot
  nonce holds** (enclave-d1, canary 070020, `7b509d16`, script at `95752533`). `a44bb55a…` was re-hashed at use and read
  back as type 1 with no medium. The guest printed `MON boot 39725c19…`, and hello-world loaded under that boot and
  served its 13 pinned bytes. Three raw destroys over hv_sock:
  - with no boot: `bootRequired`, and the app is still 200;
  - with a wrong boot: `rebooted:true`, nothing touched, and the app is still 200;
  - with the load answer's own boot: `destroyed:1`, and the app is gone.

  The launcher's own `rebooted` handling and G4 were not covered. **The rollover happens in this one version:**
  `a44bb55a` becomes `vbsLinux`'s firmware (the `pkg.mjs` rule from `5a45e9c9` requires its reference entry to record
  it booting) and the one eligible reference entry, still prospective. `c567e432` and its twin move to `superseded`
  ("booted and served, no report was ever verified") and are no longer shipped; they remain in the staged v28–v30
  packages for rollback. Served is not isolated or attested: `host_excluded=no`, no report, no chain.
- **v32 draft** (`drafts/nucbox-ownguest-32.json`; supersedes v31): enclave-d1's **new launcher build `15338081…`**
  (from `50010709`, where only `wmiserve.rs` changed: `--hold stdin`, and a bad `--hold` is refused before anything
  starts; built with the box's `Cargo.lock`, `5c0ee1b7…` at `637b21c3`) ships **beside** the pinned `0160d835` as the
  new role **`candidate.launcher`** for the acceptance run. A `pkg.mjs` rule keeps a candidate launcher from ever being
  a profile's launcher. The profiles keep `0160d835` until a version records the acceptance run passing. The VM-less
  refusal checks pass, but the stdin *lifetime* is not exercised. **Reproducibility (enclave-d1):** a rebuild of the
  unchanged `8f156c9a` differs from `0160d835` in 24 bytes, all link timestamps and the PDB GUID; normalized, they're
  identical. So a pin names one built binary (a byte-exact rebuild would need `/Brepro`). Profile `uefi` is
  **labelled**: "pre-G1 monitor (initrd 0d14db23); no isolation claim possible (unmeasured medium); not a proof or
  serving candidate". Note: `uefi-medium` in `pkg.mjs` file roles (`guest.uefi-medium`) names the medium FILE. It is
  not the contract's `guestImageKind` (enclave-99, `ae6e9147`), though the word is the same.
- **v33 draft** (`drafts/nucbox-ownguest-33.json`; supersedes v32): **the G4 PROBE image** `72462737…` (launch digest
  `CF339BC5…`), built and reviewed, not booted. It is the G1 candidate's recipe with only the VTL0 initrd swapped for
  enclave-5d's probe initrd `e3b68c92…` (`680d40fa` plus one appended archive holding the probe module `8b7f5ace…`),
  which enclave-63 reproduced byte-exact. enclave-d1's byte review agrees (`7ce0a5fa`). It ships as `probe.firmware`
  under a PROBE path: never any profile's firmware, and never eligible (reference class `probe`, refused by exact
  digest). It is for enclave-d1's G4 run, which enclave-d1 schedules. **Also** recorded: enclave-d1's manager
  restart-recovery acceptance on `a44bb55a` (run 080420, `33a5bb06`/`fbc13e81`: one VM, recovered:true held, no second
  VM, DELETE by VM Id). That is a manager result only; no `vbslike-host.exe` ran, so the candidate launcher stays a
  candidate. **And** each profile states its boot form as `profile.contract` in the verifier contract's vocabulary
  (`vbsLinux` the Linux-direct pair, `uefi` and `vbs` the UEFI-medium pair, `hcs-dev` and `igvm` `null`). It is
  informational and never feeds eligibility.
- **v34 draft** (`drafts/nucbox-ownguest-34.json`; supersedes v33): **the serving acceptance passed** (enclave-d1,
  run 082325, `c9a67951`). The real manager ran one wmiserve per domain with `--hold stdin`. `hvlab-accept` passed ALL,
  and restart A0–A7 passed ALL, including A7 (the relay dies with the manager). The run's launcher, whose hash was
  recorded at use, is **`435717de…`**, built from `1a6f1556`: `wmiserve.rs` signs with the contract's report format
  `hyperv-partition-domain/v1`. It is re-pinned as the one `control.launcher` in this version, since the run is the
  acceptance the candidate discipline requires and it ran exactly this binary. Both earlier launchers leave the
  package: the v32/v33 candidate `15338081` failed the judge in run 081904 on a stray local format name, and
  `0160d835` carries the same name on its wmiserve path. Both remain in the staged v28–v33 packages. Scope
  (enclave-d1): T0-hv, host NOT excluded, reports signed by the host's launcher key (a host statement, never a root),
  no hardware VM report; not an isolation claim.
- **v35 draft** (`drafts/nucbox-ownguest-35.json`; supersedes v34): **v34 passed the serving acceptance as staged**
  (enclave-d1, run 084443, `54627fa2`). From `pkg\6c82ff93fd3e3718\` it used the one launcher `435717de…`, the
  candidate `a44bb55a`, `runtime.json` and hello-world. `hvlab-accept` passed ALL, and restart A0–A8 passed ALL. In the
  new A8, a second domain's VM was turned Off from the host, and the manager's liveness sweep failed the domain within
  4 s and closed its relay. The manager, node and harness came from enclave-d1's `windows/hv-acceptance` `4a51c13f`,
  NOT this package's `control/` tree (`c067b446`), and the guest-state master is the box's own. So the package's own
  acceptance block is still not run. Scope: T0-hv, host-signed, host not excluded; not isolation.
  **G4 is answered, as a host-behaviour measurement** (enclave-d1, run 082856, `4e314db7`). The probe `72462737` panicked on purpose at 121.8 s. Hyper-V
  logged 18590 (a fatal guest error) and then 18515 (a reset the guest initiated), and turned the VM off within a
  second. It did not reboot (one `MON boot` line in 330 s) and did not wedge. So on type 1 a dead monitor ends the
  domain, and there is no second boot for G1 to meet. The manager now sweeps for stopped VMs (`d7d4fd1c`, not pinned
  here), because wmiserve does not exit when its VM stops. The probe's reference entry now records that it booted
  once; it stays refused. The probe is reused from v33's staged copy instead of pushed again. The dev-boot script's
  note says it uses the box's own `target\release` launcher only for hvdial, which signs nothing. Scope: T0-hv,
  host not excluded; not isolation evidence.

- **v36 draft** (`drafts/nucbox-ownguest-36.json`; supersedes v35): **the package's control tree is now the one that
  ran.** `control/` is re-pinned to `windows/hv-acceptance` `2c3a2873`, exactly what enclave-d1's run 090327 ran on
  v35's inputs (`c5bb270d`). hvlab-accept passed ALL and restart A0–A9 passed ALL. The new A9: a domain stopped inside
  the guest, with its VM still Running, was failed by the answer sweep after 3 strikes. The tree's import closure adds
  `wmiserve-run.mjs` and `verify/boot-statements.mjs`. The harness is re-pinned at `c192380c`, and enclave-99's lifecycle
  spec at `755b3f88`, where attestedCapacity is false for every view. The npm tree stays the 15-tarball import closure:
  the root lock is byte-identical, and 090327 itself installed the full 90.
  - **The vbsLinux manager's environment** is stated in `profiles.vbsLinux.managerEnv` (enclave-d1's list), and
    `check.ps1` prints it. `hyperv.psm1` (`17ca4352`) and `type1.vmgs` (`4f051697`) are **box files**: hash-checked by
    `check.ps1` (`hostChecks.vbsLinux.boxFiles`), not shipped. The verifier refuses an environment that names a
    variable the pinned `main.mjs` does not read, or that contradicts the package: another IGVM, launcher, boot form,
    or hyperv.psm1 pin.
  - **The manager check measures the type-1 launcher.** It states the boot form and supplies the type-1 inputs. It
    reads isolation type 1 from the `New-CustomVM` line, and it lays out the judge's files beside the manager's. It
    fails a forged launcher that stops asking for the isolation type.
  - **The next production candidate `b7ba7731`** (launch digest `56FBB27F…`) is a44bb55a's recipe with only the initrd
    swapped for enclave-5d's `1539d5b2`. There, only `plat/domprobe` differs: the open-only TPM negative control.
    enclave-d1's review agrees (`fd92d610`). It is eligible:false and booted no, it is no profile's firmware, and its
    debug twin is `95de03cc` / `8E9D6ACB…`.
  - **A correction of v35's note on `uefi-dev-boot.ps1`**, now pinned at `c16d785d` (the script with the probe step).
    The script runs the box's own `target\release\vbslike-host.exe` for hvdial, which signs nothing. With `-Bundle`
    it also runs that binary as `wmiserve`: the 9000 load and the 9001 report signer. `-ProbeDomain` refuses `-Bundle`,
    so a probe run only dials.
  - Scope: T0-hv, host-signed, host not excluded; not isolation.
- **v37 draft** (`drafts/nucbox-ownguest-37.json`; supersedes v36): **the candidate `b7ba7731` boots and serves in its
  own canary, and is still not eligible** (enclave-d1, run 093904, `0bee8444`). It booted as a type-1 partition with
  the host's Secure Boot on. It served the pinned fixture `03ba204e`, through the box's `target\release` wmiserve
  `0160d835`, not the package's launcher. The TPM control reads `dev_tpm0` and `dev_tpmrm0` = No such file or
  directory: **absent from the domain's view; existence in the root namespace not stated**. The live-neighbour probe
  under enclave-99's rules is INCONCLUSIVE, as expected on this build. **No rollover:** a44bb55a stays the one eligible
  image, until one version makes b7ba7731 eligible and supersedes a44bb55a after the package's own serving acceptance
  on it. Also in v37:
  - run 093326 re-judged INCONCLUSIVE (`ad61cb02`);
  - `uefi-dev-boot.ps1` re-pinned at `ad61cb02`, the script the canary ran;
  - **v36's `check.ps1` fixed**. Its env block threw under StrictMode after `PACKAGE OK`, so a plain check exited 1.
    The box scripts now run under PowerShell 7 in `pkg.test.mjs`, and that test fails v36's script the way the box did.
A manifest is never edited after it is committed. A changed guest, app or tool is a new version with a new id.

**v1 is defective. Use the latest (v7).** v1 pins hello-world's answer as `"Hello World!"`. That answer was never observed: it was
copied from a client that trims. The app answers `"Hello World!\n"`, so v1's serve checks would fail on a correct
answer. The current verifier refuses v1 at that pin. `--serve`, which serves the component under the pinned runtime and
compares the exact bytes, is the check that would have caught it. The rest of v1's pins stand for the old guest.

**v2 and v3 carry a stale manager.** Their manager creates the VM without a guest-state isolation type. Hyper-V then
accepts the IGVM pin, reads it back, starts the VM, and never loads the image, with no diagnostic anywhere (measured by
enclave-d1). Every file still hashes to its pin, so the verifier asks the manager's own code: `win/manager-check.mjs`
runs its `start()` against a recording fake host and reads the `New-VM` it issues. The current verifier refuses v2 and
v3 at that check.

## Reproduce and verify (warden-host)

```
node windows/vbslike/pkg/pkg.mjs verify windows/vbslike/pkg/manifests/nucbox-ownguest-7.json --rebuild --fetch https://ipfs.enclave.host --serve --tests
node --test windows/vbslike/pkg/pkg.test.mjs
```

`verify` derives every pin from its source. It does not take the pin from the manifest's say-so:
- **Pinned bytes.** Git objects at their commits, the files on this host, and canonical JSON written from the manifest
  itself. A `repo` source (the package's own scripts) is read at THE MANIFEST'S OWN COMMIT, because a manifest is
  committed together with its scripts. So a committed manifest keeps verifying after the scripts move on. A manifest
  still being authored reads the working tree.
- **Apps.**
  - The component is the content its CID names.
  - The record hashes to its recordSha256 and names that CID and the guest's runtime.
  - The bundle is derived twice, by `derive_reference.py` and by the manager's own `derive.mjs` at its pinned commit,
    and both derivations hash to the AppID.
  - A spawn request carries exactly the record.
- **Runtime.** The runtime identity recomputes to `runtimeId`.
- **Tier.** It says T0-hv, host not excluded, no SNP, no VMPL.
- **Servable.** An app is marked servable only on the derivation the pinned manager serves.
- **`--rebuild`.** Makes the VTL0 vmlinux from the WSL bzImage (`vtl0-vmlinux.sh`), then the IGVM from the pinned
  openvmm `a7b0bd4` VTL2 pieces, that vmlinux and the monitor initrd (`build-ownguest.sh`, igvmfilegen only). This
  takes seconds and starts no compiler.
- **`--fetch`.** Fetches each component by CID.
- **`--serve`.** Serves each servable `wasi:http` app with this host's wasmtime, which must be the version the runtime
  identity names. The answer must be the pinned bytes.
- **The judge.** It loads from the package's own files, laid out as shipped, and rejects a document that is not one.
- **The igvm manager.** Run on a recording host, its own `start()` must issue `New-VM -GuestStateIsolationType` OpenHCL
  or TrustedLaunch.
- **The npm tree** (manifests with `npmTree`). Each pinned tarball is checked against npm's sha512 `integrity` as well
  as our sha256, unpacked into its lockfile position (nested where npm nests it), and every module in `mustLoad` must
  import from the assembled tree. A pinned test marked `npmTree: true` gets the same tree, so a test that imports the
  node's own dependency graph runs on the pinned bytes, with no stub.
- **The node's record builder, against the catalog** (manifests with `catalogFacts`, from v8). The manifest records each
  app's catalog version as read from the chain, with the chain, block, address book and catalog. The shipped
  `node-bridge.mjs`'s `isolationPlan` builds the derivation record from those facts, as the node does at spawn time. That
  record must equal the pinned record as canonical bytes, not field by field. Field by field would miss a builder whose
  fields are all present and well-formed but wrong: enclave-d1's hand-built record took `memMiB` from the node's
  `cpuFallback` floor and `catalog.app` from a label, which gives another AppID than the Linux tier. The package's
  records were never affected; they are the Linux tier's own.
- **`--tests`.** Each functional test the manifest pins runs INSIDE the package's own `control/` tree, as shipped, so its
  relative imports resolve to the package's bytes. These are other lanes' tests, pinned by commit. Each must give
  exactly its stated result: the counts, and which cases fail. v5 pins enclave-99's `readiness-rule.test.mjs` against
  the manager's `ready.mjs` (8/8), and its `datapath.test.mjs` against 5d's datapath (5/5). The same readiness test on
  v4's manager gives exactly 4 failures (cases 3, 4, 5 and 8 = defect 10). The suite holds that result too, and refuses
  a green claim for it. A pinned test is a known result, not a green count. The result includes which cases SKIP and why: a skip the pin does
not declare, or a skip for another reason, fails the pin. Otherwise a case that quietly stops running would read as a
pass in the counts. Todo and cancelled cases must be zero unless declared. A failing case can be pinned
with its EXACT message (`{case, message}`), so a case that fails for another reason fails the pin. A test that reads
repository data (contract vectors, the launcher's source) names it as `support`: pinned inputs placed at their repo
paths for the run, never shipped. An npm dependency a test imports is pinned the way npm pins it: the
lockfile's tarball, checked against its sha512 `integrity` as well as our sha256. It is unpacked into the test tree
(`unpack: "npm-tgz"`) and never shipped. A test run under another test runner must
  strip `NODE_TEST_CONTEXT`, or the child reports in a binary protocol and no counts can be read.

The test suite has 50 cases. It breaks one claim per case, including consistent forgeries where the edited entry is
re-pinned to its new bytes. Each case must FAIL at the check that covers it, and the two controls must PASS. The
sources live in `~/enclave-bench/ownguest-pkg/sources/`, and the tests skip without them.

`vbslike-host.exe` is the one box-only file. enclave-d1 built it on the box. It is pinned by observation and cannot be
reproduced here.

## Put it on the box (read `win/*.ps1` first: they state what they write)

```
node windows/vbslike/pkg/pkg.mjs pack windows/vbslike/pkg/manifests/nucbox-ownguest-7.json ~/enclave-bench/ownguest-pkg/out
windows/vbslike/pkg/push.sh ~/enclave-bench/ownguest-pkg/out/<id16> minipc-zt
```

`push.sh` sends only the small files, into a NEW `C:\Users\claude\vbs-like\pkg\<id16>\`. Then, on the box, with the full
id taken from the commit and not from the box:

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\vbs-like\pkg\<id16>\win\stage.ps1 -ManifestSha256 <id>
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\vbs-like\pkg\<id16>\win\check.ps1 -ManifestSha256 <id> -Fetch
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\vbs-like\pkg\<id16>\win\check.ps1 -ManifestSha256 <id> -SelfTest
```

**`stage.ps1`** does three things:
- it copies each `boxReuse` file (the IGVM, the monitor initrd, the WSL kernel, the launcher) from the box's existing
  copy, only after that copy hashes to the pin;
- it grants `S-1-5-83-0` read on the IGVM (without that grant the launch fails with 0x80070005);
- it verifies everything and writes `staged.json`.

**Environment.** From v6 on, the manager takes the runtime IDENTITY: `ENCLAVE_RUNTIME_IDENTITY` points at this
package's `guest\runtime.json`, and `check.ps1` prints it. The manager (`72c82fc6`) refuses to start with only
`ENCLAVE_RUNTIME_ID`. The env blocks printed by v1-v5 are for their own managers.

**`-Fetch`, v1-v5.** Their `check.ps1 -Fetch` let Python write `control\windows\node\__pycache__\` into the package,
so a later plain check failed for an extra file. v6 runs the fetcher with `python -B`. The stray directories were
removed from every staged package on the box.

**`check.ps1`** re-verifies the package and runs the self-test, which requires 9 cases to give their expected result.
It reports each profile's host checks as ok or `BLOCKED`, never as a package failure. `HOST CHECKS PASS` is only what
those read-only checks see: whether a profile BOOTS is shown by running it. A setting someone suspects matters, but
whose role is not established (v3: `AllowFirmwareLoadFromFile` for the igvm profile), is printed as `info` and never
gates anything. A setting MEASURED to gate a profile (v4: `AllowFirmwareLoadFromFile`, which Hyper-V names in event 5142)
is a real check: absent means `PROFILE igvm BLOCKED by AllowFirmwareLoadFromFile`. No script sets it; that is the host
owner's decision. `check.ps1` also runs the manager check on the package's manager. `-ManagerDir <dir>` runs it on
another copy too, such as the one actually running, and reports which of its files match the package's. It then prints the manager's
environment for `igvm` and the smoke command for `hcs-dev`. `-Require igvm` exits 3 when that profile is blocked.

**Limits.** None of these scripts enables a feature, changes a host setting, reboots, or writes outside the package
directory. They never touch `C:\Users\claude\vbs\node` or `\vbs\ee`.

## Boot, then serve (the box owner runs these: they start VMs)

**hcs-dev, today.** `win\smoke-hcs.ps1 -ManifestSha256 <id>` runs these steps:
1. It verifies the package.
2. It starts `vbslike-host lab` on the package's kernel and initrd. The launcher's ready line must name those two hashes.
3. It `load`s the bundle. The monitor's own hash of what arrived must be the AppID.
4. On its own TLS sessions to `127.0.0.1:<tcpPort>` it polls `/.well-known/enclave-ready` until the guest says ready for
   this app.
5. It fetches `/.well-known/enclave-attestation` for a fresh nonce. `win\judge-run.mjs` then judges the document with
   the package's judge-hv, against THAT session's certificate key, the launcher key from the ready line, and the
   `vmId` from the load answer.
6. It GETs `/` until it receives exactly the pinned bytes.
7. It requires every request to have seen ONE certificate.
8. It always ends with `destroy` + `quit`.

"Running" is ready + `monitor-signed` + the pinned answer, all on one certificate (isolation/m3/HV-GUEST.md). On this
tier, `monitor-signed` means the document is signed by the launcher in the root partition, and the host is NOT
excluded. The record goes to `runs\hcs-<utc>\` (`smoke.json`, `evidence.json`, `transcript.txt`).

**igvm.** Start the manager with the environment that `check.ps1` prints, then `POST
apps\hello-world-1.0.4\spawn.json` to `127.0.0.1:8091/vms`. The console should say `MON ready control_port=9000`.
Serving needs a datapath that loads the bundle into the IGVM guest. v2 pins enclave-5d's `datapath.mjs`, but nothing
on the box imports it yet. The package ships judge-hv, `isolation/m2/judge.mjs`, `relay/snp-verify.mjs` and
`isolation/contract/runtime.mjs` under `control/`, in the repository's own layout, so the manager's readiness judge
resolves them from `control/windows/vbslike/manager/`.

**Checking an answer from any stack.** `check.ps1 -Phase serve -Boot <profile> -Url <url> -LoadJson <launcher answer>`
ties the answer to the package: it requires the guest's own `appSha256` to equal the pinned AppID, and the answer to
equal the expected one.

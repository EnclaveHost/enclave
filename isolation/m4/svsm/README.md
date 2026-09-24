# M4b step 1: the app-naming authority, inside the measured SVSM

These are the SVSM-side sources for M4b, kept in the repo because `~/.cache/enclave-isolation/svsmkit/svsm`
is a build tree, not version control. Apply them to coconut-svsm/svsm at d37095e (with PR 1209, see
`isolation/m3/PLAN.md` section 16) and rebuild the IGVM.

| file | what |
|---|---|
| `appid.rs` | `kernel/src/protocols/appid.rs`: the new SVSM protocol (number 6). A guest at a lower VMPL supplies ONLY a 32-byte bind; the SVSM fills `report_data[32:64]` from `APP_TABLE` indexed by the CALLING PLANE. The app half is not a field of the request, so no caller can reach it. |
| `0001-wire-appid-protocol.diff` | registers the module and protocol number in `protocols/mod.rs`, adds `get_attestation_report_for_app` to `protocols/attest.rs` so there is one PSP call site, and dispatches from `requests.rs`. |

## Why this is the authority M3b lacked

`isolation/contract` says `report_data[32:64]` is the app ID "from the MONITOR's table and NEVER from the
caller". In M3a that monitor is Linux code in the guest, and on the IGVM path the guest image is **outside**
the launch measurement, so the app half was asserted by code whose identity the report did not establish
(corrected in commit 00f8c2b4). Here the authority is the SVSM, which the IGVM digest covers - and that digest
is derived with `igvmmeasure` and matched against the live signed report today (M3b, 31/31).

`APP_TABLE` is compiled in from `ENCLAVE_APP_IDS` (comma-separated 32-byte hex IDs, in plane order), so it
lands in the SVSM binary, in the IGVM, in the measurement. **Changing which app runs on which plane changes
the measurement.** That is what makes the naming trustworthy rather than merely convenient, and it needs no
new derivation path.

Refusals are fail-closed and unit-tested (`cargo test -p svsm --lib appid`, 31 tests):
VMPL0 is never an app; a plane at or beyond `VMPL_MAX` is refused; an unassigned plane is refused rather than
named with zeros, because a null identity that verified would be worse than no service.

## Admission, and the independent review that shaped it

`appid.rs` v3 does not merely NAME a plane from a compiled-in table. Before this SVSM will name a plane or
fetch a report for it, the plane must present each artifact its identity covers - the contract bundle, whose
sha256 IS the AppID, and the runtime image - and this code must have hashed those bytes itself at VMPL0, found
the digest equal to one compiled into this measured image, made the pages immutable to the owning plane with
RMPADJUST, and hashed them again. `hash, freeze, re-hash` in that order: freezing first would let a plane
freeze pages by naming them, and hashing once would leave a swap window.

An independent review (enclave-59, 2026-09-23) found real defects in v2, all fixed here:

| finding | what was wrong | now |
|---|---|---|
| A2 | every protocol-6 report was signed as **VMPL0** - `get_attestation_report_for_app` left `SnpReportRequest.vmpl` at its zero default, so a verifier pinning the plane would reject it and one that did not would lose the level | the SVSM writes the CALLER's plane into the request |
| A6 | `freeze_pages` **granted** `READ\|X_USER\|X_SUPER` to VMPL1, 2 and 3, handing every neighbour read and execute on the caller's memory | the owner keeps read (and execute only for code) and loses WRITE; every other plane is set to NONE. Nothing is ever granted |
| A6 | no ownership check on any guest GPA, so with planes `write_out` is a cross-plane write primitive and ADMIT freezes a neighbour's runtime pages (same image on every plane, so hashing first does not stop it) | **every call is refused unless it comes from `GUEST_VMPL`.** See the precondition below |
| A5 | frozen pages thaw through `SVSM_CORE_PVALIDATE` (invalidate, PSC, validate zeroes the page and restores guest RWX) while `ADMITTED` stayed set | admitted frames are recorded and `core_pvalidate_one` refuses any 4 KiB or 2 MiB entry intersecting them |
| B1 | protocol 6 was absent from `core_query_protocol`, so the "version 2 is detectable" claim was false | protocol 6 answers QUERY_PROTOCOL. The lint also caught that the first attempt was a catch-all match arm swallowing every protocol |
| B2 | the table parser silently mis-parsed: no comma became two planes, a space or semicolon dropped later planes, a short entry named a plane with a half-zero digest, a fourth entry was ignored, an odd length panicked with an index error | strict: 64 hex digits, one comma, at most three entries, or a `panic!` in a const fn - a BUILD error, which is the right outcome for an input that ends up in a launch measurement |
| B4 | a bundle was frozen with execute | data gets READ only |
| B9 | a 2-byte ELF delta between two builds was reported, against our "reproducible" claim | not reproduced here: two builds of identical source, with `appid.rs` touched to force a rebuild, gave a **byte-identical IGVM and a byte-identical ELF** and the digest `00CE1F57...` twice |

### The ownership precondition: this protocol serves ONE plane

Planes share one guest-physical address space partitioned by RMP permissions, and this SVSM cannot ask the
hardware which plane owns a page: COCONUT has no RMPQUERY and records no per-plane validated-page map. Without
that oracle a guest-supplied GPA cannot be attributed. So every call is refused unless it comes from
`GUEST_VMPL`, and with one guest plane ownership holds by construction - there is no neighbour to attribute a
page to. **A compiled-in table can NAME three planes; this code speaks for one.** Per-app planes stay
unimplemented, and that is deliberate rather than pending.

## RUN ON HARDWARE, 2026-09-23: the gate holds, and the guest has no key of its own

`isolation/m4/evidence/admit-{good,tampered,run-context}-2026-09-23.txt`. Both runs match the line sets that
were written down BEFORE them, which is the only way a pass here means anything.

The good run, in order:

| line | result |
|---|---|
| `sev_guest_no_vmpck` | **`No such device`** - the driver found no usable VMPCK and refused to probe, so this guest cannot ask the PSP for anything |
| `tsm_report_dir` | absent: no configfs-tsm report interface exists in the guest |
| `whoami_before`, `report_before` | refused, `0x80001003` (not admitted): the SVSM will not name the plane |
| `admit_bundle` | `rax_out=0x0` after staging 59829 bytes in 15 pages |
| `whoami_after_bundle` | still refused, `0x80001003`: the bundle alone is not what the identity covers |
| `admit_runtime` | `rax_out=0x0` after staging 45616736 bytes in 11137 pages, hashed twice and frozen |
| `whoami` | `ce52712f...b91`, the AppID compiled into this measured image for plane 2 |
| `report` | GRANTED |
| `admit_again` | refused, `0x80001005` (already admitted) |
| `thaw_admitted` | refused, `0x80000006` - and `thaw_unadmitted` **allowed** (`0x0`) then re-validated, so the probe demonstrably reaches PVALIDATE |
| `thaw_admitted_2m` | refused, `0x80000006`: the hook, not the alignment check |

The report was parsed rather than eyeballed: VMPL field **2**, `report_data[0:32]` the caller's bind,
`report_data[32:64]` **the AppID the SVSM holds for that plane**, and the measurement **equal to the
`igvmmeasure` digest of the shipped IGVM**. So a verifier pinning that digest knows which SVSM produced the
report, which app the plane was named, and that the plane's artifacts were hashed and frozen before it was.

The tampered run: one flipped byte, a real staging of 59829 bytes, `admit_bundle_result 0x80001004`
(digest mismatch), `admitted=0x00` afterwards, **`poke_result=WROTE`** - a refused admission froze nothing,
which is the property hash-before-freeze exists for - and `whoami_final` and `report_final` both refused.

### Two things the run cost, both worth recording

* **`FW_FILE` and `RELEASE=1`.** Every IGVM built *in the session that produced this run* came from a bare
  `make igvm`, so it carried NO firmware (3.69 MB against 4.83 MB) and could not boot a guest at all. The
  digests taken from those builds - `C97F3D6A…`, `02D647AC…`, `00CE1F57…`, `B4BA1451…` and the rest above -
  did establish that the tables are inside the measurement, reproducibly and sensitively, and that remains
  true. **They are digests of images that cannot run**, and citing them as progress toward a working boundary
  was wrong. A measurement is not evidence that anything works.

  **This does NOT apply to the earlier 31/0 M3b run** (commit 67b699af, digests `5462DDEB…` and `00DE2FCB…`).
  That run reported a derived digest equal to a **live signed report**, which a guest that never booted cannot
  produce, so its IGVM carried firmware. The mistake above was confined to the builds in this session, and the
  correction is to the over-broad sentence that first appeared here, not to that run.
* **A shared serial port loses evidence.** The first complete run dropped five consecutive result lines and
  mangled a sixth into an SVSM console message: the guest and the SVSM write the same UART with no flow
  control. `run-domain.sh EVIDENCE_SERIAL=1` now gives the guest its own port, and the guest writes results
  there as well as to the console. Nothing a harness scores may share a lossy channel.

## What clearing the VMPCK broke, and why upstream assumed otherwise

`get_report` in `kernel/src/greq/services.rs` refused every non-VMPL0 request, with the comment "Non-VMPL0
attestation reports can be requested by the guest kernel directly to the PSP". That premise is exactly what
this change invalidates: the guest has no VMPCK, so it can request nothing, and the SVSM - the only holder of
a key - was forbidden from requesting the report the guest plane needs. Protocol 6 returned
`INVALID_PARAMETER` for that reason, and protocol 1 would have too once it started naming the plane. A request
naming VMPL0 or the one guest plane this SVSM serves is now allowed and nothing else is; the level is written
by the SVSM and never taken from the request.

## The gate that WAS bypassable, and what closed it

Recorded because it was true until this change, and because the fix is what makes everything above mean
anything. The guest at VMPL2 held VMPCK2 and VMPCK3: `copy_for_vmpl` clears only `vmpck[0..vmpl]`. So the guest
did not have to ask this SVSM for anything. It mints its own report over its own GHCB, with `report_data` of its choosing and `vmpl=2` - which
is exactly what the M3 monitor does through configfs-tsm today - and a verifier sees the SVSM's measurement,
`vmpl=2` and an attacker-chosen `[32:64]` and cannot tell that apart from a report this SVSM issued after
admission.

"The SVSM will not name a plane until it has admitted the plane's artifacts" is therefore bypassed by not
asking the SVSM. Admission is a correct mechanism sitting beside an open door.

What closed it, in `SecretsPage::copy_with_no_vmpck` and measured above:

1. the guest's copy of the secrets page carries NO VMPCK at all (clear `0..VMPL_MAX` for the guest copy, not
   `0..vmpl`), so
2. `sev-guest` fails to load in the guest and configfs-tsm offers no report interface, and
3. protocol 6 becomes the ONLY path to a report, which is what makes admission a precondition rather than a
   suggestion.

Step 2 is not a side effect to paper over, and it is the open work: **it breaks how every M3a and M3b domain
gets its report**, because they use configfs-tsm. The admission guest does not need it - it talks protocol 6
directly - which is why this run was possible before the monitor was ported. The monitor's move to protocol 6
is the next increment, and until it lands the M3a and M3b suites will not pass against an IGVM built from this
SVSM.

### The invariant, stated so it is true rather than nearly true

**Every report carrying this measurement and `vmpl=N` was issued by this SVSM for plane N, and only after
plane N's artifacts were hashed and frozen.** Protocol 1 was the hole in that sentence: it is callable by an
app plane and, since it started naming the plane, would have returned such a report before anything was
admitted. Its `report_data` is SHA-512(nonce‖manifest) and cannot satisfy the contract's binding, so it was
never a forgery of an app's evidence - but "only after admission" was false as written. Protocol 1 is now
gated on `require_admitted` as well, because nothing here needs a pre-admission services report. The sentence
is now true of both protocols rather than narrowed to one.

### What a second plane requires, agreed with the reviewer

Stated jointly so neither of us discovers it later. Once app planes hold no VMPCK and protocol 6 is the only
report path, `require_owning_plane(GUEST_VMPL)` means exactly ONE plane can ever obtain a report. A second
plane cannot exist until ALL of these land together:

1. the per-plane secrets-page copy with **every** VMPCK cleared, not `0..vmpl`;
2. `requests.rs` deriving the calling VMPL from the VMSA that exited, rather than passing `GUEST_VMPL`;
3. an ownership oracle for guest GPAs - with no RMPQUERY in COCONUT, a per-plane validated-page map recorded
   in `core_pvalidate_one` keyed by the calling plane is the practical one;
4. the AP_CREATE restriction on the hypervisor side, or the SVSM as sole VMSA issuer with the kernel
   enforcing it: the planes kernel's `sev_snp_ap_creation` checks only `vmpl < VMPL_MAX` and that VMPL0 is
   replaced only by a VMPL0 vCPU, so an AP_CREATE from plane 1 targeting plane 2's APIC id is honoured and the
   SVSM is not in that path;
5. per-plane calling areas and the request-loop multiplexing that implies.

Also settled, and fixed here: the SVSM **attestation protocol (protocol 1)** stays callable by an app plane
and used to return reports signed as VMPL0. That is not a forgery of the contract's `report_data` layout, but
it breaks "every report carrying this measurement and `vmpl=N` was issued for plane N" through a door beside
the admission gate. Both of its report builders now stamp the plane the SVSM serves.

### Two costs worth naming

* Holding the PVALIDATE write lock across freeze, the second hash and the record **stalls other vCPUs'
  PVALIDATE and CREATE_VCPU for the duration of that hash** - tens of milliseconds for a 45 MiB artifact.
  Acceptable for a one-shot admission at plane start, and it is the price of closing the re-validation race.
* The staging buffers are never freed. Once frozen they are read-only to the plane for the life of the guest,
  and returning them to the allocator would hand the kernel memory it cannot write.

### Refusal codes, and the divergence from upstream COCONUT

Each refusal has its own protocol-specific code (`SvsmReqError::protocol`, so `0x80001000 + code`), because
`INVALID_REQUEST` alone covered eight different reasons and a harness could only report "refused" - which
cannot tell a finding from a bug in our own staging:

| code | refusal |
|---|---|
| `0x80001001` | the caller is not the plane this SVSM serves |
| `0x80001002` | this image names no artifact for that plane and kind |
| `0x80001003` | the plane has not admitted every artifact its identity covers |
| `0x80001004` | the bytes do not hash to the expected digest |
| `0x80001005` | that kind is already admitted for this plane |
| `0x80001006` | the freeze failed (RMPADJUST: a 2 MiB RMP entry gives FAIL_SIZEMISMATCH here) |
| `0x80001007` | the bytes changed between the first hash and the freeze |
| `0x80001008` | the admitted-page record could not be extended |

**Divergence worth recording:** both of protocol 1's report builders now stamp `GUEST_VMPL`, so an upstream
consumer of COCONUT's attestation protocol that expects VMPL0-labelled reports would see VMPL2 from this
build. The SVSM's own boot-time attestation (`kernel/src/attest.rs`) is untouched and still VMPL0.

### Scoring the run, so a pass cannot be vacuous

* the GOOD path prints no `poke_result` at all; a scorer that looks for one will wrongly fail it;
* the TAMPERED path must show `poke_result=WROTE` **and** `admit_bundle_result` carrying the SVSM's refusal,
  after a staging that really happened - a refusal over a zeroed buffer would pass for the wrong reason;
* `thaw_admitted` refused **and** `thaw_unadmitted` allowed: without the second, "refused" only shows the probe
  does not work. Score the CODES, not the words: `thaw_admitted_result` must read `rax_out=0x80000006` (the
  admitted-region hook) and `thaw_unadmitted_result` `0x0`. A `0x80000005` on the 2 MiB control means the
  alignment check refused it before the hook ran, so that control did not run at all;
* the expected good-path line set: `admit_bundle_result` and `admit_runtime_result` `rax_out=0x0`, `report
  GRANTED` with `report_hex[0x30..0x34] = 02000000` (the plane, little-endian) and a measurement equal to
  `igvmmeasure` of the launched IGVM, `admit_again_result 0x80001005`, `thaw_admitted_result 0x80000006`,
  `thaw_unadmitted_result 0x0` then a successful re-validate, `thaw_admitted_2m_result 0x80000006`;
* the expected tampered-path line set: `admit_bundle_result 0x80001004` after a staging that really happened,
  `poke_result=WROTE`, and `whoami_final` and `report_final` both refused.

## Still open, and not to be written up as done

* **A1, and it blocks plane-per-app outright.** `kernel/src/sev/secrets_page.rs` `copy_for_vmpl` clears only
  `vmpck[0..vmpl]`, so a plane keeps the VMPCKs of less privileged planes. The reviewer measured a VMPL2 guest
  minting a signed report naming **vmpl=3** with the shared measurement. With planes, plane 1 forges plane 2
  completely - its own key bound, B's AppID, vmpl=2, the SVSM's measurement - over its own GHCB, and admission
  never sees it. The fix is that app planes get NO VMPCK and protocol 6 becomes the only report path.
* **The admitted "runtime image" is the wasmtime ELF alone.** It is dynamically linked, and none of
  `ld-linux-x86-64.so.2`, `libc`, `libgcc_s` or `libm` is admitted, so the bytes that actually run include
  unadmitted code. Subsumed by A4 but worth its own line, because "the runtime image is admitted" would read
  as covering the runtime and it does not.
* **A4: admitted bytes are not bound to what EXECUTES.** The loader is the unmeasured guest kernel: it can
  present the genuine bundle and runtime, have them admitted, and execute a different copy. Closing it means
  the SVSM owning the plane's initial image and entry - loading it from compiled-in digests into pages it
  validated and froze, and creating the plane's VMSA with RIP inside them - after which KIND_RUNTIME admission
  disappears because the SVSM launched it. That is the next increment and the decision to record.
* **A7: no plane lifecycle.** `ADMITTED` is never cleared and there is no SVSM-side teardown (no scrub, no
  permission revocation, no per-plane VMSA teardown), so `contract.Lifecycle`'s "exactly one reclamation" has
  no SVSM counterpart.
* **Protocol 6 has not run on hardware.** The guest caller exists (`isolation/m4/guest/appidmod.ko` +
  `admitinit`, both building) and uses the exported `snp_issue_svsm_attest_req`, which is why the protocol
  takes a descriptor rather than RDX/R8. No admission has been performed on the machine yet.
* **B5: the runtime LABEL in `report_data[0:32]` is still the guest's word** under IGVM. Compile RuntimeID per
  plane into the SVSM and compute Bind2 here, or narrow RUNTIME.md's IGVM row.
* **B6:** if today's multi-domain monitor guest called protocol 6, every domain would be `APP_TABLE[2]`.
* **B3:** `freeze_pages` adjusts 4 KiB at a time; a 2 MiB-validated page returns FAIL_SIZEMISMATCH and fails
  admission after a partial freeze. Needs one hardware run to confirm.
* **B7:** the vTPM and UEFI-vars protocols are guest-global state and would be a cross-tenant channel once
  planes exist.

## Open in this step: the runtime identity, not only the app ID

`isolation/contract` now also binds **what compiled the app** into `report_data[0:32]` under ABI/2
(`RUNTIME.md`): the app is one portable WebAssembly component compiled inside the domain, so the runtime,
its version, its execution mode, the ISA it targets, its CPU-feature policy, its W^X statement and its
cache mode are part of what a report vouches for. The Linux domains do this today and it is verified on
hardware (M2 24/24, M3a 31/31, M4a 14/14, 2026-09-23).

**On this path that identity has the problem this whole step exists to fix.** `appid.rs` moves the app half
into the measured SVSM because, under IGVM, the guest image is outside the launch measurement. The runtime
identity is a file in that same unmeasured image, so on the IGVM path it is asserted by code whose identity
the report does not establish - the same defect, one field over.

So whoever continues this step does one of two things, and says which:

1. **compile the runtime identity into the SVSM** beside `APP_TABLE` (from the build, as `ENCLAVE_APP_IDS`
   already is) and have the SVSM compute `contract.Bind2(spki, nonce, RuntimeID(identity))` for the calling
   plane, so the binding is produced by measured code and changes the measurement when the runtime changes;
   or
2. **narrow the claim in writing** for the IGVM path: the runtime identity is the domain's own statement,
   authenticated to the transport key but not measured, and no document may describe it otherwise.

Option 1 is the one that matches what `appid.rs` already does for the app half, and it needs no new
derivation path: the digest is derived with `igvmmeasure` and matched against the live report today.

## The honest ceiling

`vmpl_count` is 4 on this hardware, so with the SVSM at VMPL0 there are **at most three app planes**: two or
three apps per guest depending on whether a separate monitor plane is kept. That is a hardware ceiling, not a
tuning parameter. Beyond it, the scalable path is M4a - one SNP guest per app - which stays supported.

## Hardware evidence for this increment (2026-09-23, planes kernel 7.2.0-gbf5bafed3e6d)

**The app table is inside a reproducible, derivable measurement.** Five IGVM builds:

| build | `ENCLAVE_APP_IDS` | launch digest |
|---|---|---|
| 1 | `aa11…,bb22…` | `5462DDEB0D727305…` |
| 2 | `aa11…,bb22…` | `5462DDEB0D727305…` |
| 3 | `aa11…,cc33…` | `00DE2FCB1D982339…` |
| 4 | `aa11…,bb22…` | `5462DDEB0D727305…` |

Same table, identical digest three times; one plane's app ID changed, a completely different digest. So
**changing which app runs on which plane changes the measurement**, and the same inputs reproduce it - which is
what makes naming by the SVSM trustworthy rather than merely convenient. Note this also contradicts the
parallel workstream's concern that an OpenSSL build stamp makes these digests per-build: for the qemu target
the build is reproducible.

**The modified SVSM boots and the boundary is unaffected.** Full M3b suite against the IGVM carrying this
protocol: **31 PASS / 0 FAIL**, with

    the expected digest was DERIVED by igvmmeasure from the launched IGVM: 5462ddeb0d7273058c…
    boundary(s1): OK confined: refused a report at VMPL0 while running at VMPL2
                  (tier=t1 vmpl=2 vmpl_floor=2 vmpl0=refused)
    launch identity: the derived digest equals the live signed report

So the authority is in measured firmware that still runs, and the digest a verifier derives now covers the
plane-to-app assignment. The kit IGVM is this build; nothing needed repinning because the harness derives the
expected digest from the IGVM it launches rather than from a recorded constant.

## What is NOT done yet

This is the authority, not the plane-per-app boundary. `kernel/src/types.rs` still has
`pub const GUEST_VMPL: usize = 2`, and `vmm/execloop.rs` does a single `switch_to_vmpl(GUEST_VMPL)`, so the
SVSM still runs exactly one guest plane. Running one app per plane additionally needs: a VMSA registered per
app plane (`register_guest_vmsa` already takes a VMPL, so the interface exists), per-plane RMP permissions and
secrets pages, and a run loop that multiplexes planes.

**Sized, not guessed: 75 call sites across 12 files assume a single guest plane.**

    GUEST_VMPL 31 · PERCPU_VMSAS 14 · guest_vmsa_ref() 9 · switch_to_vmpl 7 · guest_caa 6
    update_guest_vmsa 4 · alloc_guest_vmsa 2 · clear_guest_vmsa_if_match 2
    cpu/percpu.rs · cpu/vmsa.rs · cpu/apic.rs · sev/ghcb.rs · sev/secrets_page.rs · vmm/execloop.rs
    requests.rs · platform/snp_fw.rs · protocols/core.rs · types.rs · boot_params.rs · sev/utils.rs

`PerCpuShared` holds exactly one `guest_vmsa` with its CAA, so per-app planes means that becomes per-VMPL along
with the request loop, CAA handling, APIC routing and VMSA registration: a core refactor of COCONUT's
guest-state model rather than a bounded patch. **No architectural blocker was found** - the spec's single
`svsm_guest_vmpl` field is not a wall, because `copy_for_vmpl(vmpl)` already produces a per-plane secrets page
with lower VMPCKs cleared. The reason not to start it inside this increment is that a half-finished version
produces firmware that boots unpredictably, and the working IGVM is what M3b and M4a both depend on. `requests.rs` therefore passes `GUEST_VMPL` today; when
the SVSM runs a plane per app it passes the caller's own level, and nothing in `appid.rs` changes.

Measured on the VMM side, so it is not the blocker: QEMU accepts a **per-device** `plane=N` property (the
property is `plane`, not `irq-plane`) and an SNP guest launched with two vsock devices on planes 1 and 2 boots
the SVSM normally. Planes are only offered to SNP guests on AMD, which is why a plain-VM probe reports
"KVM plane N is not supported".

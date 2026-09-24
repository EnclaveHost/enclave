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

Refusals are fail-closed and unit-tested (`cargo test -p svsm --lib appid`, 5 tests):
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

## Still open, and not to be written up as done

* **A1, and it blocks plane-per-app outright.** `kernel/src/sev/secrets_page.rs` `copy_for_vmpl` clears only
  `vmpck[0..vmpl]`, so a plane keeps the VMPCKs of less privileged planes. The reviewer measured a VMPL2 guest
  minting a signed report naming **vmpl=3** with the shared measurement. With planes, plane 1 forges plane 2
  completely - its own key bound, B's AppID, vmpl=2, the SVSM's measurement - over its own GHCB, and admission
  never sees it. The fix is that app planes get NO VMPCK and protocol 6 becomes the only report path.
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

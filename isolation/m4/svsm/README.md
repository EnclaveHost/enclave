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

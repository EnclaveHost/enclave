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

## What is NOT done yet

This is the authority, not the plane-per-app boundary. `kernel/src/types.rs` still has
`pub const GUEST_VMPL: usize = 2`, and `vmm/execloop.rs` does a single `switch_to_vmpl(GUEST_VMPL)`, so the
SVSM still runs exactly one guest plane. Running one app per plane additionally needs: a VMSA registered per
app plane (`register_guest_vmsa` already takes a VMPL, so the interface exists), per-plane RMP permissions and
secrets pages, and a run loop that multiplexes planes. `requests.rs` therefore passes `GUEST_VMPL` today; when
the SVSM runs a plane per app it passes the caller's own level, and nothing in `appid.rs` changes.

Measured on the VMM side, so it is not the blocker: QEMU accepts a **per-device** `plane=N` property (the
property is `plane`, not `irq-plane`) and an SNP guest launched with two vsock devices on planes 1 and 2 boots
the SVSM normally. Planes are only offered to SNP guests on AMD, which is why a plain-VM probe reports
"KVM plane N is not supported".

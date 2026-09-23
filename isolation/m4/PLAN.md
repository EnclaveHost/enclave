# M4: per-app HARDWARE isolation inside the outer TEE

M3b proved a **monitor/runtime** split in hardware: COCONUT-SVSM at VMPL0, our monitor and all of its app
domains together at VMPL2, with `vmpl0=refused` and a launch digest a verifier can derive. That is not the
goal. Inside our plane, one app is still separated from another by the **guest kernel**. M4 is the milestone
where app-vs-app separation stops resting on it.

**M4a is now implemented and passing on hardware (13/13, twice) - see section 6 for the evidence. M4b is
still design.** This document is the design, the honest scaling limit, and the negative tests, which were
written before the code so they could not be softened to fit a result.

## 1. What has to be true

1. **Two apps are separated by hardware, not by the guest kernel.** A compromised app A - native code with
   A's privileges, not a polite test - cannot read B's memory, cannot reach B's socket or port, cannot obtain
   a report naming B, and cannot deny B service.
2. **The code that names an app is itself measured.** This is a new requirement, and it comes from a defect
   M3b exposed rather than from ambition: on the IGVM path the monitor image is **outside** the launch
   measurement (`isolation/m3/PLAN.md` section 16, corrected 2026-09-23). `report_data[32:64]` is the app ID
   *as the monitor states it*, so if the monitor's own identity is unestablished, a per-app claim inherits
   that. Per-app isolation without per-app identity is not worth shipping.
3. **One app bundle, one ABI, across backends.** `isolation/contract` (ABI `enclave-domain-abi/1`) is the
   agreement: `AppID = sha256(all bundle bytes)`, `report_data[0:32] = sha256(SPKI || nonce)` computed in the
   domain, `[32:64]` the monitor's app ID and never the caller's, a one-field report request, and the
   starting/running/ending/ended lifecycle with exactly one reclamation. The Linux monitor imports it; the
   Windows Hyper-V launcher mirrors it in `src/contract.rs`. M4 uses it unchanged - a second ABI for the SNP
   backend would defeat the point.
4. **Nothing verified in M1, M2, M3a or M3b regresses**, including the derived launch identity, the VMPL0
   refusal, the 31-check suite, and rollback to the previous kernel entry.

## 2. The hard limit, stated before the design

`vmpl_count = 4` on this EPYC 9115 (measured; `kvm_amd: SEV-SNP enabled ..., VMPL Levels 4`). VMPL0 is taken
by the SVSM, because that is what makes the boundary and the derivable digest work at all. So:

| shape | planes for apps | apps per guest |
|---|---|---|
| SVSM at VMPL0 **is** the monitor, apps at VMPL1/2/3 | 3 | **3** |
| SVSM at VMPL0, a separate monitor plane at VMPL1, apps at VMPL2/3 | 2 | **2** |

**Two or three apps per guest. That is the ceiling, and it is a hardware ceiling, not a tuning parameter.**
Any claim of per-app hardware isolation at scale on this platform is a claim about **one SNP guest per app**,
not about planes. Planes buy density for the first two or three apps on a host; guests buy everything above
that. M2 already priced the guest-per-app shape: 3.4 s to start, ~586 MB of host memory each, versus 5-13 ms
and no extra host memory for a domain inside an existing guest (M3a section 10).

## 3. Two shapes, and which to build first

### M4a - one SNP guest per app (buildable now, no new hardware mechanism)

Each app gets its own SEV-SNP guest: its own ASID, its own memory-encryption key, its own vCPU state. That is
the strongest separation the hardware offers, stronger than two VMPLs in one guest, and it needs no SVSM work
and no planes.

It also **closes requirement 2 for free**, which is the reason to do it first: without IGVM, `run-domain.sh`
launches with `kernel-hashes=on`, so the guest image *is* in the launch measurement and the predicted digest
moves with it - measured today, from both directions, when another session changed the monitor (the M3a
predicted digest moved to `af898e78...` and live == predicted, while the M3b derived digest did not move).
So on this path the code that names the app is measured, and one app per guest means the app itself is part
of that image.

Cost and what it is not: no VMPL boundary above the app's own kernel, so the guest kernel is still in that
app's TCB - but it is in *only* that app's TCB, which is the point. Cross-app isolation is the SNP guest
boundary.

### M4b - one plane per app inside one guest (needs SVSM work)

The architecturally right shape, and the one that matches the VBS analogy this whole line of work started
from: VTL1 is to VTL0 what the SVSM at VMPL0 is to an app at VMPL1+. The monitor's authority - loading a
bundle, computing its AppID, naming it in `report_data[32:64]`, enforcing the lifecycle - moves **into the
SVSM**, which is measured by the IGVM digest we can already derive. Apps then occupy VMPL1, 2 and 3, one
each, and app-vs-app separation is VMPL-enforced.

What it costs: implementing `isolation/contract` inside COCONUT-SVSM (Rust, in the measured image), and
teaching it to start and reclaim a guest per plane. The SVSM already manages lower VMPLs and already runs a
request loop per CPU, so this is an addition to something that exists rather than a new component - but it is
real firmware work in a measured artefact, and the digest changes with every build of it (measured: digests
are per build).

**Order: M4a first**, because it delivers cross-app hardware isolation and measured per-app identity with
mechanisms already proven on this box, and because its negative tests are the same tests M4b will need. M4b
second, for density, once the tests exist to hold it to the same standard.

## 4. The negative tests (the acceptance bar, written before the code)

Each is an attempt by a **compromised** app - native code running with that app's privileges, the `domprobe`
pattern from M3a, not a cooperative test - and each must FAIL for the right reason, with the refusal visible
in evidence rather than inferred from silence.

| # | app A attempts | must |
|---|---|---|
| N1 | read B's memory through any mapping it can construct | fail; and on SNP, A's and B's memory are encrypted under different keys, so a successful read would be a platform defect worth reporting upstream |
| N2 | connect to B's port, socket, or vsock CID | fail: refused, not merely empty |
| N3 | obtain a report whose `report_data[32:64]` names B, including by putting B's ID in its own request | fail: the naming is the monitor's, never the caller's (M3a check 10c already pins this shape) |
| N4 | obtain a report at a more privileged level than its own | fail: the `vmpl0=refused` probe, generalised - at VMPL2, level 0 AND level 1 must both refuse |
| N5 | exhaust memory or CPU so that B stops serving or stops attesting | fail: A is contained at its own share and B keeps serving AND attesting (M3a 8c/8c2 shape) |
| N6 | crash, repeatedly, and leave state behind that affects B | fail: exactly one reclamation per app however it ends, and B is byte-for-byte unaffected |
| N7 | present its own bundle as B's, or a tampered bundle as either | fail at the contract: a non-canonical manifest or a lying artifact hash is refused, and a different bundle is a different AppID |

Plus the positive property that makes the negatives meaningful: **a verifier can tell A's evidence from B's
without being told which is which** - two apps, two reports, each naming its own AppID, each bound to its own
transport key, both chaining to AMD's root, and the launch digest derivable from the shipped inputs.

## 5. What would make this NOT done

Stated now so it cannot be quietly skipped later:

- cross-app hardware isolation demonstrated for only one of the seven negatives;
- a negative that "passes" because nothing answered - silence is not a refusal, the M3a `domprobe` lesson;
- per-app identity that rests on unmeasured code (requirement 2), which is exactly the M3b gap;
- a density claim stated without the 2-or-3-apps-per-guest ceiling beside it;
- the M1/M2/M3a/M3b suites not re-run, or re-run by rechecking a stale workdir rather than live.

## 6. Status

**M4a is IMPLEMENTED and PASSES on hardware: 13 of 13 checks, twice, on the planes kernel (2026-09-23).**
`test-m4.sh`, with `build-app-guest.sh`, `build-adversary-guest.sh`, `advinit.c`, `advprobe.c` and
`judge-adv.mjs`. Evidence from the two runs:

    app A  id 8773d334...  measurement a04e011e...
    app B  id ce52712f...  measurement 1f2b30d8...      two apps, two DIFFERENT measurements
    A verdict attested, B verdict attested
    A's expectations against B's guest -> reject;  B's against A's -> reject
    adversary vsock_target=timeout, vsock_host=Connection refused
    adversary mem_devmem=Operation not permitted, mem_iomem=own-map-only,
              mem_shared_window=none -> mem_other_guest=unreachable
    adversary report: measurement=<its own>, report_data[32:64]=B's AppID -> REJECTED-ON-MEASUREMENT
    tampered bundle -> "manifest names a different artifact than it carries"

**The load-bearing result is N3b, and its proof chain is explicit after an audit.** The first judge only
PARSED the report and then called it PSP-signed, which asserted more than it proved. It now runs three steps
that must all hold: (1) the exact report verifies through the real verifier - VCEK to the pinned ARK, the VCEK
naming this chip and TCB, the reported TCB meeting the caller's floor - against the ADVERSARY's own measured
image; (2) it names B's AppID AND binds B's transport key, so it is as complete an impersonation as can be
constructed; (3) judged with B's measurement it is refused, ON the measurement. N3c adds negative fixtures -
a flipped signature byte, a measurement rewritten to B's, tampered report_data, an all-zero report, a
truncated report, a lowered TCB - so that "rejected as B" cannot mean "rejected because it was nonsense".
The adversary is native code with ROOT in its own SNP guest, and it DID mint such a report: it owns its
configfs, so nothing stops it. What it cannot forge is B's MEASUREMENT. There is no monitor in this shape, so the measurement IS the app-naming authority, and
the verifier rejects on exactly that. This is why M4a closes requirement 2 while M3b does not.

**The measurement is reproducible across runs**, better than the IGVM path: both runs produced the same
AppID *and* the same launch measurement for the same inputs, so an expected value can be derived from the
shipped bundle rather than observed once.

Mapping to section 4: N1 (memory), N2 (IPC), N3 (report identity, both halves: cross-expectation rejection
and the minted-report rejection), N5 (availability under a compromised neighbour), N6/N6b (crash
independence and reclamation), N7/N7b (bundle tamper) all pass. **N4 does not apply to M4a** and is stated
as such rather than quietly dropped: a plain SNP guest runs at VMPL0, so there is no more privileged level
in-guest to be refused. N4 is an M4b property, where the SVSM holds VMPL0 above the app.

### What M4a does NOT establish

* **Density.** One guest per app costs a guest per app: M2 measured 3.4 s to start and ~586 MB of host
  memory each. The shape that makes per-app isolation cheap is M4b, capped at 2-3 apps per guest by
  `vmpl_count=4`.
* **The M3b trust statement is still half-open.** M4a avoids the unmeasured-monitor problem by having no
  monitor. M4b re-introduces one - the SVSM - and its authority is only as good as the IGVM digest that
  measures it, which is derivable today. Moving app naming into the SVSM is the unfinished half of the
  correction in commit 00f8c2b4.
* Four rounds of failures during implementation were all in the harness, not the isolation: `fwd -vsock`
  instead of `-cid`; N2 scoring a `timeout` as a failure when a timeout IS containment working, which would
  have reported success as a breach; N6b expecting a stop record from a guest that powers itself off; and a
  missing `--min-tcb`, without which the verdict is `no-tcb-policy` and the trusted gate stays closed by
  design, so three checks failed for want of a policy rather than for want of isolation. The contract module exists and its vectors pass
(`isolation/contract`, on `windows/custom-vbs-like-hyperv`); the SNP backend imports it there and both the
M3b and plain M3a suites pass with it (31/31 each, another session's live runs). The next concrete step is **M4b** (section 3): move the app-naming authority into the SVSM so a
plane per app can carry per-app identity, within the 2-3 apps-per-guest ceiling of section 2.

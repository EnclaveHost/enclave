# metal0 rejected every per-app guest for six days (2026-11-18 to 24)

What a visitor saw: nothing directly. No ordinary app could start on metal0, and the capacity audit of 2026-11-24
failed there. Enclave RPC, a whole-VM app judged by another service, was not affected.

## What happened

- At the 2026-11-18 boot a microcode update took effect (SPL 0x75 to 0x7b), so the chip signs attestation reports
  with a different VCEK.
- That morning `collateral/metal0/refresh-vcek.sh` was written to keep two copies of the VCEK matching the chip: the
  one metal0's agent sends to the relay and the one the network agent judges whole-VM guests with.
- guestd holds a third copy, its `-vcek` default `~/.cache/enclave-isolation/m3-clean/vcek.der`, dated 2026-09-23,
  and judges every per-app guest it launches with it. Nothing refreshed it. Each guest booted, served, and was
  refused: `the guest did not attest as this app: VERDICT reject reason="VCEK signature over the report is invalid"`.
  20 guests of deployment 0x38f368d6 on 2026-11-20 and 14 of the audit job 0x3a5a64ad on 2026-11-24 are kept under
  `guestd-root/failed/`.

## How it was found

The capacity audit. With the host paying an audit job's lease gas (`ops/rpc-snp-prod-r7/control-image-audit-host-gas`),
metal0 claimed job 0x3a5a64ad at 09:48 UTC on its own gas, the first audit claim since October. Its guest was refused
four times, the supervisor gave the lease back at 09:56 (released on the host's gas too), and the audit recorded
`the guest did not answer over TLS within its lease`. The verdict is correct: on that day metal0 could not run the
work.

## What was changed (2026-11-24, about 10:20 UTC)

- guestd's copy is the verified VCEK of the chip's reported TCB (the file the relay accepted metal0's own quote with
  at 07:15 the same day); the old one is kept beside it as `vcek.der.before-ucode-7b-20261124`. guestd reads the file
  at each launch, so it was not restarted.
- `refresh-vcek.sh` keeps guestd's copy as well, at every start of `enclave-metal.service` and of the network agent.
  The script is now in the repository: `scripts/host/refresh-vcek.sh` (installed at
  `~/enclave-prod/collateral/metal0/refresh-vcek.sh`).

## Verified the same day

- The chip's current report (metal0's own attestation document) checked with the judge's own parse and signature
  check: valid under the installed VCEK, invalid under the September one ("VCEK microcode SPL 117 does not match the
  report's reported TCB 123").
- A host that failed an audit is audited again after its cooldown (main 22ca2f46b, installed 10:30 UTC). With the
  cooldown lowered for the evening, three more audit jobs ran on metal0, each claimed and released on its own gas:
  - 20:40 UTC: the guest attested and got its certificate (`guest attested`), the first per-app guest accepted on
    metal0 since the 18th. The job was then booked as failed with `reference execution failed`: the auditor's own
    reference binary was gone, its worktree having been moved on 2026-10-24.
  - 20:53 UTC: after one claim that was given back (`the relay's release list could not be read for this
    deployment`, retried five minutes later), the guest attested, the work ran and matched the reference in 10.1 s:
    **complete, verified**. The witness's receipt for metal0 names it as the last passed audit.
  - 21:05 UTC: one more job, created by the old process in its last round before the restart that restored the
    24-hour cooldown. Not waited for.
- The auditor: the reference binary has a copy beside the service (`~/enclave-prod/capacity-audit/bin/reference`, the
  2026-09-30 build of `capacity-work`, whose source is unchanged on enclave-apps main); the service refuses to start
  without it; a reference that cannot run is the auditor's fault and no longer counts against the host.

## What is left

- guestd's VCEK path is a default into a lab cache directory, not a setting of the unit.
- 0x38f368d6, the app whose guests were refused on 2026-11-20, was not looked at again.

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

## What is not verified, and what is left

- No per-app guest has been launched on metal0 since the change, so the fix is not seen working. The evidence for it
  is that it is the same chip and the same reported TCB whose quote the relay accepts with this file.
- The audit will not ask metal0 again by itself: its witness gives no capacity receipt to a host whose most recent
  paid audit failed (`availability/witness.mjs`), and without a receipt no audit is created. How a host that failed
  and was repaired gets audited again is not decided.
- guestd's VCEK path is a default into a lab cache directory, not a setting of the unit.

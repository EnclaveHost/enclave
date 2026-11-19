# Resizing a whole-VM app's share in place (prepared 2026-11-19; not on metal0)

Status: **source and tests only.** metal0 runs 2c9e322 (`../control-image-wholevm-share/`), which does not have this.

## Why

Enclave RPC holds 100% of metal0 on the ledger and needs 50% (8 vCPUs, 48 GiB of a 24 vCPU, 96 GiB pool), so metal0
advertises no CPU. Lowering it is the owner's `setShares`. On the running image a share change takes the ordinary
switch path: stop the instance, swap the slice, relaunch, and release the lease when the new slice is judged not to
fit. For this app that is a stop of the 48 GiB guest, and a release can meet the gas reserve's 30-minute claim
cooldown (2026-11-14: 40 minutes away).

## What changes (main, with tests)

- `snpVmResize`: a share change on a whole-VM app, with the version unchanged, is booked in place. The VM's size is
  its version's, so only the node's booking and the ledger's rate move: nothing is stopped, the lease is never handed
  back. A dial below what the VM takes books what it takes; a grow the node has no room for leaves the VM on the
  share it held and is asked again at the next audit pass. A share change together with a version change takes the
  ordinary path as before.
- the ordinary resize judges the new slice against the share ledger the instance's own release just credited
  (`heldReservation`), not against a shielded card's proven free memory, which lags the stop. This is the likely
  cause of the 2026-10-16 release of eyesoff on a shrink; it was not reproduced. An ordinary app is still relaunched
  on a resize: its guest's memory is sized by its share.

`supervisor-delta.py` applies the same text to the supervisor of 2c9e322 (checked: applies, `node --check` clean).

## Rolling it out, and the resize

1. Build the image as `../control-image-wholevm-share/README.md` describes, from `~/.cache/metal0-gen/repo` (the
   running generation) plus this delta, with the running image as the base; compare the two images entry by entry
   and measure.
2. Apply it with that directory's script adapted to the new image (allowlist, restart of `enclave-metal.service`,
   rollback): the RPC VM is adopted in place, as on the last three restarts.
3. The owner signs `setShares(0x5ff56a4d…454f, 0, 500)`. Within one audit pass the supervisor logs
   `owner changed shares: cpuMilli 1000 -> 500; a whole VM, booked at cpuShare 0.5 in place, the VM keeps running`
   and metal0 advertises up to 50% CPU again, capped by the host's free memory.

Signing before step 2 stops the VM.

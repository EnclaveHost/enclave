# metal0 control image 3dd10e9: a whole-VM app's share is resized in place

Status: **active on metal0 since 2026-11-19 06:50:45Z**; see "The run". The resize itself has not happened: the
owner's `setShares` is staged unsigned.

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

## The image

`/home/steven/enclave-prod/dist-snpvm-3dd10e9`

| | 2c9e322 (before) | 3dd10e9 |
|---|---|---|
| initramfs sha256 | b695826538961e4d8c6558515f800c2c773aa10a1d4458bd1da82be1d36b2956 | f408f6d13c24dc1edecaea2a7a5b1808f15110d173a539a5d544788a6e3520b0 |
| launch measurement | bf4e7c7571b57d5f92db4c85a2e98db6d7c71ea532464596cb21555965ad0b25b4ae2fffb2055051c1e239209b8f7a73 | 2dd2450afd724c0f95df1c48e40cea08077bfc7ce607b254991b35f1964221b294b7cf0bc842bcbb43530ffd8aadb1b1 |

Built in `~/.cache/metal0-gen/repo` (the running generation, commit 3dd10e9 = 2c9e322 plus the delta) with the
running image as the base. Compared entry by entry (29,065 each): `/app/supervisor.js` (baf63e28…97a3 to
77b40c9b…114a) and the image's own manifest; nothing added or removed; kernel and command line the same files. The
measurement command reproduces 2c9e322's accepted value and gives the new one.

## The run (2026-11-19, UTC)

`control-image.sh apply`:

- 06:50:33 operator key 9.31e-4 ETH, lease in hand 15 minutes, app answering 200; the relay's allowlist got the
  measurement (45 listed, previous file kept as `linux-leasegas-measurements.env.before-snpvm-3dd10e9`), relay
  restarted.
- 06:50:45 `enclave-metal.service` restarted on the image (config kept as `config.json.before-snpvm-3dd10e9`);
  06:51:05 accepted on `2dd2450a…`, admitted, registered.
- the supervisor adopted VM `svc5c9c7e782de8357` (not restarted): `adopted: app=enclave-rpc:1.4.1 … cpuShare=1`.
- 07:02 the first renewal on the image: lease until 07:32:04; the app answers 200.

## The resize

The owner signed `setShares(0x5ff56a4d…454f, 0, 500)` (`~/enclave-prod/enclave-rpc-shares-50/trezor-send.sh`), block
59711167, 2026-11-19 23:56:49 UTC. Eleven seconds later the supervisor logged
`owner changed shares: cpuMilli 1000 -> 500; a whole VM, booked at cpuShare 0.5 in place, the VM keeps running`.
The VM's process is the one started 40 hours before (no stop, no release, no new claim) and the app answers 200.
This was the first in-place resize on the live box.

metal0's `/availability` after it: `cpuShareFree 0.21`, `usedCpuShare 0.79`, 5 vCPUs and 20.2 GB free. The share
ledger has 50% free; the advertised figure is the smaller of that and what the host's free memory allows.

Rollback of the image: `control-image.sh rollback`.

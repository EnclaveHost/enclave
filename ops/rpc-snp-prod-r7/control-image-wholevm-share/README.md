# metal0 control image 2c9e322: a whole-VM app holds its CPU share

Status: **active on metal0 since 2026-11-19 06:17:34Z**; see "The run".

## Why

On 2026-11-19 the console showed Enclave RPC (`0x5ff56a4d…454f`) holding "100% TEE CPU" on metal0 beside a metal0
that advertised 18% CPU available. Both were what the code produced:

- the row's 100% is the ledger share (`cpuMilli` 1000);
- the supervisor claimed a whole-VM app with a zero CPU slice (51b949df5), so its own share ledger held nothing for
  it, and `/availability` took the manager's figure: host `MemAvailable` above the 18 GiB floor over the 96 GiB
  pool (guestd held no guest: `allocated` 0).

The VM is 8 vCPUs and 49152 MiB of the host's own cores and RAM, half of the pool (96 GiB, 24 vCPUs).

## What changes

`supervisor-delta.py` applies main's hooks (61e620be9 and the commit that carries this directory, text taken from
`metal/snpvm-supervisor-patch.py`) to the supervisor of 7baabe2:

- a whole VM's claim takes a CPU share: what its owner dialed, or what the VM needs of the node if that is more
  (`snpVmSlice`); sized only against the manager's pool once that pool is heard;
- a new whole VM is refused when the share ledger has no room; a resume is never given up, it takes what is free and
  the pool reconciler raises it to its due share;
- `/availability` states no more CPU share than the supervisor's own ledger has left, the figure its claim gate
  refuses against.

Checked on the deployed generation: `node --check` clean; its own `POOL_SELFTEST` books the RPC record at 100%
(`whole VM 0x5ff56a4d share 0->1`, free 0, second pass a no-op).

## The image

`/home/steven/enclave-prod/dist-snpvm-2c9e322`

| | 7baabe2 (before) | 2c9e322 |
|---|---|---|
| initramfs sha256 | 565013a883e18db4539f656e266a8ef9851e2933ee96e5d820e60145891e42c2 | b695826538961e4d8c6558515f800c2c773aa10a1d4458bd1da82be1d36b2956 |
| launch measurement | 6fac97810228e0dfd3dee933cde28005ab9fe0383bc9ba109d85b1595e210a801f3b0e211ac928c360ab5e324731c19e | bf4e7c7571b57d5f92db4c85a2e98db6d7c71ea532464596cb21555965ad0b25b4ae2fffb2055051c1e239209b8f7a73 |

Compared entry by entry (29,065 entries each, name, mode, owner, size, sha256): `/app/supervisor.js`
(bfd8a170…2ae4 to baf63e28…97a3) and the image's own `/opt/metal/manifest.json`; nothing added or removed. Kernel
and command line are the same files. The measurement command of `../control-image-66335ab/README.md` reproduces
7baabe2's accepted value and gives the new one.

The scratch clone of the earlier images no longer exists. This one was built from a repository made of the running
image's own `/app` (without `node_modules`) and `/opt/metal` trees at their source paths, one commit as installed
and one with the delta (2c9e322), with the running image as the base:

    python3 metal/overlay-control-image.py ~/enclave-prod/dist-snpvm-7baabe2 ~/enclave-prod/dist-snpvm-2c9e322 HEAD

## The run (2026-11-19, UTC)

`control-image.sh apply`:

- 06:17:21 operator key 9.32e-4 ETH; lease in hand 23 minutes; app answering 200.
- 06:17:2x the relay's allowlist got the measurement (44 listed, previous file kept as
  `linux-leasegas-measurements.env.before-snpvm-2c9e322`), relay restarted.
- 06:17:34 `enclave-metal.service` restarted on the image (config kept as `config.json.before-snpvm-2c9e322`);
  06:17:54 the relay accepted `bf4e7c75…`, metal0 admitted and registered.
- the supervisor resumed its lease, adopted VM `svc5c9c7e782de8357` (not restarted) and logged
  `adopted: app=enclave-rpc:1.4.1 … gpuShare=0 cpuShare=1`. The share was taken by the resume itself, so the
  reconciler had nothing to raise and the script's last check, which waits for the reconciler's line, does not apply.
- 06:21:55 the relay's host table: metal0 `cpuShareFree` 0, `usedCpuShare` 1, `gpuShareFree` 1; the app answers 200.
- 06:35:5x the first renewal on the new image: lease until 07:05:53; no checkpoints posted (free lease), as before.

## What follows from it

- metal0 advertises no CPU and claims no CPU work while the deployment holds 100%. A GPU app needs a CPU share too,
  so metal0 takes none of those either, although it still advertises its cards.
- The VM needs 50%. Lowering the share is the owner's `setShares`. On this tier a resize is not done in place: the
  supervisor stops the instance and, when the new size is judged not to fit, releases the lease and claims again
  (2026-10-16, eyesoff). For this app that means stopping the 48 GiB guest, and a claim inside the gas reserve's
  30-minute claim cooldown is refused (2026-11-14: 40 minutes away). It should not be signed before the resize path
  credits the app's own reservation.

Rollback: `control-image.sh rollback` (the previous image, whose measurement stays listed).

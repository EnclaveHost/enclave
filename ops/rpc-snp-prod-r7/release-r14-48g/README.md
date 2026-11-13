# Enclave RPC 1.4.1: image r14 in a 48 GiB guest

Status: **in production since 2026-11-13 16:30:13Z** (written 18:30Z). The owner signed publish, stop and start
between 16:26Z and 16:29Z, before the day-later reading this file asked for. Two hours in, the guest runs with
49152 MiB, all three clients are at head and nothing was killed. Whether 48 GiB holds over a day is **not yet
known**: the anonymous memory of a new boot is still rising, and at 64 GiB it was still creeping up after 13 hours.
The sections from "What it is" down are the preparation as written at 06:50Z, kept as they were; where the run
showed them wrong it is said here.

## The run (2026-11-13)

| Z | |
|---|---|
| 16:21:07 | `run-cutover.sh`: reading of the 64 GiB guest (`MEMORY-1621Z.json`, `HEALTH-1621Z.json`) |
| 16:26:44 | publish version 6: `0x1c9b1e48d492b254928707f847f4f9c8f5e736096e8c3e16d882c858ff9b7724` (Base block 56984145) |
| 16:27:08 | stop: `0x08fd352a100c6650ebb5b825c063e73b4486f72cb0efec29baa52f0a5d06b5f5` (56984268) |
| 16:27:55 | metal0: "stopped by owner on-chain", guest torn down; public Ethereum stops here |
| 16:28:38 | metal0's release of the lease landed (`0x06eb2976…`) |
| 16:29:09 | start on `catalog://0x0f62…b537/6`: `0xada0d998457f4c1d44b14bb7d2920a49638d4ff54cfdb94ed545400fce85daef` (56984872) |
| 16:30:10 | metal0's claim landed (`0x76fe1497…`) |
| 16:30:13 | metal0: `launching (8 vCPU, 49152 MiB, …/6)`; qemu runs with `-m 49152`; adopted as `enclave-rpc:1.4.1` |
| 16:33:11 | `finish.sh` moved the gateway to `versionIndex` 6 (`.pre-1.4.1` kept) and restarted it |
| 16:36:49 | the gateway marks the guest's Base fresh again |

All three owner transactions have status 1. The catalog-to-qemu path for the size ("read in source, not exercised"
below) is now exercised: version 6's `res[2]` reached qemu as 49152 with no change on the host.

Outage: public Ethereum from 16:27:55Z until the gateway was on version 6, 16:33Z or shortly after, so **about
five to six minutes; the minute it answered again is not on record** (the terminal's output of `finish.sh` was not
kept, and the gateway only logs an upstream's freshness when a request probes it: its "Ethereum fresh" line is
from 18:13:20Z, my first request). The 21 minutes expected below did not happen: the owner signed stop and start
two minutes apart. Base in the guest was back within the gateway's lag limit at 16:36:49Z, 9 minutes after the
stop (expected: 40).

Checked at 18:13Z to 18:20Z: signing page `/status` publish, stop and start done, deployment active and leased;
route record on `/6`; `https://5ff56a4d.app.enclave.host/` 200; the gateway answers `eth_blockNumber` on
`/rpc/ethereum` and `/rpc/base`; lease renewed every period; reth not syncing, Lighthouse `sync_distance` 0, Base
not syncing. The two signing-page units (`enclave-rpc-owner-sign-r14-48g`, and r13's, left over) are stopped.

Not looked into: metal0 logs `[isolation] 0x5ff56a4d: no certificate for 5ff56a4d.app.enclave.host (guestd
answered 404 for the instance); retry in 3600s` at 16:30:55Z and 17:30:55Z, while the address answers 200 with its
certificate and the route record carries `certNotAfter`.

## Measured: the 64 GiB guest before the move, the 48 GiB guest after

| GiB | 64 GiB, 16:21Z (13 h 27 min up) | 48 GiB, 18:17Z (1 h 47 min up) | estimated below for 48 |
|---|---|---|---|
| MemTotal | 61.84 | 46.09 | ≈ 46.3 |
| clients' slice held / held to | 55.65 / 55.66 | 41.48 / 41.49 | ≈ 41.6 |
| slice hard limit | 58.13 | 43.33 | ≈ 43.5 |
| anonymous, all clients | 14.38 | 11.97, rising | "at least 13.28" |
| reth: anonymous / held | 4.19 / 18.15 | 2.84 / 5.51 | |
| Lighthouse: anonymous / held | 5.29 / 16.84 | 4.87 / 6.64 | |
| Base: anonymous / held | 4.89 / **20.66** | 4.25 / 29.34 | ≈ 28.4 held |
| page cache, all clients / Base | 36.28 / 12.32 | 24.45 / 20.84 | |
| Base: taken back MB/s, read back | 42.7, 3.4 (06:42Z to 16:21Z) | 40.5, 3.1 (18:13Z to 18:17Z) | |
| Base: read back of taken, whole boot | 7.8% | 6.0% | |
| stall on memory, slice, 5 min | 0.2% | 0.13% | |
| killed at a limit (`oom`, `oom_kill`) | 0 | 0 | |
| newest block old, s: Ethereum, Base | 8, 0 | 10, 0 | |

`MEMORY-1817Z.json`, `HEALTH-1817Z.json`; two more readings at 18:13Z are in the host's readings directory.

What the 16:21Z reading says that the sizing below did not expect: at 64 GiB **Base was following the chain at
head while holding 20.7 GiB**, because reth and Lighthouse had filled 35 GiB between them, 25.5 of it page cache.
The condition below ("reth and Lighthouse at or below about 13.5 GiB") was not met, and Base was fine. So the
model "Base gets what the other two leave, and needs about 28 GiB" was too simple in both halves: the other two
take much more cache when it is there, and Base keeps up on much less than 28 GiB (how much less is not measured).

The anonymous memory at 64 GiB, half-hourly from the probe: 13.25 at 06:54Z, 13.67 at 08:54Z, 13.67 at 10:54Z,
13.88 at 12:54Z, 14.51 at 14:54Z, 14.50 at 15:54Z. That is about +0.14 GiB an hour over nine hours: slow, **not
flat**. The 48 GiB guest runs the same processes; its own curve so far: 9.63 at 17:00Z, 10.92 at 17:30Z, 11.53 at
18:00Z, 11.97 at 18:17Z.

## What the host got back

The guest's unit on the host (`enclave-rpc-snp-guest.service`, cgroup `memory.stat` at 18:20Z): 79.3 GiB charged,
of which **46.37 GiB cannot be taken back** (`unevictable`: the guest's own memory, already nearly all of its
48 GiB) and about 30 GiB is the host's page cache for the disk images (`inactive_file`), which the host drops when
it needs the memory. Before the move the guest's own part was about 60 GiB of 64 and still filling (61.84 MemTotal
less 2.76 never used at 16:21Z, plus the kernel's share). So **about 14 GiB less is pinned now, and 16 GiB less
than the 64 GiB guest would have reached**. The unit's total charge barely moved (77.9 GiB at 06:40Z) because the
page cache fills what is free; the figure to read is the host's MemAvailable: 28.3 GiB at 06:40Z, **50.7 GiB at
18:20Z**, of 124.8.

## Still not known, and the reading that settles it

- where the anonymous memory stops in this boot (15 to 16 GiB would leave about 26 GiB of page cache in the slice);
- whether Base stays at head once reth and Lighthouse have taken their page cache inside a 41.5 GiB slice (they
  held 5.5 and 6.6 GiB at 18:17Z against 18.2 and 16.8 at 64 GiB);
- the read-back share over a day.

One reading about a day after the start (2026-11-14 16:30Z) answers these: the commands under "Before signing".
Signs that it is too small and the way back are in the last section; the way back is still not scripted and not
exercised.

## What it is

The same image as 1.4.0 (`/vm/enclave-volumes/rpc-snp-image-r14`, root hash `d0b6040a…1a58`, 8-vCPU measurement
`aa1807f5…42e0`, source 25dbcf4d6) under a catalog version that gives the guest 49152 MiB instead of 65536. The
guest's size is not in the SNP measurement (r14's SNP smoke boot ran at 8 GiB with the same measurement), so no
image is built, no relay allowlist changes and the local proxy's pin stays as it is.

| | 1.4.0 (live) | 1.4.1 (this) |
|---|---|---|
| catalog version index | 5 | 6 |
| `res` | `[0,0,65536,0]` | `[0,0,49152,0]` |
| manifest | `bafkreiepolr6ew…g2xma` | `bafkreieeaqac6xmtav77pelmaemtbn4eobtdn3ax7ru4d74knq7cchqjv4`, sha256 `8404002f…09af`, pinned on this host's IPFS |
| image, measurement, runner, media, limits | the same | the same |

`release.json` differs from 1.4.0's in `cid`, `journal`, `res` and `version` only; `RELEASE-MANIFEST.json` in
`launch.memoryMiB` and `version`.

How it was made (another size is the same three commands with another `--mem-mib` and version label):

    python3 -I rpc/snp/release.py /vm/enclave-volumes/rpc-snp-image-r14 /vm/enclave-volumes/rpc-snp-release-r14-48g \
        --version 1.4.1 --vcpus 8 --mem-mib 49152 --media MEDIA.json --runner 0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB \
        --enclave-id 0x4dde6d1b…68be --journal ~/.local/share/enclave-rpc-snp/owner-sign-journal-r14-48g.jsonl \
        --commit 25dbcf4d670846b2d18dbbea882cf32f633ca50b          # MEDIA.json: config._media of 1.4.0's release.json
    ipfs add -Q --cid-version=1 --pin=true RELEASE-MANIFEST.json     # the CID goes into release.json
    node rpc/snp/owner-sign/upgrade-plan.mjs release.json 0x5ff56a4d…454f ~/.config/enclave/snpvm.json PLAN.json

`PLAN.json`: publish version 6, stop the deployment, start it on `catalog://0x0f62…b537/6`. The publish was
simulated from the owner and succeeds; stop and start were `eth_call`ed. Nothing was sent.
The plan's `lead` (the text under the page's title) has one sentence put in front by hand: not to be signed before
the reading. The signing page is up at http://127.0.0.1:42295 since 06:52Z (`/status`: publish offered, stop and
start blocked on "version 6 is not published yet", journal empty).

## Why nothing on the host changes

The size reaches qemu from the chain: catalog version `res[2]` → the metal supervisor's `min.memMb` →
`rpc/snp/vm-manager.mjs` `plan.memMiB` → `launch.py -m`. The manager's binding (`~/.config/enclave/snpvm.json`)
names the image, run directory, disks and ports and no memory, so it stays as it is, and so do the proxy unit and
the guest's run directory. This path was read in source, not exercised with a second size on this deployment:
`finish.sh` reads the running qemu's `-m` after the start and stops with nothing else changed if it is not 49152.

Inside the guest every limit is a share of what the guest sees, so they follow by themselves.

## What 48 GiB gives the clients

The kernel keeps part of the guest for itself: MemTotal was 61.84 GiB of 65536 MiB and 7.31 GiB of 8192 MiB. On a
straight line between those, 49152 MiB gives about 46.3 GiB (estimated, not measured at this size).

| GiB | 64 GiB guest, measured 06:40Z | 48 GiB guest, estimated |
|---|---|---|
| MemTotal | 61.84 | ≈ 46.3 |
| clients' slice, held to (90%) | 55.66 | ≈ 41.6 |
| clients' slice, hard limit (94%) | 58.13 | ≈ 43.5 |
| Base hard limit (75%) | 46.38 | ≈ 34.7 |
| reth and Lighthouse hard limit each (45%) | 27.83 | ≈ 20.8 |
| anonymous memory, all three clients | 13.28 and rising | the same processes: at least that |
| page cache left for all three under the slice | 36.63 | ≈ 28.3, less by whatever anonymous memory still adds |
| Base in total, with reth and Lighthouse at today's 13.2 | 42.44 | ≈ 28.4 |

Base followed the chain on r13 inside 30 GiB (limit 30/32 GiB), so about 28 GiB is close to a size that is known
to work and below it. An earlier note of mine put Base at about 30 GiB under 48 GiB; that assumed reth and
Lighthouse at 12 GiB, and they held 13.2 at 06:40Z.

What the host gets back: the guest can pin at most 49152 MiB instead of 65536, so **at most 16 GiB**. The host
charged the guest's unit 77.9 GiB at 06:40Z (pinned guest memory plus the host's own page cache for the Base disk,
which the host can take back). Inside the guest 3.64 GiB had never been used at that time, so about 60 of the
64 GiB were pinned and the rest will follow.

## The reading at 06:40Z (3 h 46 min after the start)

`MEMORY-0637Z.json`, `MEMORY-0639Z.json`, `HEALTH-0639Z.json`; all three clients at head (newest Ethereum block
7 to 9 s old, Base 0 s).

| GiB | all clients | reth | Lighthouse | Base |
|---|---|---|---|---|
| held | 55.64 (on its 55.66) | 6.95 | 6.24 | 42.44 |
| anonymous | 13.28 | 3.48 | 5.06 | 4.74 |
| page cache | 36.63 | | | 32.84 (28.52 mapped) |
| page cache taken back, MB/s | | 3.2 to 4.0 | | 34.7 to 47.5 |
| read back after being taken, MB/s | | 0.3 to 1.7 | | 2.6 to 3.3 (about 7%) |

Stall on memory for the slice: 0.15% over five minutes. Logs in guest memory: 269 to 295 MB (capped).

The slice's anonymous memory, from the probe's half-hourly samples inside `/memory` (kept 48 h):

| 03:24 | 03:54 | 04:24 | 04:54 | 05:24 | 05:54 | 06:24 | 06:40 |
|---|---|---|---|---|---|---|---|
| 9.23 | 11.32 | 10.25 | 11.85 | 12.38 | 12.97 | 13.26 | 13.28 |

That is +0.75 GiB an hour over the last two hours on record, slowing (about +1.1 over the three hours before).
Per client between 03:26 and 06:40: reth +0.42 GiB/h, Lighthouse +0.15, Base +0.55.

## What is not known

- **Where the anonymous memory stops.** It cannot be reclaimed (the guest has no swap), so it is the floor, and
  every GiB of it comes out of Base's page cache in a smaller guest. Four hours of a new boot do not show the level.
- **How much page cache Base needs to follow the chain at 48 GiB.** The probe does not measure it while Base turns
  its cache over (see `../release-r14/README.md`). The one data point is r13: 30 GiB was enough. Today Base re-reads
  about 7% of what is taken from it with 32.8 GiB of cache; with less cache that share rises, by how much is not
  measured.
- MemTotal at 49152 MiB (estimated above).

### Before signing

(As written at 06:50Z. The owner signed at 16:26Z without this reading; conditions 2 and 3 held at 16:21Z, condition 1
did not: the anonymous memory was still rising slowly, and reth and Lighthouse held 35 GiB, not 13.5.)

Take a reading about a day after the start (2026-11-13 02:54Z) and sign only if all of these hold:

1. the slice's anonymous memory is flat over the last six hours (the growth line of `memtrend.py`, within
   ±0.1 GiB an hour), and its level leaves Base at least about 28 GiB under a 41.6 GiB slice, that is: anonymous
   memory of reth and Lighthouse plus their page cache at or below about 13.5 GiB;
2. reth, Lighthouse and Base are at head in every reading;
3. Base's read-back share has not risen above today's (about 7% of what is taken).

If the anonymous memory settles higher, make the version at a larger size instead (52 GiB: MemTotal ≈ 50.1, slice
≈ 45.1, Base ≈ 31.9 with reth and Lighthouse at 13.2) with the three commands above; it takes about five minutes
and replaces this plan before anything is published.

    bash /vm/enclave-volumes/rpc-snp-release-r14-48g/reading.sh /vm/enclave-volumes/rpc-snp-release-r14-48g/readings
    python3 -I rpc/snp/memtrend.py /vm/enclave-volumes/rpc-snp-release-r14-48g/readings

`reading.sh` stores one `/memory` and one `/health` answer under the time it was taken; `rpc/snp/memtrend.py`
prints the stored readings as a table, the probe's half-hourly samples from the newest one and the growth of the
anonymous memory. No timer takes readings: one reading a day later carries the slice's curve in the probe's
samples (the per-client split exists only for the times a reading was stored).

## The move (the operator's, after the reading)

    bash /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/rpc-snp-prod-r7/release-r14-48g/run-cutover.sh

It takes a reading and prints it, starts the signing page at http://127.0.0.1:42295 (unit
`enclave-rpc-owner-sign-r14-48g`) if it is not up, and waits. The owner signs publish, stop and start there. Then
`finish.sh`: waits for metal0 to lease and launch, checks the guest was launched with 49152 MiB, waits for the
local proxy, moves the gateway's `versionIndex` from 5 to 6 on the control VM (the old file is kept beside it as
`.pre-1.4.1`), checks the route record, the reconciler and the app address, and prints the guest's memory.

Expected outage, from 1.4.0's run on the same chain disks: public Ethereum about 21 minutes (17 of them were the
wait for the start signature), Base inside the guest about 40 minutes until it is back at head; public Base stays
on the providers while the guest's is behind (the gateway's `maxLag`).

## If it is too small

Signs: Base falls behind head and stays there, the read-back rate climbs, or a client is killed at its limit (the
unit restarts; `/health` and `/logs/base` show it). Public Base keeps answering from the providers meanwhile.

The way back is a second owner-signed stop and start on version 5 (which stays published) with a second outage of
the same length, and the gateway's `versionIndex` back to 5 from the `.pre-1.4.1` copy:

    node rpc/snp/owner-sign/upgrade-plan.mjs ops/rpc-snp-prod-r7/release-r14/release.json 0x5ff56a4d…454f \
        ~/.config/enclave/snpvm.json BACK-PLAN.json 5

This is **not scripted and not exercised**.

# Enclave RPC 1.4.1: image r14 in a 48 GiB guest

Status: **prepared, not published, not live** (2026-11-13 06:50Z). Production is 1.4.0 (catalog version index 5,
64 GiB), unchanged by anything here. The owner has signed nothing for 1.4.1. Whether 48 GiB is the right size is
**not yet known**: the guest's anonymous memory was still rising four hours after its start (see "What is not
known"). The move is to be signed only after a reading about a day after the start says it holds.

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

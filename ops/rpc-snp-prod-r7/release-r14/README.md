# Enclave RPC r14 (1.4.0): memory the guest was not asked for

Status: **built and qualified, NOT live** (2026-11-13 02:20Z). Production is r13 (1.3.0, catalog version 4). r14
goes live when the operator runs `run-cutover.sh` and the owner signs the three steps of `PLAN.json`; the move is
a stop and a start of the guest, so an outage of Enclave RPC.

## What was measured on r13 (2026-11-12)

The guest is given 64 GiB by its catalog version (`res [0,0,65536,0]` → the manager's `plan.memMiB` → `launch.py
-m`). It is an SEV-SNP guest with no balloon and no swap: every page it has touched stays pinned on the host.

| | |
|---|---|
| host memory charged to the guest's unit | 82.84 GiB: about 61 GiB pinned guest memory and about 18 GiB of the host's own page cache for the Base disk (`cache=writeback`), which the host can take back |
| guest root | dm-verity, read-only, with a tmpfs overlay: every file the guest writes outside the chain disks is guest memory |
| Base's log | about 1,243 MB of text a day, kept twice: in the journal (cap 10% of the overlay) and again by rsyslog in `/var/log/syslog` (weekly rotation). Estimated about 20 GiB of memory that cannot be reclaimed after two weeks (derived from the rate, not observed) |
| stock Ubuntu services | 16 services running at idle, among them unattended-upgrades, ModemManager, polkit and rsyslog, and timers for apt, fwupd, snap repair and motd: nothing a sealed, read-only guest can use |
| client limits | bytes sized for 64 GiB (el 11/12, cl 10/11, base 30/32, slice 58/60 GiB): a smaller guest would have limits above its memory |
| telemetry | none: the clients fill their limit with page cache, so from outside nobody can tell what they need |

## What r14 changes (main 25dbcf4d6)

- The journal is capped at 256 MB and no longer copied to syslog; Base logs to its own journal (namespace `base`,
  256 MB) so its volume cannot push the other units' lines out. The front's `/logs/*` reads both.
- 39 stock units are masked (`MASKED_UNITS` in `rpc/snp/build_image.py`).
- Limits are shares of whatever the guest is given: clients' slice `MemoryHigh=90%`, `MemoryMax=94%`; per client
  only a `MemoryMax` (el 45%, cl 45%, base 75%). The guest's size is not in the SNP measurement, so the same
  image runs at any size the catalog version names.
- `GET /memory` on the guest's local name only (not the app address): meminfo, pressure, the three groups, the
  overlay's trees, the probe.
- `enclave-rpc-memprobe.service`: for 48 hours after the clients start it asks the kernel, once a minute and only
  while the clients' slice is quiet (memory pressure below 0.1%), to take back 0.2% of what the slice holds. It
  sets no limit and stops nothing. Where it holds is the clients' working set.

The chain clients, their versions, flags and data layout are r13's (only `build_image.py`, `front.py` and the new
`memprobe.py` differ in the image's sources).

## Measured before and after

Same rig for both images (`rpc/snp/kvm_check.py`: plain KVM, 8 GiB guest, no chain disks), same flood of 2,000,000
log lines (about 380 MB) into each journal. `KVM-BASELINE-r13.json`, `KVM-CHECK-r14.json`.

| | r13 | r14 |
|---|---|---|
| running services at idle | 16 | 13 |
| sum of resident memory at idle | 195,692 kB | 157,244 kB |
| journals after the flood | 387 MB + 387 MB | 253 MB + 259 MB (at their caps) |
| `/var/log/syslog` after the flood | 536,684,887 bytes | unchanged (188,502 bytes) |
| overlay (guest memory) after the flood | 1,286 MB | 512 MB |
| the 39 stock units | none masked, 20 active | all masked, none active |

On r13 the overlay keeps growing with every day of logs until the journal's 10% and the weekly syslog rotation
bound it; on r14 it stops at the two caps.

## Qualification

- Plain KVM: 10 of 10 checks (`KVM-CHECK-r14.json`), kept as a test (`test/fixtures/rpc-snp/r14-check.txt`,
  `test/rpc-snp/test_kvm_check.py`).
- SEV-SNP boot on a scratch deployment id with empty scratch chain disks (`/vm/enclave-volumes/rpc-snp-smoke-r14`,
  2026-11-13 02:10:40Z to 02:12:46Z, since stopped): the live report's measurement equals the offline one
  (`aa1807f5…42e0`); the repository's verifier accepts it and `/health` answers 200; with r13's measurement or
  another deployment it refuses; `/memory` 200 on the local name, 404 on the app name and by address; slice limits
  7,061,762,048 / 7,375,618,048 of 7,846,404,096 (90% / 94%); `/logs/base|el|cl|front` 200 (`SNP-SMOKE-memory.json`).
- Not exercised: the three clients on the real chain disks under r14 (on empty disks they do not start, as in
  r13's smoke boot), and the probe against a loaded slice of real clients. Both first run at the cutover.

## Records

| | |
|---|---|
| image | `/vm/enclave-volumes/rpc-snp-image-r14`, root hash `d0b6040a…1a58`, kernel 6.8.0-147 (`IMAGE-r14.json`) |
| launch measurement, 8 vCPU | `aa1807f53d8d9e0eaca69289be7125545cf2dbc1744009b9624e703c5a24c5aa5e03d67be92d5436c20e18cb0fba42e0` |
| release | `release.json`, `RELEASE-MANIFEST.json` (sha256 `8f72e3e2…5760`, CID `bafkreiepolr6ewdbfzvxd4forprmpyp57ey5mydrpn42xq4blki7xg2xma`, pinned on this host) |
| owner plan | `PLAN.json`: publish version index 5, stop, start on `catalog://0x0f62…b537/5`; no step carries value |
| manager binding | candidate `~/.config/enclave/snpvm.r14.json` (image r14, run directory `rpc-snp-fleet-r14`; not in git) |

## Order

| | Who | Step |
|---|---|---|
| a | owner | publish catalog version index 5 (step `publish`) |
| b | operator | `host-prepare.sh manager`: the VM manager binds image r14 for the next launch and adopts the running r13 guest |
| c | owner | `setActive(id,false)` (step `stop`): metal0 shuts the guest down and releases the lease |
| d | owner | `multicall([setAppRef(…/5), setConfig, setActive(true)])` (step `start`) |
| e | operator | `finish.sh`: host-local proxy to r14's measurement, gateway chain policy to version 5, route record, reconciler, app address, first memory report |

```
bash ops/rpc-snp-prod-r7/release-r14/run-cutover.sh
```

is b and e in one command; it starts the signing page at `http://127.0.0.1:42293` (loopback only) and waits while
the owner signs a, c and d there. The network agent, reconciler, site and metal0's control image do not change.

Between c and the r14 guest's clients answering, public Ethereum is down (the gateway serves it from the enclave
only) and Base falls back to its providers. r14 starts on r13's chain disks: a replay, not a sync. At the r13
cutover the guest's Ethereum node answered within three minutes of its launch, but metal0's claim came 45 minutes
after the owner's start, because its control image then rarely got a policy answer. The image it runs now has that
fixed; how long a claim takes on it has not been measured, and `finish.sh` waits up to two hours for it.

After b the manager refuses to relaunch version 4 (the bound image is r14's). The running guest is not touched,
but a restart of it before d would not come back. Rollback before d: `host-prepare.sh rollback-manager`, then the
owner's `setActive(true)` alone. After d the way back is a further owner transaction to version 4 with the r13
binding (`~/.config/enclave/snpvm.json.r13`); the clients are the same versions in both images, so either runs
on the disks the other left.

## Does this lower the host's memory?

Not by itself. r14 at 64 GiB still pins what the guest touches, and the clients still fill their limits with page
cache. What r14 does: the log growth that could never be given back stops, the self-updating services are gone,
and for the first time the guest says what it needs.

The reduction is a second, catalog-only version: the same image and measurement with a smaller `res` memory
(`release.py … --mem-mib N --version 1.4.1`, owner-signed publish, stop, start; a second outage). Choose N from
the probe, a day or two after the cutover:

```
curl -sk --resolve enclave-rpc:18443:127.0.0.1 https://enclave-rpc:18443/memory
```

- `probe.held` rising while `groups.clients.current` stays level: the slice is at its working set. That size,
  plus `groups.system.current`, `groups.front.current`, the overlay (`mounts./.used`) and headroom for a client's
  restart, is what the guest needs.
- `probe.asked` rising with `held` near 0 and `current` still falling: not there yet.
- `groups.clients.stat.anon` is the floor: without swap it cannot be reclaimed.

Until that is read, the size a smaller version could name is not known: nothing inside r13 reports it. 48 GiB is
an estimate, not a measurement; 40 GiB is a guess.

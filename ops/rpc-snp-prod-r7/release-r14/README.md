# Enclave RPC r14 (1.4.0): memory the guest was not asked for

Status: **in production since 2026-11-13 02:54:11Z** (catalog version index 5 on deployment `0x5ff56a4d…454f`,
run by metal0). r13 (1.3.0, version 4) ran until the owner's stop at 02:35Z. The guest is still 64 GiB and the host
is charged what it was charged for r13: see "The run" and "Does this lower the host's memory?".

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
after the owner's start, because its control image then rarely got a policy answer. On the image it runs now the
claim landed 45 seconds after the owner's start (see "The run"); `finish.sh` waits up to two hours for it.

After b the manager refuses to relaunch version 4 (the bound image is r14's). The running guest is not touched,
but a restart of it before d would not come back. Rollback before d: `host-prepare.sh rollback-manager`, then the
owner's `setActive(true)` alone. After d the way back is a further owner transaction to version 4 with the r13
binding (`~/.config/enclave/snpvm.json.r13`); the clients are the same versions in both images, so either runs
on the disks the other left.

## The run (2026-11-13, all times Z)

| | |
|---|---|
| 02:33:35 | operator `run-cutover.sh`: the VM manager restarted bound to image r14 and adopted the running r13 guest |
| 02:34:49 | owner, publish version index 5: `0x5bf5bbce99a7e879b9f1b77630243da2d38c69a4c6fc4fb15de892115c68dd50` |
| 02:35:05 | owner, stop: `0x1b086c6e91c112870b6578e1493a060a97eaf61ec512b0dc0051b612a06716ba` |
| 02:35:55 | metal0: "stopped by owner on-chain -> teardown + release"; r13 guest stopped by 02:36:43 (its unit ran 16 h 21 min; systemd's closing line: 99.3G memory peak) |
| 02:36:48 | sponsored release `0x81e2ad448df5a716b7fd356be7b62563de241d86bf78bfd8e30b6c0a654e1f0f` (block 56735155) |
| 02:53:22 | owner, start on `…/5`: `0xda8d4cca030003e5e3598efa162235ad08d82c98db86250c1850745b7a462180` (the 17 minutes before it were the wait for the signature) |
| 02:54:07 | metal0's claim landed: `0x44a9b830e48adcecdba4add4a2b0c53648f2edd95d323c89bd9ded510f6a5d7b` |
| 02:54:11 | launch (8 vCPU, 65536 MiB, `catalog://0x0f62…b537/5`), guest unit active, "adopted: app=enclave-rpc:1.4.0" |
| 02:54:30 | host-local proxy `enclave-rpc-snp-local-proxy-r14` active (pinned to r14's measurement); `-r13` disabled |
| 02:54:32 | front attested and ready with measurement `aa1807f5…42e0` |
| 02:55:26 | certificate for `5ff56a4d.app.enclave.host` issued to the new guest |
| 02:56:52 | gateway restarted with chain policy `versionIndex` 5 (old config kept as `.pre-r14` on the control VM) |
| 02:57:06 | `https://5ff56a4d.app.enclave.host/` 200; route record on `…/5`, root hash `d0b6040a…1a58` |
| 02:57:28 | Ethereum node no longer syncing; 02:59:44 beacon node `sync_distance` 0 |
| 02:59:09 | reconciler ran, status 0 |
| 03:00:21 | Ethereum through the gateway answered (first read made; the gateway had the policy from 02:56:52) |
| 03:15:40 | Base at head (56746732, 18 s old) after two pipeline runs from 56734898 |

Public Ethereum was down from the stop (02:35:55) until the r14 node was at head and the gateway had version 5
(02:57), about 21 minutes, 17 of them the wait for the start signature. Base inside the guest was back at head 40
minutes after the stop; public Base is served from its providers while the guest lags (by design; not read
during this outage). Base's unit failed once at its first start
(connection refused while the Ethereum node was still coming up) and systemd restarted it; nothing was done by hand.

All three clients at head, gateway serving Ethereum and Base, app address 200: read again at 03:16:39.

## What the guest reports (first half hour)

`MEMORY-0300Z.json`, `MEMORY-0324Z.json`, `MEMORY-0326Z.json` are the guest's `/memory` at those times. GiB:

| | 03:00:31 (6 min after launch) | 03:26:24 (all clients at head) |
|---|---|---|
| guest `MemTotal` / available / free | 61.84 / 53.77 / 40.25 | 61.84 / 48.50 / 4.83 |
| clients' slice (limit: high 55.66) | 20.67 (anonymous 6.06, file 12.83) | 55.65 (anonymous 9.66, file 40.29, of it referenced twice 2.86) |
| Base | 1.90 | 43.79 (anonymous 2.96, file 36.03) |
| Ethereum execution | 12.63 | 6.18 (anonymous 2.11, file 3.23) |
| Ethereum consensus | 6.14 | 5.67 (anonymous 4.59, file 1.02) |
| front / everything else in the system | 0.03 / 0.17 | 0.03 / 0.29 |
| `/var/log` (guest memory) | 18.1 MB | 129.3 MB, growing 4.0 MB a minute toward the two 256 MB caps |
| probe | asked 5 times, held 0 | asked 16 times (1.04 GiB in all), held 15 |
| host: memory charged to the guest's unit | 27.5 GiB (03:01) | 84.4 GiB (03:29) |
| host: `MemAvailable` of 124.8 GiB | 70.5 GiB | 31.4 GiB |

Between 03:24:24 and 03:26:24 the kernel took file pages from the clients' slice at 70.8 MB a second (Base 61.9,
Ethereum execution 6.5, consensus 2.4), and 4.9 MB a second of what it had taken was read back (Base 3.1).

What that says:

- The slice reached its high limit 25 minutes after the launch and sits on it. Base maps its database and walks
  through it at about 62 MB a second, so it turns over its whole 36 GiB of cache every ten minutes or so, and it
  pushed the Ethereum node's cache from 10 GiB down to 3 GiB on the way. Of what Base gives up, 5% is read again.
- **The probe cannot answer as built.** It asks for 0.2% of the slice a minute (about 1.9 MB a second) and Base
  refills at thirty times that, so the slice never comes down; and the slice running on its limit by itself
  produces the pressure the probe takes as "stop" (`some` 0.14% to 0.29%). `probe.held` rising with
  `groups.clients.current` level is therefore **not** a working-set reading here. It does no harm (it sets no
  limit, and stops after 48 hours); it also does not measure.
- What can be read instead, with nothing changed in the guest: the anonymous memory (cannot be given back; 9.66 GiB
  and still rising half an hour in), and the re-read rate (`groups.*.stat.workingset_refault_file` against
  `pgsteal`, both counted since boot, so two reads a day apart give the day's average).

## Does this lower the host's memory?

No, and that is now measured: half an hour after the launch the host charged the r14 guest 84.4 GiB, against
82.84 GiB for r13. The 27.5 GiB right after the launch was a guest that had not touched its memory yet. r14 at
64 GiB still pins what the guest touches, and the clients still fill their limits with page cache. What r14 does:
the log growth that could never be given back is capped, the self-updating services are gone, and the guest
reports its memory.

The reduction is a second, catalog-only version: the same image and measurement with a smaller `res` memory
(`release.py … --mem-mib N --version 1.4.1`, owner-signed publish, stop, start; a second outage). r14's limits
are shares, so they follow N. What is known about N:

- Base with an 8 GiB limit could not follow the chain (2026-11-05, `ROOT-RESULT.md`). r11 to r13 gave Base
  30 GiB, the Ethereum execution node 11 and the consensus node 10, each its own (2026-11-06 to 2026-11-13).
  Nothing between has been run.
- On r14 the three share the slice, and Base takes from the other two: at 03:26 the Ethereum clients held 12 GiB
  together, about half of what r13 reserved for them, and were at head.
- A 48 GiB guest gives the slice about 41.7 GiB. If the Ethereum clients stay at those 12 GiB, Base is left about
  30 GiB, what it had on r13. That is the best-supported size: 16 GiB less pinned on the host. It rests on half
  an hour of the Ethereum clients running that small, not on a week.
- A 40 GiB guest leaves Base about 23 GiB: untested. The 5% re-read rate suggests room and does not prove it.
- Before either, read after a day (the command below): `groups.clients.stat.anon`, which no limit can squeeze
  and which was still rising at 03:26, and whether the Ethereum node kept up with the cache Base leaves it
  (`/health`, and `groups.el.stat.workingset_refault_file` against its `pgsteal`).

```
curl -sk --resolve enclave-rpc:18443:127.0.0.1 https://enclave-rpc:18443/memory
```

A smaller version is its own test: if Base falls behind on it, the gateway's `maxLag` keeps public Base on the
providers, and the way back is an owner-signed start on version 5.

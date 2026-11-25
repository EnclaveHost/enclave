# Enclave RPC 1.5.1: image r17 (Base's state history rolls in a 7,000,000-block window), guest at 32 GiB

Prepared 2026-11-25, **not published and not live**. Production is down: the deployment is on version 9 (1.5.0,
image r16), which the VM manager refuses because it binds r15 again. See "What happened to 1.5.0".

## What r17 changes from r15 (main 6b3ede776)

`rpc/snp/base_state_history_patch.py`: Base's account and storage changesets were kept from a fixed block
(52,500,000). The floor now moves at every Base start (weekly) to the newest headers static file minus 7,000,000
blocks, by whole changeset files, never below the configured block, in reth's absolute `before` mode. The start
check asks for the floor's files. Nothing else differs from r15 (`IMAGE-r17.json`). The guest stays at 32 GiB;
24 GiB is a later, catalog-only step once the first prune has run and a `/memory` reading is calm
(`../release-r16-24g/README.md` has the reading that sizes it).

**The window and the anchor.** The fixed floor was decision R1 of the anchor-bootstrap review: keep an unwind to a
finalized anchor possible. That anchor is the AnchorStateRegistry's finalized game, read on 2026-11-25 00:23Z at L1
finalized through public endpoints (not attested): L2 block 59,694,360, 2,184,313 blocks behind the tip, 5.06 days.
The floor is at most the tip minus 7,000,000 at a Base restart and does not move until the next one, so the tight
moment is right after a restart and the condition is simply that the anchor trails by less than 7,000,000 blocks
(about 16 days): 2.18 million measured, about 4.8 million to spare. The week between restarts adds room. (The
patch's docstring in the image counts the week against the margin; that is too cautious, not wrong in effect, and
is not worth a new measurement.) An anchor older than the window, down to 52,500,000, can no longer
be unwound to once r17 has started Base: that part of R1 is given up, on the owner's word ("keep it, widen
window", relayed by the RPC session at 00:21Z). If the anchor's lag ever grows past the margin, widen first.

**What it saves.** On the disk of 2026-11-24 (19 changeset files from 52.5M, 174 GiB) the first floor is
54,500,000: 4 files, about 37 GiB. The two segments then stay at about 15 files (roughly 135 GiB at today's density)
instead of growing by about 8 GiB a day. MDBX does not shrink; pruned index pages are reused.

## What happened to 1.5.0 (image r16)

r16 is the same patch with a 2,000,000-block window. The owner published it as version 9 and started it at
00:19:34Z on 2026-11-25. Its window did not contain the anchor, so its first Base start would have ended the unwind
option for good, contrary to what its record said. The guest was stopped at 00:20:49Z, 50 s after boot, before Base
had started (its start check was still refusing on L1 not answering), and the manager was put back on r15. Read
from the disk afterwards: both changeset segments still have their 19 files from 52,500,000. Version 9 stays in the
catalog and must not be started on these disks.

## Records

| | |
|---|---|
| image | `/vm/enclave-volumes/rpc-snp-image-r17`, root hash `ad552fc2…ea16`, built in 100 s (`IMAGE-r17.json`) |
| launch measurement, 8 vCPU | `8d5a96926cf0f0047db04780678d5c62ba0c8d3688bb5f0476ab29f423b6ed3616d8991814b5b40580b69938244bda0e` |
| release | `release.json`, `RELEASE-MANIFEST.json` (sha256 `39f9b9e8…5821`, CID `bafkreibz7g46qt7pf5ycfacnty5ed4f6leb3oq2s6ghoaicng4cwmt2yee`, pinned on this host) |
| owner plan | `PLAN.json`: publish version index 10 (resources 0, 0, 32768, 0), stop, start on `catalog://0x0f62…b537/10`; no step carries value. Nothing sent |
| manager binding | candidate `~/.config/enclave/snpvm.r17.json` (image r17, run directory `rpc-snp-fleet-r17`; not in git) |

## Qualification

- Unit tests: the patch's 13 (production profile and file layout, and the anchor arithmetic above) and the older
  patches', 38 together.
- Plain KVM: 10 of 10 checks (`KVM-CHECK-r17.json`).
- SEV-SNP boot on a scratch id with empty disks at 8 GiB (`/vm/enclave-volumes/rpc-snp-smoke-r17`, 00:3xZ, since
  stopped): accepted with the offline measurement, refused with r16's and for another deployment
  (`SNP-SMOKE-r17.txt`).
- **Not exercised:** Base on the real chain disks under r17, including the first prune (4 changeset files and the
  history indexes of about 2 million blocks).

## Order

```
bash ops/rpc-snp-prod-r7/release-r17-32g/run-cutover.sh
```

binds image r17 in the VM manager, starts the signing page at `http://127.0.0.1:42300` and waits while the owner
signs publish, stop and start; then `finish.sh` checks `-m 32768`, moves the local proxy to r17's measurement and
the gateway from version 8 to 10, waits for the app address and reports Base and the guest's memory.

Back to 1.4.3 instead: `host-prepare.sh rollback-manager` (the binding is r15's now) and an owner start on
version 8. After r17 has started Base, the pruned state history stays pruned.

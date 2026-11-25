# Enclave RPC 1.5.0: image r16 (Base's state history rolls) in a 24 GiB guest

**Superseded by `../release-r17-32g/` and not to be started.** Published as version 9 and started by the owner on
2026-11-25 00:19Z; stopped 50 s after boot, before Base ran, because its 2,000,000-block window does not contain the
anchor (5.06 days, 2,184,313 blocks behind the tip), so the sentence below that the unwind option is kept for
recent anchors is wrong: it would have ended at the first start. Nothing was pruned. What follows is the record as
prepared, kept for the 32 GiB reading and the 24 GiB sizing.

Two changes in one release, asked for together: a smaller guest and a bound on the one part of the Base disk that
grows without limit.

## What r16 changes (main b10b87cb8)

`rpc/snp/base_state_history_patch.py`: Base's account and storage changesets were kept from a fixed block
(52,500,000, `chain.json` `baseRetention.stateHistoryFromBlock`). The floor now moves at every Base start to the
newest headers static file minus 2,000,000 blocks (about 4.6 days at 5 blocks a second), by whole changeset files,
never below the configured block. reth's absolute `before` mode is kept. The start check asks for the floor's files.
`test/rpc-snp/test_base_state_history_patch.py` (13 cases, with the production profile and file layout).

Nothing else differs from r15: the same boot image, kernel, clients, chain config, coverage evidence, front and
limits (`IMAGE-r16.json` against r15's: `build_image.py`, `base_history_patch.py`'s docstring, the new patch; in the
image, `/opt/enclave-rpc/chain_service.py` gains the helper and two call sites).

**Why the floor was fixed, and what moving it gives up.** The anchor-bootstrap review
(`ops/rpc-backend-bootstrap/2026-10-25/finality-investigation/anchor-bootstrap-review/REVIEW.md`, decision R1) held
the changeset floor so that Base could still be unwound to a finalized anchor and its state rebuilt and checked
there; reth refuses an unwind below the state-history prune floor. No such unwind is recorded for production. With
the window, every anchor younger than about 4.6 days can still be unwound to; an anchor older than that, down to
52,500,000, no longer. **This is not reversible**: the first r16 start deletes the changeset files below the floor
and prunes their indexes, and going back to r15 does not bring them back.

**What it saves** (read from the chain disk on 2026-11-24, `qemu-storage-daemon` force-share, nothing written):
storage changesets 156.6 GiB and account changesets 17.7 GiB, 19 files of 500,000 blocks from 52.5M to 62.0M. With
the tip in the 61.5M file, as it was then, the floor is 59,500,000: fourteen of the nineteen files go, about
128 GiB (one file more for every 500,000 blocks the tip has moved by the cutover), and the two segments stop growing (they grew from 92 to 174 GiB between 11-08 and 11-24, about 8 GiB a day). The freed blocks
return to the host at the disk guard's next offline trim. Base's MDBX file (1,068 GiB) does not shrink: pruned index
pages become free pages inside it.

## Why 24 GiB, and how thin it is

The 32 GiB guest, 9 h 8 min into its boot, both chains at head (`MEMORY-32g-1124-2358Z.json`,
`HEALTH-32g-1124-2358Z.json`, read with `../release-r14-48g/reading.sh`):

| GiB | 32 GiB guest |
|---|---|
| guest MemTotal | 30.39 |
| clients' slice: held / its soft limit (90%) | 27.33 / 27.35 |
| anonymous: all, reth, Lighthouse, Base | 12.50, 3.97, 5.09, 3.44 |
| kernel memory charged to the slice | 4.05 |
| page cache: all clients, Base (mapped by Base) | 10.78, 9.10 (7.69) |
| stall on memory, slice, whole boot | 1.06% (0.68% at 48 GiB over a day) |
| killed at a limit, any group | 0 |
| newest block old, s: Ethereum, Base | 20, 9 |

What cannot be taken back is about 16.5 GiB in the slice (anonymous and kernel) plus about 2 outside it. A 24 GiB
guest has about 22.4 GiB and a soft limit near 20.2 for the slice, so **about 3.7 GiB of page cache for three
databases, against 10.8 now**, of which Base alone maps 7.7. The stall share already rose from 48 to 32 GiB. Base
stalled outright under an 8 GiB limit of its own (r10, `../ROOT-RESULT.md`). So 24 GiB is an experiment that may
fail, and it runs together with the first prune of the state-history indexes, which is extra database work at the
moment the cache is smallest.

**If it is too small**, the signs are the ones `../release-r14-48g/README.md` lists: Base or Ethereum falling
behind and not recovering (`/health`), the slice's stall above a few percent and rising (`/memory`), `oom_kill`
above 0 in any group. The way back for the size alone is a catalog version of r16 at 32 GiB (`release.py … --mem-mib
32768`, the three owner steps, one more outage). Publishing r16 at 32 GiB first and moving to 24 a day later would
separate the two changes, at the cost of that second outage; the same commands make it.

## Records

| | |
|---|---|
| image | `/vm/enclave-volumes/rpc-snp-image-r16`, root hash `b31aec59…eff4`, built in 123 s (`IMAGE-r16.json`) |
| launch measurement, 8 vCPU | `092bcf15f6ac1b2be1cbfae0ba337b05e30cc4a853bfa51297ac8a7f88efaae01c2f04491fced16cf593298a3b3a9983` |
| release | `release.json`, `RELEASE-MANIFEST.json` (sha256 `015bcab7…374a`, CID `bafkreiablpflpzdnbvavalsvojaqvum5bo57ueueu7f74ndb6fldprjxji`, pinned on this host) |
| owner plan | `PLAN.json`: publish version index 9 (resources 0, 0, 24576, 0), stop, start on `catalog://0x0f62…b537/9`; no step carries value. Simulated when written; nothing sent |
| manager binding | candidate `~/.config/enclave/snpvm.r16.json` (image r16, run directory `rpc-snp-fleet-r16`; not in git) |

## Qualification

- Unit tests: the new patch's 13 and the three older patches' (37 together) pass.
- Plain KVM: 10 of 10 checks (`KVM-CHECK-r16.json`).
- SEV-SNP boot on a scratch deployment id with empty disks at 8 GiB (`/vm/enclave-volumes/rpc-snp-smoke-r16`,
  2026-11-25 00:13Z to 00:16Z, since stopped): the live report's measurement equals the offline one; the
  repository's verifier accepts it and `/health` answers 200; with r15's measurement or another deployment it
  refuses (`SNP-SMOKE-r16.txt`).
- **Not exercised:** Base on the real chain disks under r16 (the prune of about 7 million blocks of history indexes
  and how long Base takes to answer after it), any r16 guest at 24 GiB, and three clients in 24 GiB at all.

## Order

```
bash ops/rpc-snp-prod-r7/release-r16-24g/run-cutover.sh
```

binds image r16 in the VM manager (the running guest is adopted, not touched), starts the signing page at
`http://127.0.0.1:42299` and waits while the owner signs publish, stop and start there; then `finish.sh` checks
the guest runs with `-m 24576`, moves the local proxy to r16's measurement and the gateway to version 9, waits for
the app address, and reports Base and the guest's memory. Ethereum and Base are down from the stop until the new
guest's clients are back at head.

Before the owner's start, `host-prepare.sh rollback-manager` puts the r15 binding back. After it, going back means
the r15 binding again and the deployment on version 8, and the pruned state history stays pruned.

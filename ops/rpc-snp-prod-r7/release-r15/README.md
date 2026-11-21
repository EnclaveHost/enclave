# Enclave RPC r15 (1.4.2): Base starts again after L1 has pruned the snapshot's safe origin

Prepared 2026-11-21, **not published and not live**: the owner has signed nothing. Production is still 1.4.1
(image r14, catalog version 6), with Base down.

## What happened

Base has not run in the production guest since its restart of 2026-11-20 18:49Z. `enclave-rpc-base.service`
exits a second after each start with `AssertionError: local RPC failed` and systemd starts it again every
minute (restart counter 760 at 07:54Z on 11-21). The Ethereum execution and consensus clients are at head.

Every Base start asks the guest's own L1 node whether the coverage origin is still what the reviewed snapshot
was derived from. The first question is `eth_getBlockByNumber` for the snapshot's safe L1 origin, block
26265939. The L1 node keeps 140000 blocks and gives up older ones in 100000-block segments; since about
2026-11-18 its earliest block is 26300000, and it answers anything older with error 4444 ("pruned history
unavailable"). `base_restart_patch.py` (images r11 to r14) lets a start go on when the origin's receipts and
blobs have aged out, on a datadir that recorded having started from this origin, but the block question ran
before it and treated every error as fatal. So Base kept running until it was next restarted, and then could
not start. Nothing is wrong with the chain disks.

A second question would have failed next: the origin slot's block, read for its blob commitments. Lighthouse
rebuilds a block from the execution node's payload, and with the payload pruned it answers 500
`ExecutionLayerErrorPayloadReconstruction` (asked of the production guest through its front, 2026-11-21).

## What r15 changes (main 3c936ed9f)

`rpc/snp/base_restart_patch.py`: the safe-origin block and the origin slot's block follow the rule the
receipts and blobs already had. Present, they are checked as before (a block with another hash still refuses).
Pruned (reth 4444; Lighthouse 500 payload reconstruction), the start goes on only if
`DATADIR/enclave-origin-served.json` names this same activation. Any other error still refuses.
`test/rpc-snp/test_base_restart_patch.py` has both cases.

Nothing else differs from r14: the same boot image, kernel, clients, chain config, coverage evidence, front
and limits (`IMAGE-r15.json` against `IMAGE-r14.json`: `base_restart_patch.py`, and `memprobe.py`'s docstring).
In the image, `/opt/enclave-rpc/chain_service.py` differs in `base_origin_data` and the two lines removed from
the Base start. The guest stays at 48 GiB.

## Records

| | |
|---|---|
| image | `/vm/enclave-volumes/rpc-snp-image-r15`, root hash `65e1320b…875e`, built in 98 s (`IMAGE-r15.json`) |
| launch measurement, 8 vCPU | `92901f814e7b6b3c6b466aaaf303c458f32286057640f3db1feda3a6ed5ce896d48504eb4a5496aa4e9a394d45b6f97b` |
| release | `release.json`, `RELEASE-MANIFEST.json` (sha256 `61514452…1ac6`, CID `bafkreidbkfcfejp7tpvttjk524sgjqzvqy44h4q6rub4kwzaozid3lq2yy`, pinned on this host) |
| owner plan | `PLAN.json`: publish version index 7, stop, start on `catalog://0x0f62…b537/7`; no step carries value |
| manager binding | candidate `~/.config/enclave/snpvm.r15.json` (image r15, run directory `rpc-snp-fleet-r15`; not in git) |

## Qualification

- The image's own `base_origin_data`, taken out of the built root and pointed at the production guest's L1 and
  beacon answers through its front: with no record it refuses ("Base origin block, receipts or blobs absent");
  with this activation recorded it prints `{"baseOrigin": "pruned", "resumingFrom": "persisted safe head"}` and
  returns. So the start passes on today's L1 if the Base datadir holds the record.
- That record cannot be read from outside the guest. It is inferred: r14 started Base on 2026-11-13 16:30Z, when
  the origin's blobs were already 20 days old (pruned after 18), which the r14 code allows only with the record.
- Plain KVM: 10 of 10 checks (`KVM-CHECK-r15.json`).
- SEV-SNP boot on a scratch deployment id with empty disks (`/vm/enclave-volumes/rpc-snp-smoke-r15`, 2026-11-21,
  since stopped): the live report's measurement equals the offline one; the repository's verifier accepts it and
  `/health` answers 200; with r14's measurement or another deployment it refuses.
- Not exercised: Base on the real chain disks under r15. That is the cutover.

## Order

The same as r14's (`../release-r14/README.md`):

```
bash ops/rpc-snp-prod-r7/release-r15/run-cutover.sh
```

binds image r15 in the VM manager (the running guest is adopted, not touched), starts the signing page at
`http://127.0.0.1:42297` and waits while the owner signs publish, stop and start there; then `finish.sh` moves
the local proxy to r15's measurement and the gateway to version 7, waits for the app address, and reports
whether Base answers. Ethereum is down from the stop until the r15 guest's clients are back (three minutes at
the r13 cutover, plus metal0's claim).

The way back is an owner-signed stop and start on version 6, `host-prepare.sh rollback-manager` before it, and
the gateway's `versionIndex` back from the `.pre-r15` copy. Version 6 cannot start Base either.

## Still open

- The origin's own data will not come back, so every image needs this rule until a new coverage origin is
  reviewed. A start on a fresh Base datadir (no record) needs a new snapshot and verdict.
- Why the guest was restarted on 2026-11-20 18:44Z (`launch.jsonl`: a requested stop, a new launch five minutes
  later) was not looked into.

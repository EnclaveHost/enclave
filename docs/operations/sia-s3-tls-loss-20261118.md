# sia-s3 kept losing its TLS certificate (2026-11-16 to 18)

What a visitor saw: the running `sia-s3` deployment (0xef514ed3 on nucbox-k11-4) lost TLS every few minutes and
its Open button turned orange. `cron` and `depot`, which store through it, answered 503.

## What happened, in order

1. **The storage VM lost name resolution.** `enclave-storage` (the Hyper-V VM on nucbox-k11-4 that runs the Sia
   indexer) resolved names through the Hyper-V host's DNS proxy, the server its DHCP lease names. On 2026-11-16
   03:26 UTC the host's uplink was moved to Wi-Fi and that proxy stopped answering most queries. The same change
   broke `enclave-control` that night; its resolver was repointed by hand then, the storage VM's was not.
   systemd-resolved in the storage VM logged 7,106 / 8,268 / 5,814 server downgrades on the 16th, 17th and 18th
   (one or two a day before), and the indexer logged 2,909 / 7,347 / 3,633 lookup timeouts.
2. **The indexer took the Sia hosts for down.** Every failed scan lowers a host's uptime score; below 0.9 the host
   is blocked and its contract is no longer good. By the 18th 27 of 94 contracts were good, 47 hosts were blocked
   for uptime alone, slab repair had stopped (fewer than 10 readable shards for many slabs from the indexer's side)
   and 131 slabs were stuck. No slab was unrecoverable.
3. **A read aborted the app.** The Sia SDK in sia-s3 drops the sectors of hosts the indexer does not list before a
   download, then sized the vector of recovered shards by what was left, while each shard kept its index in the
   slab. With 13 of an object's 30 hosts unlisted, shard 29 was written into a vector of 17: `index out of bounds`
   at `sia_storage/src/download.rs:336`, the wasm trapped and the runtime exited with status 134. The same bug is
   the cause of the single aborts seen since 2026-10-17, whenever one host was unlisted.
4. **The platform replaced the partition.** A partition whose app has ended is retired and a new one started, with
   a new TLS key, so a new certificate is ordered each time (three an hour; Let's Encrypt answered 429 and ZeroSSL
   issued instead). Its clients read as soon as it is ready, so each new partition aborted a few minutes after its
   start: 20 partitions ended with status 134 between 10:52 and 17:12 UTC on the 18th (the console logs the box
   still has).

The abort was reproduced with the production wasm (same CID) run under wasmtime against the indexer: the first
GET of the scheduler's state object ended it with the message above.

## What was changed

- **Both VMs resolve through public resolvers**, kept across reboots: `scripts/storage/vm-public-dns.sh`
  (a systemd-resolved drop-in routing every name to four public servers; the host's proxy is unused). Run in
  `enclave-storage` and `enclave-control` at about 16:57 UTC; the indexer's lookup timeouts went to zero.
- **The indexer's hosts are back.** A scan of every contract host was made due at once (they had backed off by up
  to five days). indexd lifts a usability block by itself only for hosts without an active contract, so the hosts
  that hold our sectors would have stayed blocked until their contracts ended: the 37 that passed every check
  were unblocked through the admin API, and for 8 more the uptime the outage had cost them (a factor of 0.979
  over 61 hours of a 12-week half-life) was given back first. Good contracts: 27, then 72. Six hosts remain
  blocked for uptime (two have not answered for hundreds of scans) and 20 for their prices or collateral.
- **An hourly job keeps that from recurring**: `scripts/storage/indexd-unblock-recovered.py` with its service and
  timer, installed in the storage VM. It unblocks contract hosts whose only block reason is uptime and that pass
  every usability check again; it does not touch price, collateral or manual blocks.
- **The SDK bug is fixed in sia-s3 0.1.10** (enclave-apps a1830ce; on its `main` since 2026-11-24, merge d35fa73's
  parent: until then the app's whole source lived on the branch `sia-s3/spike`): the vector is the slab's full
  shard count, and a shard outside it or recovered twice is an error. Six tests cover unlisted hosts at every
  position. Run locally against the indexer, the objects that aborted 0.1.9 read back whole, and an object with
  only nine reachable shards failed with an error instead of ending the app. The fix had been written against
  the unreleased 0.2 line on 2026-10-27 and never reached production.

## 0.1.10 went live on 2026-11-19, with a 13-minute outage of its own

The owner signed both transactions (catalog version 0.1.10 at index 9, block 59348196; the deployment's
reference, block 59348237). The last 0.1.9 partition had by then run from 18:02 to 03:47 UTC without an abort,
which is what the unblocked hosts bought.

The node replaced the partition at 03:47 and the new one got no secrets: the relay answers a Shield secret
release only after it has fetched the catalog component itself and checked it against its CID, and it reads from
the four edge replicas and the storage adapter, not from the box's cache. The component was in the box's cache
only (the adapter stores through sia-s3, which could not be trusted to stay up at the time), so the relay logged
`catalog component could not be CID-verified`, the release answered 503, and the partition ended after 300 s
without becoming ready. Staging the component only where the node reads was the mistake.

The component was added to each edge's retained replica (`/opt/enclave-retained/cc96aad`: the two files, a
manifest entry, a gateway restart that re-hashes the whole set, about two to four minutes an edge, one edge at a
time). With the first edge done the next partition got its secrets at 04:00:09, a certificate at 04:01, and
answered `ready` as 0.1.10 at 04:03. Read through the live app, the six objects that aborted 0.1.9 or stood for
its clients came back whole, and `cron` and `depot` answer 200 again. The component was then uploaded through
the public upload gateway and reads back from the adapter with the same digest.

**For the next sia-s3 release:** the component must be on the edge replicas (or the adapter) before the
deployment's reference is signed. The adapter cannot be the only copy of the app it depends on.

## What is not done

- **The indexer cannot form or renew contracts**: its wallet holds 122 SC, of which 14 SC are free, and a
  contract needs about 55 SC. Funding it is the owner's.
- 20 contract hosts are blocked because their prices or collateral are outside the indexer's fixed limits
  (egress above 3,000 SC per TB for 17 of them). Price pinning is off, so the limits do not follow the exchange
  rate. Changing them is a spending decision.
- An app that aborts still costs its partition, its TLS key and a certificate order. Restarting the app inside
  the partition it already has would keep all three; that is a runtime change of its own and is not made here.
- Nothing raised an alarm in 61 hours. The indexer's own alerts (`/api/alerts`) are read by no one.

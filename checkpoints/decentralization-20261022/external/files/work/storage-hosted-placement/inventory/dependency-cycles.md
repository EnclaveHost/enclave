# Storage dependency cycles and the cold path (2026-10-21, read-only analysis)

Facts: `current-storage-chain.json`, `ledger16d-schema.json`, `lease16-live-derivation-eyesoff.json`.

## Edges as deployed today

| from | needs | served by today | DigitalOcean? |
|---|---|---|---|
| s3-ipfs-adapter (ipfs.enclave.host) | public ingress | DNS -> the 4 DO addresses only | yes |
| adapter | its Wasm artifact (catalog CID) | IPFS gateways: ipfs.enclave.host (the adapter itself) and Enclave's static replicas/bootstrap gateways | yes, and self |
| adapter | S3 backend | sia-s3 deployment (config secret; not read) | via sia-s3 |
| adapter, sia-s3 | secrets (app key, S3 credentials) | relay secrets; custody v2 custodians (`enclave-custodian.service` on the DO machines) | yes |
| adapter, sia-s3 | a lease (claim/renew gas) | host runner; lease relays (`enclave-lease-relay`, interim, DO) | yes |
| sia-s3 | its Wasm artifact | catalog CID through the same gateways, i.e. possibly through the adapter, which needs sia-s3 | cycle |
| sia-s3 | writer authority | lease16 fact from ledger 16d over public Base RPCs (front binding) | no |
| sia-s3 | indexer(s) | https://sia.enclave.host -> DO addresses -> reverse SSH tunnel -> minipc VM | yes, and a single host |
| sia-s3 guest | egress to indexers and Sia hosts | Enclave network: guard -> exit on a DO provider | yes |
| indexd | PostgreSQL, chain sync, Sia hosts, wallet | local DB; public Sia peers; third-party hosts; operator phrase | no (single machine) |

## Cycles

- **C1 artifact:**
  - the adapter's artifact, and possibly sia-s3's, is retained behind the adapter, whose storage is sia-s3, which
    needs indexd;
  - a cold start of sia-s3 can need sia-s3.
- **C2 secrets:** custodians and relay secrets on DO deliver the app key that sia-s3 needs to read its own data.
- **C3 lease:** claims and renewals need lease relays (DO) before sia-s3 runs at all.
- **C4 transport:**
  - indexer ingress (DNS + tunnels) and guest egress both terminate on DO;
  - with DO gone, a running sia-s3 can reach neither its indexer nor the Sia hosts.
- **C5 single writer and indexer:** one indexd on one machine, whose contract renewals keep the data on Sia.

## What this work changes, and what stays with other owners

- **C5 (this work, implemented):** `enclave-storage-indexer` replicas on N >= 3 Enclave hosts (preflight refuses DO
  machines). sia-s3 writes W = 2 of 3, rebuilds a lost replica from peers, and boots from ledger 16d's lease16 fact.
  Fixture evidence: `e2e/`.
- **C1, C2, C3, C4: NOT solved here.**
  - owners: the hosted-placement (bootstrap/artifacts/DNS), custody, lease-relay and network workers;
  - what storage needs from them is listed in the result file.
  - The cold path below does not depend on any of them.

## The cold path (breaks every cycle; implemented with existing code, proven in the fixture)

The owner keeps four things off-line:
1. the sia-s3 Wasm file, by sha256 (00e9cde0...);
2. the deployment's app key;
3. a sealed snapshot from `sia-s3 recovery export` (an encrypted object index plus the host list), with its sha256;
4. a wasmtime binary.

With only those plus any internet path to the third-party Sia hosts:
- `sia-s3 recovery read` restores objects with NO indexer, catalog, relay, custody, lease, DNS or Enclave host.
- `writerAuthority {"source":"owner-cold"}` + `instanceIsolation "owner-process"` runs a full S3 service on the
  owner's machine against any surviving indexer replica. It preempts the current lease writer and never a later
  lease.

Retention caveat:
- Sia keeps sectors only while contracts are renewed, and only indexers renew them.
- If every indexer replica is gone for longer than its contracts' remaining duration, the data is lost even with the
  cold path.
- The recovery is: an `enclave-storage-indexer` on any non-DO machine with that replica's own recovery phrase. It is
  the operator's off-line material, not a backup.

# sia-s3 as the Enclave app in front of hosted indexer replicas

Artifact: `sia-s3.wasm` sha256 `00e9cde0929dc7b8726ca4b7b9c9afb51ec4bf6d952039c907c032256ec79afc` (4,555,871 bytes;
clone-safe encryption; component-validated in work/storage-wasm-validation full4, 124/124). Never `aa15a054...` in
this configuration: `instanceIsolation` resolves to snp or vbs, i.e. copy-tolerant mode (privacy result).

`config.template.json` is the measured catalog config.
- `$ENCLAVE_WRITER_AUTHORITY` and `$ENCLAVE_INSTANCE_ISOLATION` are reserved names that ONLY the measured front fills:
  - the lease16 fact derived from ledger rev 16d (0xb1783b61...) by the front-binding code;
  - the front build's isolation constant.
  - Owner secrets cannot set them (`ENCLAVE_` prefix reserved). Without the fact sia-s3 never becomes ready: there is
    no silent unfenced fallback.
- `$SIAS3_REPLICAS` is an owner secret holding the replica array:
  `[{"name":"r1","indexer":"https://<replica url>","appKey":"<hex>"},...]`, with one app key per replica, registered
  on that replica's indexer.
- writeQuorum 2 with 3 replicas. Each replica runs `enclave-storage-indexer` on a distinct Enclave host.

Adding or replacing a replica is a membership change (REPLICATION.md):
- list the departing replica as `"retiring": true` until the change commits;
- replace at most W-1 = 1 member at a time.
- Shown in e2e/ (place3): r0's host lost, r3 added, r3 backfilled from peers, r0 dropped.

Not covered here (other owners): the adapter's own config (its S3 endpoint becomes this deployment's URL), catalog
publication, funding, the lease relays and the front image carrying the front-binding change.

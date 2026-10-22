# enclave-storage-indexer: Sia indexer replica host package for Enclave hosts

A reproducible host package that runs ONE independent Sia indexer replica on an Enclave host: the G-C2 indexd plus
its own native PostgreSQL 18. It is NOT activated anywhere. Root owns admission, funding and cut-over.

It is the storage half of the hosted-placement requirement: indexers run on Enclave hosts, never on the four
DigitalOcean transport machines (`preflight` refuses those), and sia-s3 stays an Enclave app that writes to
W = 2 of N = 3 replicas on distinct hosts.

## What runs

| unit | process | state |
|---|---|---|
| `enclave-storage-indexer-pg@<r>.service` | `postgres` (host distro, major 18), Unix socket only, peer auth | `/var/lib/enclave-storage-indexer/<r>/postgres` |
| `enclave-storage-indexer@<r>.service` | `indexd` v0.6.0-fence.2-c2 (sha256 e6e812fd...) | `/var/lib/enclave-storage-indexer/<r>/state` |
| `enclave-storage-indexer-backup@<r>.timer` | optional encrypted logical backup | `/var/lib/enclave-storage-indexer/<r>/outbox` |

`<r>` is the replica name, matching sia-s3's `replicas[].name`. One host runs at most one replica of a set.

## Durable state layout (exact)

```
/opt/enclave-storage-indexer/<package sha256>/      read-only package (bin/indexd, share/GeoLite2-City.mmdb, libexec/, units/)
/opt/enclave-storage-indexer/current -> <sha256>    the active package
/etc/enclave-storage-indexer/<r>/
    replica.env            non-secret: REPLICA, ADVERTISE_URL, ENCLAVE_HOST_ID, FAILURE_DOMAIN_SITE/_PROVIDER/_POWER
    indexd.base.yml        non-secret indexd config (rendered by init-replica; no phrase, no password)
    recovery-phrase.cred   systemd-creds ENCRYPTED wallet phrase (host key/TPM); never plaintext on disk
    admin-password.cred    systemd-creds encrypted admin API password
    owner-backup.pem       optional: the owner's backup recipient certificate (public)
    ALLOW_LIVE_START       root's activation guard (absent = units do not start)
/var/lib/enclave-storage-indexer/<r>/
    postgres/              PGDATA (initdb --auth-local=peer, no TCP listener)
    state/                 indexd data dir: consensus.db, chain state (rebuildable from Sia peers)
    outbox/                encrypted backups awaiting off-host copy (CMS AuthEnvelopedData, AES-256-GCM)
/run/enclave-storage-indexer/<r>/                   tmpfs, per boot
    indexd.yml             rendered at start from base + credentials, mode 0600, gone at stop
    pg/                    the PostgreSQL socket directory
```

What each piece needs for recovery:

- **chain state** (`state/consensus.db`): none; it re-syncs from Sia peers.
- **PostgreSQL** (objects, slabs, contracts, accounts):
  - normally rebuilt FROM PEER REPLICAS: register the app key on a fresh replica and let sia-s3's membership change
    and repair backfill it (REPLICATION.md "Membership changes"). No backup is needed while W replicas survive.
  - The optional encrypted logical backup covers the loss of the whole set.
- **wallet phrase:**
  - the replica operator's own BIP-39 phrase. Losing it loses that replica's contract funds, not the data (other
    replicas hold their own contracts).
  - Kept by the operator offline. It is never in a backup, a log or the package.
- **sia-s3 app keys:** held by the deployment owner (custody / owner cold). Never on the indexer host.

## Trust and privacy

- The indexer sees slab keys, sector roots, sealed object metadata and access patterns. It never sees plaintext:
  object data keys and metadata are sealed with the app key inside the sia-s3 guest. An indexer host is therefore
  trusted for availability and for following the protocol (fail-stop, C2 A1), not for confidentiality.
- Byzantine indexers are out of scope, as in C2.

## Commands

```
libexec/preflight <r>        refuses DigitalOcean machines, wrong PostgreSQL major, low memory/disk, placeholders
libexec/init-replica <r>     initdb + role/db + indexd.base.yml; prints how to create the encrypted credentials
libexec/render-config <r>    (ExecStartPre) base + $CREDENTIALS_DIRECTORY -> /run/.../indexd.yml (0600)
libexec/backup <r>           pg_dump -Fc | zstd | openssl cms -encrypt -aes-256-gcm -> outbox/
libexec/restore <r> <file>   decrypt with the owner's key (OFF the host), pg_restore into an EMPTY database
libexec/descriptor <r>       the replica's service descriptor (JSON) for platform admission (signed by root, not here)
```

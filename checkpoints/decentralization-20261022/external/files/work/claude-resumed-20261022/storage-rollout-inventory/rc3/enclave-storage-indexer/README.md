# enclave-storage-indexer 1.0.0-rc3: the Sia indexer HOST ROLE package for Enclave hosts

The pinned bytes for ONE independent Sia indexer replica on an Enclave Linux host:
- `bin/indexd`: indexd v0.6.0-fence.2-c2-enclave, sha256 2c0e5b06... (G-C2 plus enclave-small: 8 GiB contract growth,
  1 GiB account fund target, 5-minute application API timeouts; the same build the live indexer migrates to);
- `share/GeoLite2-City.mmdb`;
- `libexec/preflight`;
- one systemd unit.

The lifecycle belongs to the Enclave host software's supervisor, `network/host-services/storage-indexer-host.mjs`.
It runs PostgreSQL 18 (host distro binaries, socket only, peer auth) and indexd ONLY while all of the following hold:

1. The **platform host policy** (`network/host-service-gate.mjs`, the same gate as app service on this host) admits
   this host:
   - the administrator's anchored policy (bans by registryId/operator/owner/endpoint, allowlist mode);
   - an ACTIVE registry entry for keccak256(host.endpoint);
   - an accepted owner.
   A refusal is sticky until the administrator's new admit, and survives restarts.
2. The **replica descriptor** (`enclave-service-descriptor/v1`, kind `storage`, role `storage-indexer`) names this
   host's registry id, this replica, this exact package and the advertised URL. It is signed (EIP-191) by THIS HOST'S
   REGISTRY OPERATOR, read from the same agreed snapshot the gate uses.
3. The **package** on disk is the pinned one: every file matches `MANIFEST.sha256`, whose digest is the pin.

A refusal at run time stops indexd, then PostgreSQL. The data is kept. The admin's unban restarts both on the same data.
An indexd crash restarts with backoff. `init` and `check` refuse on a refused host. With the policy explicitly "off",
the role does not run at all (there is no ungated mode).

Which replicas a sia-s3 deployment writes to is the deployment owner's configuration.
- Discovery ads use the existing service index (kind `storage` = 3; `network/service-index.mjs`). They are metadata
  and grant no authority.
- No new contract, registry field or authority is introduced.

## Durable state layout

```
/opt/enclave-storage-indexer/<sha>/        this package (read-only); current -> <sha>
/etc/enclave-storage-indexer/<r>/
    host.json              enclave-storage-indexer-host/v1 (templates/host.json.template): public configuration only
    replica.env            ENCLAVE_HOST_SOFTWARE, failure domain, PG_BIN (strict keys; read by preflight)
    descriptor.json        { descriptor, signature } from the host's registry operator
    recovery-phrase.cred   systemd-creds ENCRYPTED wallet phrase (this replica only)
    admin-password.cred    systemd-creds encrypted admin API password
/var/lib/enclave-storage-indexer/<r>/
    postgres/              PGDATA (initdb --auth-local=peer --auth-host=reject; listen_addresses='')
    state/                 indexd data: consensus/chain state (rebuildable from Sia peers) + the GeoIP database
    outbox/                owner-encrypted backups (CMS AuthEnvelopedData, AES-256-GCM)
    host-policy/           the gate's persisted admission (a refusal stays sticky across restarts)
/run/enclave-storage-indexer/<r>/{pg/, indexd/indexd.yml (0600, rendered per start from host.json + credentials)}
/run/credentials/enclave-storage-indexer-host@<r>.service/   systemd's decrypted credentials (tmpfs)
```

## Commands (the supervisor, from the Enclave host software)

```
node network/host-services/storage-indexer-host.mjs check   /etc/enclave-storage-indexer/<r>/host.json
node network/host-services/storage-indexer-host.mjs init    ...host.json                      (admitted host only)
systemctl enable --now enclave-storage-indexer-host@<r>                                       (runs `run`)
node network/host-services/storage-indexer-host.mjs backup  ...host.json <out.cms> <owner-cert.pem>
node network/host-services/storage-indexer-host.mjs restore ...host.json <in.cms> <owner-key.pem> <owner-cert.pem>
```

Recovery:
- one replica lost: a NEW replica (its own phrase) joins through sia-s3's membership change and is backfilled from
  its peers. No backup is needed (place3 fixture).
- whole set lost: restore the owner-encrypted backup into a freshly initialised replica.
- Never reuse another replica's phrase.
- The data's last resort is sia-s3's indexer-free cold recovery.

## Trust and privacy

- Indexers see slab keys, sector roots, sealed metadata and access patterns, never plaintext: data keys and metadata
  are sealed with the app key inside the sia-s3 guest.
- An indexer host is trusted for availability and protocol (fail-stop), not for confidentiality.

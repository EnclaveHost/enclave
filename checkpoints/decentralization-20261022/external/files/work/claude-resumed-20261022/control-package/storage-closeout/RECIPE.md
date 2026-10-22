# Storage-indexer host role: ROOT activation recipe (metal0 host OS). Prepared; nothing executed.

Scope: install ONE admitted storage-indexer replica on the only SUPPORTED Linux Enclave host known: metal0's host OS
(this workstation, Arch; SEV-SNP node registered at https://api.enclave.host/t/metal0).
- Role: `network/host-services/storage-indexer-host.mjs` 20abb681 (root-integrated in work/enclave).
- Package: rc2 `enclave-storage-indexer-1.0.0-rc2.tar.zst` 3b78d4f1….

This recipe does NOT move production storage. The live sia-s3 path keeps its current endpoint and backend unchanged:
- the ordinary 'enclave-storage' VM on the minipc, running legacy indexd v0.6.0-enclave2 with PostgreSQL;
- sia.enclave.host via the DigitalOcean fronts.

Never restart that VM or its manager, never copy its database or wallet phrase, never repoint the adapter.

## 0. Integration blockers found, and how this package repairs them (copies only; main and live untouched)

| blocker (evidence) | repair |
|---|---|
| metal0's host checkout `/home/steven/Projects/enclave` (04a27e8d, 2026-10-13) has NO `network/`: the role, the platform host-policy gate and their modules are absent there (read-only file check). | `host-software/`: the role's EXACT runtime import closure from work/enclave (9 source files + the 411 npm files Node resolves + every package.json of the 7 packages = 585 files). Not transpiled or bundled. Reproducible tar `83c95b4b…`, manifest `658e5a44…`. Installed under /opt; the running metal checkout is not touched. |
| The unit has `ProtectHome=yes`, so a host software under /home is unreadable to it. | Install under `/opt/enclave-host-software/<id>/tree`; `render-config.mjs` refuses a /home path. |
| `check` verifies the descriptor BEFORE the gate, so nobody can learn whether metal0 is admissible before the operator signs. | `activation/gate-preflight.mjs`: the role's own gate + registry read, read-only, with a throwaway state dir. Prints ADMISSIBLE / NOT_ADMISSIBLE / UNKNOWN and the registry operator address. |
| The role exports `descriptorBytes()` but has no command that prints the bytes to sign. | `activation/descriptor.mjs request` prints the exact bytes and their EIP-191 digest; the operator signs elsewhere; `assemble` verifies with the role's `verifyDescriptor` and writes descriptor.json (never overwrites). |
| The template's pgBin defaults to Debian `/usr/lib/postgresql/18/bin`, while the package preflight reads `PG_BIN` from replica.env. The two can disagree; on Arch the binaries are in `/usr/bin`. | `activation/render-config.mjs` renders host.json (validated by the ROLE's `validateConfig`) and replica.env (exactly the package's 8 keys) from ONE input. It refuses missing values, placeholders, a DigitalOcean failure domain and DigitalOcean-only names. |

## 1. Read-only preflight (ROOT, on metal0's host OS; no secret, no process list, nothing written or started)

```
sha256sum enclave-storage-indexer-host-software.tar   # 83c95b4b1886cee1e8664f4fc7201c5713726e4084c4961e30cf708c2f81b3b7
install -d -m 0755 /opt/enclave-host-software/658e5a443480 && tar -C /opt/enclave-host-software/658e5a443480 -xf enclave-storage-indexer-host-software.tar
(cd /opt/enclave-host-software/658e5a443480/tree && sha256sum -c --quiet ../MANIFEST.sha256) && sha256sum /opt/enclave-host-software/658e5a443480/MANIFEST.sha256   # 658e5a44…
chmod -R a-w /opt/enclave-host-software/658e5a443480
bash activation/host-preflight.sh /usr/bin /opt/enclave-host-software/658e5a443480/tree
node activation/gate-preflight.mjs --host-software /opt/enclave-host-software/658e5a443480/tree --endpoint https://api.enclave.host/t/metal0
```

(Installing an inert, read-only directory under /opt is the first host change. Root may instead run the two node
helpers from a copy anywhere outside /home.)

Proceed only if:
- gate-preflight prints `ADMISSIBLE`;
- host-preflight shows PostgreSQL 18 at PG_BIN, systemd-creds with a host key or TPM2, MemAvailable >= 2304 MiB and
  /var/lib free >= 3584 MiB.

## 2. Package and descriptor (ROOT + the REGISTRY OPERATOR's own wallet; this package never holds a key)

```
sha256sum enclave-storage-indexer-1.0.0-rc2.tar.zst   # 3b78d4f10a31e23871130d8e87044be31470de62c5b08350a752d4b14a0c497d
# unpack to /opt/enclave-storage-indexer/<manifest12>/ ; ln -s <manifest12> /opt/enclave-storage-indexer/current
node activation/descriptor.mjs request --host-software <HS> --package-dir /opt/enclave-storage-indexer/current \
     --endpoint https://api.enclave.host/t/metal0 --replica m0a --advertise <ADVERTISE_URL> --operator <registry.operator from step 1> > request.json
# the registry operator personal_signs request.json .descriptor EXACTLY (never the admin key, never any other key)
node activation/descriptor.mjs assemble --host-software <HS> --request request.json --signature 0x... --out /etc/enclave-storage-indexer/m0a/descriptor.json
```

## 3. Config, credentials, init, enable (ROOT; only when section 5's prerequisites exist)

- `node activation/render-config.mjs --host-software <HS> --inputs inputs.json --out /etc/enclave-storage-indexer/m0a`
  writes host.json + replica.env. Its inputs: endpoint, replica, advertiseURL, pgBin, hostSoftwareDir, packageDir,
  "production", and failureDomain { site, provider, power }: the real values, never invented.
- Credentials ON the host:
  - a NEW phrase: `/opt/enclave-storage-indexer/current/bin/indexd seed` (never another replica's);
  - `systemd-creds encrypt --name=recovery-phrase - …/recovery-phrase.cred`, the same for admin-password.
- `node <HS>/network/host-services/storage-indexer-host.mjs check /etc/enclave-storage-indexer/m0a/host.json` must print
  `admit: true`; then `init`.
- Then install units/enclave-storage-indexer-host@.service, create the system user, and
  `systemctl enable --now enclave-storage-indexer-host@m0a`.

## 4. What this does and does NOT distribute (honest)

- Already distributed today: the sector data. It is erasure-coded across independent Sia hosts, under contracts held by
  the single live indexer's wallet.
- After step 3 on metal0 alone:
  - one more independent indexer EXISTS: its own empty PostgreSQL, its own new phrase, wallet and chain state, admitted
    by the platform policy under admin ban control.
  - It holds NO production metadata and serves NO deployment: it is in no sia-s3 membership.
  - The authoritative object metadata, the wallet seed and the Sia contracts remain the SINGLE legacy indexer and
    database on the minipc VM.
  - sia.enclave.host remains DigitalOcean-only.
- Becomes distributed ONLY after all of section 5:
  - sia-s3 C2 writes each object to N >= 3 indexers and acknowledges at W = 2.
  - Each indexer is its own authority for its own database, wallet and contracts.
  - The app key stays a single authority inside the sia-s3 guest (by design).
  - Admin governance is unchanged: admission, bans and delisting.
- Recovery semantics are those of the real services:
  - a restore is accepted only with the replica's OWN phrase (indexd itself refuses a changed seed);
  - one lost replica is replaced by a NEW member through a membership change;
  - the last resort is sia-s3's indexer-free cold recovery (place3 fixture evidence; not production evidence).

## 5. Missing prerequisites (exact; none invented, none performed)

1. Failure domains. N >= 3 replicas, W = 2, on distinct site/provider/power. Known: metal0, plus the minipc (Linux only
   inside a VM; same machine as the live VM). There is no evidence that they differ in site, power or uplink, there is
   no third Linux host, and DigitalOcean is refused. Needs new hardware or a new operator; no purchase is authorized.
2. Ingress. A public advertiseURL for each replica that does not ride DigitalOcean. None exists today:
   - sia.enclave.host and ipfs.enclave.host resolve only to DigitalOcean;
   - guest egress also exits on DigitalOcean;
   - this is the discovery/network workers' item.
3. Descriptor. A signature by metal0's REGISTRY OPERATOR key over the exact bytes (operator wallet action).
4. Admission. metal0's current platform-policy and registry state: unknown until step 1. Under a denylist policy the
   host-ownership owner is not required (judgeHost uses it only for owner bans or allowlists).
5. Host packages on metal0's host OS: PostgreSQL 18 system binaries (Arch `postgresql` 18.x), and a systemd credential
   host key or TPM2. These are root's host changes.
6. Sia funding for each replica wallet (spend; not authorized), and its host contracts.
7. The live single indexer is v0.6.0-enclave2. It has no `cas-v4` or `op-nonce` fence API, and fenced C2 refuses such a
   member (REPLICATION.md "Copies of a running writer"). The documented 1->3 migration therefore needs that indexer on
   G-C2 first:
   - a data-preserving upgrade on the live VM, never tested against the live database shape;
   - it touches the VM: root only.
   Otherwise the deployment stays the unfenced single writer.
8. Owner and app steps:
   - publish the C2 + privacy-fixed sia-s3 artifact (catalog, owner authority);
   - redeploy with the replica list and keys as secrets;
   - register the app key on each new indexer;
   - the front image with writer-authority binding;
   - the adapter's S3_ENDPOINT switch, as an explicit owner step.
9. Failure proof. A real member loss, a provider outage and a cold recovery, on the deployed set. Not possible before
   items 1-8.

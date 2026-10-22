# Storage-indexer host role: supported placement and production prerequisites (2026-10-21)

## Supported host classes

| host class | storage-indexer role | how |
|---|---|---|
| **Linux Enclave host** (e.g. metal0's host OS) | **supported** | systemd unit `enclave-storage-indexer-host@<r>` -> the Enclave host software's supervisor `network/host-services/storage-indexer-host.mjs`; host distro PostgreSQL 18; the package's pinned indexd. Admitted only by the platform host policy for this host's registry id, with the descriptor signed by its registry operator. |
| **Windows Shield host** (nucbox-k11-4) | not natively | The role relies on systemd credentials, Unix-socket peer authentication and the POSIX pipeline for backups; none is ported to the Windows node host. On that HARDWARE it runs only inside a Linux Enclave host instance (e.g. a Hyper-V Linux VM) registered under its own endpoint. That instance shares the machine's failure domain. Today's `enclave-storage` VM there is NOT registered or admitted, and runs the legacy single unfenced indexd. |
| **Pixel pVM host** | not supported | CPU-only, one protected VM per app, no persistent native host services. It is not a durable-state host. |
| DigitalOcean machines | **refused** | `preflight` refuses DigitalOcean DMI and a declared DigitalOcean provider. They remain minimal WireGuard transport. |

indexd and PostgreSQL are native host processes, not Enclave Wasm apps; no Wasm build exists or is claimed. sia-s3 stays
an Enclave Wasm app (per-app guest).

## Failure domains (evidence, not assumptions)

- Required: N >= 3 replicas, W = 2, on hosts that differ in site, provider/uplink and power.
- Known hosts:
  - metal0 runs on this workstation ('warden-host': 128 GiB RAM, 32 CPUs, 335 GB free, read-only observation);
  - the minipc hosts nucbox-k11-4;
  - the Pixel.
- There is NO evidence that metal0 and the minipc are in different sites or on different power or uplinks, and no
  third Linux-capable Enclave host is known. The deployable placement therefore currently gives at most two hosts,
  possibly ONE failure domain. Distinct domains need new hardware or new operators. None is invented or required
  here, and buying is not authorized.

## Production prerequisites (root-owned; none performed)

1. Each indexer host: an Enclave host REGISTRY entry (its PUBLIC_URL), active, admitted by the platform policy.
2. Each replica:
   - its operator signs the descriptor (`descriptorBytes`) with that host's registry operator key;
   - the host owner installs the package (rc2 tarball by sha256), `host.json` and `replica.env`;
   - the encrypted credentials are created ON the host (a new `indexd seed` phrase per replica);
   - `init`, then `systemctl enable --now enclave-storage-indexer-host@<r>`.
3. Fund each replica wallet on Sia (on-chain; root).
4. sia-s3: publish the corrected artifact (00e9cde0..., or a re-validated rebuild); its config lists the replicas
   (owner secret $SIAS3_REPLICAS).
   - Migrate from the current single indexer by membership changes, one at a time.
   - The live adapter is a separate deployment; repointing its backend is a separate, explicit owner step.
5. Public ingress for each replica's advertiseURL:
   - It must NOT ride the DigitalOcean fleet. Today sia.enclave.host resolves only to DigitalOcean.
   - The Enclave network's guest egress also exits on DigitalOcean.
   - Owned by the discovery/DNS and network workers. Storage's request is in work/hosted-service-placement-interface.txt
     ("STORAGE INDEXER INGRESS").
6. PostgreSQL 18 from the host distribution (the lifecycle test used the verified Arch 18.6-2 packages extracted
   under work/; a host installs its own distro packages).

## Deployed coverage

- None.
- Source support: the role, the package (rc2) and its tests.
- Fixture evidence:
  - the real-process host-role test (local policy world, real PostgreSQL 18.6, real indexd G-C2);
  - place3 (component writer-fencing and cold recovery on real G-C2 indexd + RHP4 hosts).

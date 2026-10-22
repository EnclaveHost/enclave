# indexd metadata replicas: deployment and recovery package (NOT ACTIVATED)

Package directory: `work/indexd-replica-rollout`. Nothing in it has run against production. There has been no SSH,
no chain write, no key read and no service restart. Activation belongs to root and is gated (section 7).

## 1. Facts this plan is built on (measured, not assumed)

- **Live storage today:** a single indexd v0.6.0 writer, with PostgreSQL in Docker, on the `enclave-storage` VM
  (4 GiB RAM, no swap) on the Windows minipc. Root's read-only live measurement, 2026-10-20T09:54Z
  (`outputs/storage-indexd-review/live-footprint.json`):
  - indexd: cgroup MemoryPeak 380.4 MiB, VmHWM 424.2 MiB, RSS 119 MiB idle; unit cap MemoryMax 1G, GOMEMLIMIT 512MiB;
  - PostgreSQL container: 114.5 MiB (cap 1g); an earlier peak was 147.2 MiB;
  - database 29.8 MB; 1,491 objects, 559 slabs, 71 contracts, 1 account; state 561 MB + 87.7 MB.
  - These are an idle observation plus high-water history, NOT a production or mainnet-recovery load envelope.
- **Providers** (`provider-capacity.json`, `provider-services.json`): each has 961.5 MiB RAM and **306.7–334.8 MiB
  available**, no swap, and about 6.7 GB of free disk. The memory is used by resident services (bootstrap
  gateway/TLS, provider routing, DNS, public directory, custody, Caddy) that must not be stopped.
- **Requirement per independent replica** (`capacity/capacity.json` v2): the LIVE PRIMARY's caps, indexd
  `MemoryMax` 1 GiB (`GOMEMLIMIT` 512 MiB) + PostgreSQL 1 GiB, not overcommitted, + 256 MiB margin =
  **2,304 MiB available memory, plus 3.5 GiB of free disk.**
  - A smaller budget needs a representative mainnet recovery/sync/load measurement, which does not exist.
  - v1's 320 MiB indexd cap was BELOW the measured high-water and is withdrawn (`capacity/history/`).
- **Verdict: INSUFFICIENT.** No provider fits; the shortfall is about 1.97–2.0 GiB each. Even the measured floor
  (indexd VmHWM 424 + PostgreSQL 147 = 571 MiB) exceeds every provider's available memory.
- **Running extra replicas as processes or VMs on the minipc** does NOT remove the minipc failure dependency (same
  power, network, Windows host and site). Such a replica is useful only as a staging or verification node and is
  never counted toward resilience.

## 2. What "replica" means here

Each replica is an INDEPENDENT indexd: its own recovery phrase and wallet, its own contracts with hosts, its own
PostgreSQL and its own chain state.

- The same signed account identity (the deployment's app key) is registered on each replica.
- sia-s3 (the SDK worker's candidate) writes to all replicas under the writer fence (indexd-fence: receipt, exact
  credential, R5 hash) and acknowledges only on a quorum (W=2 of 3).
- **Never clone the primary's database or recovery phrase into a replica.** Two indexers would then revise the same
  contracts.
- Each replica pays hosts for the sectors it pins. Storage spend scales with the number of replicas, and each
  replica's wallet needs its own Siacoin funding. That is an on-chain action reserved for root (gate G6).

## 3. Release

- `release/indexd-v0.6.0-fence.1-linux-amd64`, sha256 `61413110dc4426e43b030b418bfeb314b0dc0ea9c09f82dc48523ec862335901`
  (`release/SHA256SUMS`, `release/BUILDINFO.json`).
- Source: the frozen indexd-fence tree (patch `3353bbf722f48580…` over v0.6.0 ddaf24b), copied into `src/`.
  - Only `build/meta.go` differs, written deterministically because the tree has no `.git` for `go generate`.
- Recipe (`release/build.sh`): the upstream flags (`-tags 'netgo timetzdata' -trimpath -a -ldflags '-s -w'`) plus
  `CGO_ENABLED=0 -buildvcs=false -buildid=`, run through the shared queue (768 MiB).
- **Reproduced:** an independent rebuild with an empty, on-disk Go cache is byte-identical.
- `indexd version` → `v0.6.0-fence.1`, commit `ddaf24b…+indexd-fence.patch.3353bbf722f48580`.
- The bundled GeoLite2-City database has sha256 `18bf1695…`, identical to the live one. It must be pre-placed:
  indexd downloads it from MaxMind if it is absent, and preflight refuses otherwise.

## 4. Database migration, backup and rollback

- **Up (26 → 27):** the binary applies `migration/up-26-to-27.sql` itself at startup, in ONE transaction together with
  `db_version = 27`. A crash mid-upgrade leaves version 26 intact.
  - The migration is purely additive: new nullable or defaulted columns, two CHECKs and one partial unique index.
  - Existing objects, slabs, sectors, contracts, accounts (signed identities), sharing and blocked rows are untouched
    (digest-verified).
- **Down (27 → 26):** `migration/down-27-to-26.sql`, applied with `psql --single-transaction`.
  - It drops only the fencing objects and resets `db_version = 26`. Stock v0.6.0 refuses any newer db_version, so a
    binary-only rollback is impossible.
  - Discards: fences, receipts, seq numbers. Keeps: all data, including objects written under a fence.
  - Precondition: every fenced writer is stopped. Afterwards an unfenced writer is accepted again.
  - Verified: the schema after rollback equals the stock v26 schema exactly.
- **Backup** (`replicactl backup`): only with indexd stopped (quiesced).
  - Contents: `pg_dump` (custom format, run inside the database container with its own credentials), `consensus.db`,
    and `manifest.json` with sha256 values and the acknowledged-metadata digest (`migration/digest.sql`).
  - `verify-backup` restores into a scratch database and compares digests.
  - Production backups additionally follow the existing encrypted, off-host pattern
    (`work/storage-vm/backup-encrypt.py`, `replicate-backup.py`). No key material leaves root's control.

## 5. Ports, TLS, users, state

| Item | Choice |
|---|---|
| Admin API | `127.0.0.1:9980` only, basic auth with a per-replica generated password (0600). Platform admin reaches it over existing SSH. Byte-identical to stock: block/unblock, account delete, quotas, host bans all retained |
| Application API | `127.0.0.1:9982` behind Caddy TLS (ACME) at `<PLACEHOLDER_REPLICA_HOSTNAME>` on 443 |
| Sia P2P syncer | `:9981` (outbound sufficient) |
| PostgreSQL | `127.0.0.1:5432` in the pinned production image `postgres@sha256:74935e72…`, read-only root, tmpfs runtime dirs |
| Service user | `enclave-indexd` (no login shell); `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` |
| State | `/var/lib/enclave-indexd/state` (0700): `consensus.db`, GeoLite. PostgreSQL data: `/var/lib/enclave-indexd/postgres` |
| Config | `/etc/enclave-indexd/indexd.yml` (root:enclave-indexd 0640) and `postgres.env` (0600); placeholders in `config/indexd.replica.yml.template` |
| Releases | `/opt/enclave-indexd/releases/<sha256>/indexd` plus an atomic `current` symlink |
| Activation guard | `/etc/enclave-indexd/ALLOW_LIVE_START` (same guard as the live unit) |

## 6. Sequencing that cannot lose acknowledged writes

- **P1 — Upgrade the primary in place (v26→v27; wire-compatible).**
  1. Stop the writer.
  2. `replicactl backup` + `verify-backup` + the encrypted off-host copy (existing scripts).
  3. `install` (sha256 checked), then `upgrade`: switch, start, the binary migrates, then readiness requires
     db_version 27 AND the acknowledged-metadata digest equal to the backup's.
  - Stock (unfenced) sia-s3 keeps working unchanged (SDK `real_indexd::` 7/7 against indexd-fence).
  - Rollback: `replicactl rollback` (section 4).
- **P2 — Bring up replicas (only on capacity-qualified hosts, gate G1).**
  - Order: new wallet (`indexd seed` on the host) → config from the template → `consensus.db` seeded from the
    operator's verified snapshot → sync forward from peers → wallet funded (G6) → contracts formed → app key
    registered (admin connect key) → readiness.
  - No data yet, and no client is pointed at it.
- **P3 — Mirror, then fence.**
  1. sia-s3 replicates the primary's objects and slabs to the replicas while the primary stays the only writer that
     acknowledges. This is the SDK's tested `real_migration_from_one_indexer_to_three`, repaired until nothing is
     left to reconcile.
  2. Only then switch to fenced quorum mode: raise the fence on all 3; list with `/seq/objects`, or `/current/objects`
     with `blocked=true`; acknowledge on W=2.
  - Why nothing acknowledged is lost:
    - during mirroring, every acknowledgement still comes from the primary, and mirroring copies acknowledged state;
    - after the switch, an acknowledgement needs W=2 under the installed fence;
    - delayed and stale writers are refused (indexd-fence E2E and SDK `real_fence_` 4/4).
- **P4 — Operate.** Platform-wide administration fans out to EVERY replica. Delistings, object blocks, account
  actions and host bans are applied through each replica's admin API. The SDK fails closed when replicas disagree,
  so a block applied to one replica only stalls that account rather than bypassing the block.

## 7. Activation gates (all required; root decides)

- **G1 — capacity.** At least 2 replica hosts with ≥ 2,304 MiB MemAvailable and ≥ 3.5 GiB disk, outside the
  minipc failure domain (`capacity/capacity.json` v2). No existing provider qualifies today. A smaller per-replica
  budget is acceptable only with a representative mainnet recovery/sync/load measurement.
- **G2 — SDK two-starter liveness. MET on real indexd (run `sk1`, 2026-10-20).**
  - Setup: the SDK worker's frozen driver (FINAL-tree `323d3038…`, `bin/sdk-final-driver` `a2f0deda…`) against the
    release source tree, with 3 indexers and real RHP4 hosts.
  - Result: exactly one starter is fresh, and only its put-if-absent create succeeds (`fresh=[true,false]`,
    `create=[true,false]`). The other is superseded and fenced. All 3 indexers hold the winner's fence, and its
    membership is committed (4 objects per replica).
  - The earlier runs ifx6 and ifx8 (`[false,false]`) are history, from the uncorrected driver.
- **G3 — SDK blocked-list behaviour. MET on real indexd (runs `sk2`, `sk3`, `sk3x`); the post-unblock gap is CLOSED.** Blocks are placed and
  lifted through each indexer's REAL admin API (`/objects/blocklist`).
  - `sk2`, one indexer:
    - after a block, the cold boot is not ready and lists nothing;
    - a plain load fails closed with `AdminBlocked`;
    - after an explicit unblock, the replica rejoins and the acknowledged value reads back;
    - the server keeps the object throughout.
  - `sk3`, three indexers, W=2: r1 blocks its OWN v2 object. The replicas' object IDs are pairwise disjoint, and the
    blocked key exists only on r1.
    - restart without r0 → not ready (v1 is never served);
    - with r0 back → ready, k at v2 but refused with 451 (0 bytes);
    - repair never copied v2 to r2.
  - `sk3x` (closes the post-unblock gap):
    - Driver: a TEST-ONLY derivative (`storage-real-indexd/sdk-derivative-sk3x`): the frozen tree plus ONE appended
      test; no production SDK change.
    - Scenario: the same sk3 scenario plus a key `d` deleted while r2 was down. Explicit real admin unblock on r1.
    - Repair: pass 1 re-lists r1, copies v2 to r2, and writes the deletion floor and reclaims `d`; pass 2 is quiet.
    - Result: ready, nothing withheld or left out, the exact v2 is read ("v2"), `d` is not resurrected, fresh.
      Every replica, listed afresh, holds k at v2 with no live `d`. A final repair is quiet.
    - Server side: all three indexers agree (seq 10, 7 events, 2 deletions) with empty blocklists.
- **G3b — regressions on the final SDK. MET:** `real_fence_` endpoint/delayed-writer/listing 3/3 (`sk4`), and
  `real_indexd::` 7/7 in unfenced u1 mode (`sk5`).
- **G8 — runtime no-clone and final front generation binding: NOT MET.**
  - The driver's `accept_unevidenced_isolation: true` is DRIVER ONLY. These runs are NOT clone or isolation
    evidence, and no risk flag may be set in production to stand in for it.
- **G4 — SDK pinned to the R5 hash. MET for FINAL-tree `323d3038…`:** every fenced mutation in sk1–sk4 was accepted
  by the R5 indexd. The deployed artifact must be built from exactly that tree.
- **G5 — primary upgrade rehearsal** on a restored copy of the latest live backup with this package (`verify-backup`
  + upgrade on the scratch copy), reviewed by root.
- **G6 — wallet funding** for each replica (on-chain, root only), and DNS/TLS names.
- **G7 — admin fan-out procedure** accepted. Platform administration is preserved on every replica.

## 8. Alternative while capacity is insufficient (no new purchase assumed)

- **A — Today, without new capacity:**
  1. Upgrade the primary only (P1); it is wire-compatible and rollback-tested.
  2. Keep cold recovery: the verified encrypted backups already on the 4 providers, plus this package staged there
     (binary, units, templates; inert without the ALLOW file and secrets).
  - Recovery time then depends on obtaining a host with ≥ 2,304 MiB available (capacity v2).
  - This is cold recovery, NOT resilient live replication; the minipc remains the single live writer.
- **B — Needs user authorization for spend:** at least 2 hosts, outside the minipc failure domain, with ≥ 2,304 MiB
  available after their existing services.
  - Provider services use about 627–655 MiB today, so a 4 GiB-class host (like the live VM) is the conservative
    size.
  - No RAM figure for a resized host is assumed; it must be measured after any resize.
  - Then run P2–P4.
- **C — Measure-first option:** a lean profile (smaller caps) is NOT adopted and NOT believed to fit 1 GiB hosts:
  the measured floor alone (571 MiB) exceeds their available memory. Any smaller cap needs a representative mainnet
  recovery/sync/load measurement and root's approval.

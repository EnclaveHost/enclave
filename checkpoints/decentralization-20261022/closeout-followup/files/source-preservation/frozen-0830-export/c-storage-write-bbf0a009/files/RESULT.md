# Storage distributed-write release: cutover package (RESULT, 2026-10-23)

**Status.** Source and fixture evidence only. Nothing was run against production: no SSH, no wallet, no signature, no
funding, no host activation, no push.

**Commit.** Git repository `storage-write-release/`, branch `storage/write-release`:
- **`6fd7a9299c53121142ab59d8ff9a7406c1f2b845`**, 42 files, +6464.
- Author and committer: SteveDeFacto. No origin.
- Patch: `storage-write-release.patch` (`git format-patch -1`), sha256 `95bbbcb0951448254a6f7eaa36a7edcefc098a87d24cdf1fff4e3ec0df65c9a7`.
- Scans on exactly the 42 committed files: `.githooks/scan-crypto-keys.py --files` exit 0; `gitleaks dir` with
  `.gitleaks.toml` found no leaks (`logs/gitleaks.json` = `[]`).
- Root's notes (`ROOT-*.txt`) are not committed.

**Untouched (other owners):**
- F's host-service trees;
- the immutable C sources and evidence (`windows-host-services-compose`);
- the original fresh-backup tools (`storage-fresh-backup/*`, B2 runner `62f43690`);
- `storage-host-role`, `storage-closeout`, `storage-rollout-inventory`;
- main.

## 1. Live vs fixture

**LIVE** (root's receipts; not re-measured here):
- **Primary:** the minipc VM `enclave-storage`, indexd `2c0e5b06` at schema 28. Controller `1543577f`, migration run
  `20261022T192622Z-7c184876`.
- **Accounts:** 0 CAS-enrolled, 0 fenced. The 26→27→28 migration is DONE and is not repeated here.
- **Data at the last backup:** 1491 objects, 562 slabs, 78 contracts, 1 account (v26 backup `603f3b39`).
- **Recovery:** an indexer-free whole read of the frozen snapshot succeeded (1488 keys, 21 445 494 044 bytes). That is not
  distributed writes.
- **Client:** sia-s3 0.1.8 (`d1ddecfe`), unfenced; deployment `0xef514ed3…b238`.
- **Ingress:** `sia.enclave.host` reaches the VM only through reverse SSH tunnels to the four DigitalOcean machines.
- **Policy:** root's preflight (05:51Z, block 52972683) found the global host policy UNANCHORED, i.e. on but not activated.
  Storage replicas are then admitted on their registry row alone; policy bans act only after root's reviewed anchoring.

**FIXTURE** (this package): real components (the exact live 0.1.8 wasm, the final `00e9cde0`, indexd built from the
c2-enclave source at schema v28) on loopback.
- Three indexers with their own databases and wallets; 30 RHP4 hosts.
- Private network and PID namespaces; generated keys and bytes.
- It proves the mechanism and the exact bytes, not real hosts, providers or failures.

## 2. Release blockers found and fixed

| # | blocker | evidence | fix |
|---|---|---|---|
| 1 | The prepared C2 catalog config `7b9e7e75` hard-codes `"writeQuorum":2`: the N=1 enrolment step refuses ("writeQuorum must be 1-1", sia-s3 `config.rs:263-264`). Catalog versions are immutable. | m3 B: the real component refuses and enrols nothing | `client/catalog-config.c2.json` **`f6b48940`** = the same bytes minus `"writeQuorum":2,` (byte-exact deletion, asserted). The majority default serves T1 W1/N1, T2 and the final W2/N3 with ONE catalog version; the owner changes only `$SIAS3_REPLICAS`. |
| 2 | The documented "1→3, then retire the minipc" plan ends at N=2/W=2: no write fault tolerance. | arithmetic | `cutover.py` refuses T4 unless at least 3 new members remain. |
| 3 | The B2 backup runner `62f43690` copies `/opt/enclave-indexd/indexd` (the v26 binary). Since the migration the unit runs `releases/current/indexd` (`2c0e5b06`). | provenance test: it refuses the release hash, or bundles the old binary | `backup/runner/vm_fresh_backup.v3.py` **`8fe10e08`** = `62f43690` plus that one path (diff: 1 line + comment). |
| 4 | (root's review of frozen `4ba07638`) `verify_archive.py` `b4f71bbb` stamps `verifiedAt` per verification and drops the authenticated `capturedAt`, so re-verifying an old archive looked fresh. | provenance test: the v1 receipt has no capture time and is NO-GO | `backup/local/verify_archive.v2.py` **`7d2c5722`**: the authenticated manifest's `capturedAt`, run, source, quiesce and binary; PASS needs the manifest bound to the run. The preflight judges capture age (≤ 2 h, not future) separately from verification age (≤ 2 h, after the capture). |
| 5 | (root's review) T1 order: the backup preceded the legacy-writer stop; the rollback criterion was readiness. | e1: enrolled, never ready | Order: quiesce → back up → preflight (legacy stopped BEFORE the capture; live counts = backup counts) → switch. `cutover.py rollback-decision` reads only the live fenced/CAS counts (LEGACY_REDEPLOY_SAFE / FORWARD_ONLY / UNKNOWN). Restoring the backup after enrolment loses every write after `dataLossBoundary` = capturedAt; it is root's explicit decision, never routine. Sticky CAS is preserved; no force-unenrol. |
| 6 | Stale pins: `storage-host-role/PLACEMENT.md` and `storage-closeout/RECIPE.md` §2 name rc2 `3b78d4f1` (stock indexd). | lineage | `PINS.json` (20 files) names rc3 `dc2d018f` / manifest `e903e94c` (indexd = the live `2c0e5b06`). The other owners' files are not edited. |

**Reconciled, no change needed:**
- The host-software closure `83c95b4b` / `658e5a44`: its 9 source files are byte-identical in C `0757085e` and the
  checkpoint `8ac1aa51`, and its 7 npm packages match the candidate lockfile.
- The role `20abb681` is identical in every tree.
- The role's doc/code mismatch (ROOT-LIFECYCLE-REVIEW: `:288` vs `:376`) is a comment only. It is left as
  `package/proposals/role-comment.patch`, NOT applied, because applying it would re-pin the reviewed closure.

## 3. Tests (all through `claude-test-queue.py`; 98/99 never counted)

| run | what | lane / peak | result |
|---|---|---|---|
| **m3** (`rehearsal/main_migrate16.py` `5a92d837` + `_base.py` `bd92f094`) | P: 0.1.8 writes 3 legacy objects (100 KB, 12 MiB, 3 MiB) to r0. B: the prepared config refuses and enrols nothing. T1: the corrected config + lease16 fact → first fenced boot, epoch 1, r0 enrolled, every byte back, write. T2: r1+r2 join by secret update, serve and write while migrating, commit (epoch 3), r1/r2 enrolled at the same generation, one replica down still writes. T4: r0 retiring → commit (epoch 4), [r1,r2] and r0 STOPPED → every key byte-exact from r1+r2, write. O: 0.1.8 cannot write to a new enrolled replica. | 1536 / **1533 MiB**, 1105 s | **42/42 PASS**, cleanup complete |
| **e1** (`main_enrollfail.py` `71628f3b`) | C2 SIGKILLed 0.071 s after logging its installed fence, NEVER ready. The account IS enrolled (CAS, claim fence). `rollback-decision` says FORWARD_ONLY. A redeployed 0.1.8 PUT gets 500 and indexd is unchanged. The C2 restart is ready, reads the legacy bytes and writes. | 1536 / 701 MiB | **11/11 PASS** |
| u9 `package/tests/test_cutover.py` | stage secrets and refusals; real captures: the v26 VM state and v26 backup are NO-GO; `rollback-decision`; T1 verify on the REAL l1 `/healthz`; t1/t2/t4a/t4b verify on the REAL m3 captures, with cross-stage negatives; pins vs workspace; tampered copy | 512 / 80 MiB | **11/11 OK** |
| u9 `package/backup/test/test_backup_provenance.py` | v28-shaped fake VM → v3 runner → PINNED `pull_encrypt` (real gpg, throwaway key) → v2 verifier → preflight GO. NO-GO for: captured 3 h ago (verification age allowed), future capture, legacy stopped after the capture, a write after the capture, enrolled/fenced, zone-less time. The original v1 verifier: no capture time, NO-GO. The original B2 runner: refuses, or bundles the v26 binary, NO-GO. | 512 | **3/3 OK** |

**Superseded runs, kept for the record:**
- **m1:** 14 hosts were too few for sia-s3 uploads. Retired, and its own cleanup ran. Blocker B was already reproduced
  there.
- **m2:** guard-STOPPED at 1556 MiB > 1536 during T2. NOT a pass; 23 checks passed before the stop. The fixture
  PostgreSQL footprint was then reduced (`io_method=sync`, autovacuum off, `shared_buffers` 8 MB, `max_connections` 120)
  without changing any check.

**m3 margin:** m3's 1533 MiB is 3 MiB under the cap. A rerun may be guard-stopped; that would not be a pass.

**Observed timing (FIXTURE, production defaults):**
- Each membership commit took ~5 min (repair every 300 s).
- The epochs were 1, 3, 4. The verifiers require at least 1, 2, 3 plus the exact set.

## 4. Package (`package/`)

**Runbook and pins:**
- `CUTOVER.md` `4b7f065e`: root's runbook.
  - §0 live baseline;
  - §1 blockers;
  - §2 S1-S7 per new replica (preflight, inert rc3 install, descriptor signed by the host's registry operator, config and
    a NEW phrase, start, funding, app-key registration), with verify and rollback for each;
  - §3 client publication;
  - §4 T1 (quiesce/backup/preflight/switch, the rollback table);
  - §5 T2;
  - §6 T3/T4;
  - §7 post-cutover gates;
  - §8 external requirements.
- `PINS.json` `c892b0d6` and `tools/verify_pins.py` `84760baf`.

**Tools:**
- `tools/cutover.py` `1b05047c`: `replicas`, `t1-preflight`, `rollback-decision`, `verify --stage t1|t2|t4a|t4b`. Offline;
  reads only files root captures with the existing read-only tools.
- `backup/`: the v3 runner and v2 verifier above, the fake-VM fixture (copied fakes; the docker fake gained per-table
  counts) and the provenance test.

**Other files:**
- `client/catalog-config.c2.json` `f6b48940`.
- `interfaces/F-host-services.md`: F's required interface.
- `proposals/role-comment.patch`.

**Package hashes (unchanged inputs):**

| item | hash |
|---|---|
| role package rc3 | `dc2d018f7415cb2fc32a0f0bd937472a825ab1bfe191bee94f41533c4515de4a`, manifest `sha256:e903e94c876af0f0ea6fd243b72d5c2c35d5e6af79ad033a2e6afbfe097f33fc`, indexd `2c0e5b06…23d7` |
| host software | `83c95b4b…b3b7`, manifest `658e5a44…bf98` |
| role | `20abb681…d271` |
| client | `00e9cde0929dc7b8726ca4b7b9c9afb51ec4bf6d952039c907c032256ec79afc` (never `aa15a054`) |
| activation tools | host-preflight `16e9e707`, gate-preflight `6792c5a5`, descriptor `cb3611a5`, render-config `a6b62d50` |
| primary tools | controller `1543577f`, `vm-state.sh` `5ac71122` |
| backup | `pull_encrypt` `ad297d48`, `common` `be0a9b0c` |

## 5. F's interface (`interfaces/F-host-services.md`; F's tree not edited)

Per storage replica:
- A public https name routed by WireGuard transport only to the replica's loopback `appAddress`, e.g. a `store` label
  granted at platform-policy-gated exits.
- TLS terminated on the host (service-tls).
- At least one non-DigitalOcean exit.
- One host-id rule: B7, registered endpoint without a trailing slash until F settles it.
- The same admission authority.

## 6. Activation order (root) and rollback

**Order:**
1. S1-S7 on ≥ 3 new replica hosts.
2. P: catalog publication, plus the deployed front/relay binding.
3. T1.1-T1.5.
4. T2.
5. T3: the adapter is unchanged.
6. T4a, then T4b. Then stop the minipc indexd; keep the VM, data and phrase until the post-cutover gates pass.

**Rollback per step:** in `CUTOVER.md`. The irreversible point is T1 enrolment, decided by `rollback-decision`. After a
T2/T4 commit it is forward only (`retiring`), never editing the list back.

## 7. External requirements after this source work (real; none invented)

1. **Hosts:** ≥ 3 storage replica hosts in DISTINCT site/provider/power domains, registered and running the role. Only
   metal0 is a Linux Enclave host today. The minipc shares its site; there is no third. No purchase is authorized.
2. **Ingress:** a non-DigitalOcean https URL per replica (F's interface above).
3. **Signatures:**
   - each host's registry operator signs its descriptor (metal0 `0xC9D0…E6aB`);
   - the slug owner `0x0b2d…eE61` publishes the catalog version;
   - the deployment owner updates the secrets and switches the version.
4. **Funding:** Sia funding of each replica wallet (spend; not authorized). Each replica has its own NEW phrase and
   wallet; nothing is copied.
5. **Front:** the front + relay lease16 writer-authority binding deployed (committed in `6f2c7da46`; no image or
   deployment evidence).
6. **Backup:** root's fresh coupled v28 backup with the v3 runner and v2 verifier, AFTER the legacy writer stops.
7. **Policy:** for policy bans of storage replicas (G4), root's reviewed global host policy anchoring (book setMany,
   carried off-DigitalOcean). This is not needed for T1/T2.
8. **Storage paths:** `/var/lib/enclave-storage-indexer/<r>` (≥ 3584 MiB + growth) and PostgreSQL 18 on each host.

## 8. Post-cutover gates (explicit; NOT satisfied by any fixture here)

| gate | what |
|---|---|
| G1 | a fresh distributed write, held by every member (per-replica `recovery export`) |
| G2 | the loss of one production replica host: reads and writes continue |
| G3 | with the four DigitalOcean machines unreachable, storage still serves |
| G4 | an admin ban of one replica stops it, and the set continues; needs the anchored policy |
| G5 | cold recovery of the NEW set from Sia hosts |

None of these is claimed.

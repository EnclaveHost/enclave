# Storage distributed-write cutover: root's runbook (prepared 2026-10-23; NOTHING here was executed against production)

**What this package moves.** The EXISTING live storage gains independent indexers and is then distributed across them:
- **From:** one indexd (c2-enclave `2c0e5b06`, schema 28, upgraded 2026-10-22, 0 accounts enrolled) on the minipc VM
  `enclave-storage`, written by the unfenced sia-s3 0.1.8 deployment `0xef514ed3…b238`.
- **To:** sia-s3 C2 `00e9cde0` writing W-of-N to independent indexers, each running the storage-indexer host role (its own
  PostgreSQL 18, phrase, wallet and contracts) on an admitted Enclave host.

**Ownership:**

| who | does |
|---|---|
| root | every live step |
| each host's registry operator | signs |
| the sia-s3 slug owner `0x0b2d…eE61` / deployment owner | publishes and redeploys |

**Forbidden:**
- no DigitalOcean application hosting;
- no ledger 17;
- no new contract;
- no wallet or phrase copied to a second active writer;
- no account enrolled before T1 (enrolment is sticky).

**Two kinds of evidence, never mixed:**
- **LIVE:** what root measured on production (§0).
- **FIXTURE:** the rehearsal of every step below on loopback indexers (`rehearsal/`, RESULT.md). Fixtures prove the mechanism
  and the exact bytes. They prove nothing about real hosts, providers or failures: those are the post-cutover gates (§7).

**Timing and epochs (FIXTURE rehearsal m3, production config defaults: repair every 300 s):**
- every membership step took about 5 minutes to commit: T1 epoch-1 record 310 s; T2 commit 322 s; T4 retirement 320 s.
- The epochs observed were 1, 3 and 4 (not 1, 2, 3). The verifiers require AT LEAST 1, 2, 3, plus the exact replica set
  and admission.

All pins are in `PINS.json`; `tools/verify_pins.py` checks them (all pinned paths, or one staged copy). Step verifiers are in
`tools/cutover.py` (offline; they read files root captures with the existing read-only tools).

## 0. Live baseline (LIVE; outputs/decentralization-audit/storage-production-preparation-20261022.json)

- **Primary:** release `current` = `2c0e5b06…23d7`, schema 28. Controller `1543577f`, run `20261022T192622Z-7c184876`.
  Both v28 post-checks passed, NRestarts 0, `casEnrolledAccounts` 0, `fencedAccounts` 0.
- **Data:** 1491 objects, 562 slabs, 78 contracts, one account (v26 backup `20261022T191749Z-603f3b39`). An indexer-free
  whole read of the frozen snapshot succeeded (1488 keys, 21 445 494 044 bytes). That was a read-only recovery on the same
  host, NOT distributed writes.
- **Ingress today:** `sia.enclave.host` reaches the VM's Caddy only through reverse SSH tunnels to the four DigitalOcean
  machines. It is the EXISTING primary's URL in T1/T2. A NEW replica may never use it (`cutover.py` refuses).

## 1. Release blockers found and fixed here

1. **The prepared C2 catalog config could not boot T1.**
   - `storage-public-read/candidate-catalog-config.json` `7b9e7e75` hard-codes `"writeQuorum":2`. With T1's single
     replica the component refuses: "writeQuorum must be 1-1" (sia-s3 `config.rs:263-264`).
   - Catalog versions are immutable, so publishing it would have stranded T1.
   - **Fixed:** `client/catalog-config.c2.json` `f6b48940` is the same bytes minus `"writeQuorum":2,`. The component then
     takes the majority of the listed non-retiring members, so ONE catalog version serves T1 (W1/N1), T2 (majority of N) and
     the final set (W2/N3). The owner changes only the `$SIAS3_REPLICAS` secret between stages.
   - **Proven on the real artifact** (rehearsal B, T1-T4): `7b9e7e75` refuses to start and enrols nothing; `f6b48940` runs
     every stage.
2. **The documented "1 → 3, then retire the minipc" plan ends at N = 2, W = 2.**
   - It tolerates NO member loss for writes.
   - `cutover.py` refuses T4 unless at least THREE new members remain. Keeping the primary as a member is the other option,
     only if it is accepted as an independent failure domain, which it is not today.
3. **Stale pins elsewhere.** `storage-host-role/PLACEMENT.md` and `storage-closeout/RECIPE.md` §2 still name rc2
   `3b78d4f1` (stock indexd `e6e812fd`). The release is rc3 `dc2d018f` (manifest `e903e94c`, indexd = the live primary's
   `2c0e5b06`). PINS.json supersedes both; those files are not edited (other owners).
4. **No bounded, tested GO/NO-GO existed for the irreversible step.** `cutover.py t1-preflight` and `verify` add one
   (tested on real captures).
5. **The B2 backup runner cannot back up the v28 primary.**
   - `62f43690` copies `/opt/enclave-indexd/indexd`, the v26 binary. Since the migration the unit runs
     `/opt/enclave-indexd/releases/current/indexd` (`2c0e5b06`) through its drop-in.
   - So with the live release's hash it refuses, and with the old hash it bundles a v26 binary with a v28 database.
   - **Fixed:** `backup/runner/vm_fresh_backup.v3.py` is `62f43690` plus that one path. Shown on the real runner in a
     fixture: the v3 runner bundles the release; `62f43690` refuses, or bundles the old binary, which the preflight
     rejects.
6. **The backup verifier dropped the capture time** (root's review of the frozen tool `4ba07638`).
   - `verify_archive.py` `b4f71bbb` stamps `verifiedAt` per verification, so a re-verified old archive looked fresh.
   - **Fixed:** `backup/local/verify_archive.v2.py` carries the authenticated manifest's `capturedAt`, run, source and
     binary. The preflight judges capture age separately, and requires the legacy writer stopped before the capture and
     nothing written since.
   - The original tools are unchanged.
7. **T1 order and rollback** (root's review): quiesce → back up → preflight → switch. Rollback is decided by the
   fenced/CAS state (§4).

**Not blockers, reported:**
- **Role comment drift** (ROOT-LIFECYCLE-REVIEW): `storage-indexer-host.mjs:288` says a stop "waits for the in-flight
  decision"; the code (:376) intentionally does not await a DECIDING tick. Behaviour is reviewed and tested; only the
  comment is wrong. Correcting it would re-pin the reviewed host-software closure, so it is left as
  `proposals/role-comment.patch` (not applied) for the next role revision.
- **The closure `83c95b4b`/`658e5a44` is reconciled:** its 9 source files are byte-identical in the candidate (`0757085e`)
  and the checkpoint branch (`8ac1aa51`), and its 7 npm packages match the candidate's lockfile versions.

## 2. Stage S: new replicas (per host; repeat for EACH new replica, never two on one failure domain)

**Inputs:**
- rc3 tarball `dc2d018f…`, manifest pin `sha256:e903e94c…`;
- host software `83c95b4b…` (manifest `658e5a44…`);
- `storage-closeout/activation/` tools (pinned).

**Steps** (the existing `storage-closeout/RECIPE.md` §1-3, with rc3 substituted):

| step | what | who / verify / rollback |
|---|---|---|
| S1 preflight (read-only) | `host-preflight.sh <PG_BIN> <HS>` and `gate-preflight.mjs --host-software <HS> --endpoint <exact registered endpoint>` | root. Verify: `ADMISSIBLE`; PostgreSQL 18; systemd-creds; MemAvailable ≥ 2304 MiB; /var/lib ≥ 3584 MiB. Refusal: DigitalOcean DMI or provider. Rollback: none (nothing changes). |
| S2 inert install | rc3 under `/opt/enclave-storage-indexer/e903e94c876a`, HS under `/opt/enclave-host-software/658e5a443480`; unit NOT enabled | root. Verify: `sha256sum -c` of both manifests. Rollback: delete the two directories. |
| S3 descriptor | `descriptor.mjs request` → the host's REGISTRY OPERATOR `personal_sign`s the exact bytes → `descriptor.mjs assemble`. `applicationAPI` = the replica's NON-DO https URL (§6) | operator signature (no funds). Verify: `storage-indexer-host.mjs check host.json` prints `admit: true`. Rollback: discard the file (nothing published). |
| S4 config + credentials | `render-config.mjs` with the REAL failureDomain {site, provider, power}. A NEW phrase (`indexd seed`) on the host, `systemd-creds encrypt`ed. Never another replica's phrase, never the minipc's | root on the host. Verify: render-config refuses placeholders and DigitalOcean. Rollback: delete `/etc/enclave-storage-indexer/<r>`. |
| S5 start | `init`, then `systemctl enable --now enclave-storage-indexer-host@<r>` | root. Verify: the role's status shows admitted and indexd up, the app port answers. Rollback: `systemctl disable --now`; the replica holds no production data until T2. |
| S6 funding | the replica wallet's Sia funding, ~14 GB contracted per replica | operator/owner SPEND, NOT authorized yet. Verify: contracts formed (indexd admin). |
| S7 app-key registration | the deployment's app PUBLIC key registered on this indexer (admin `POST /api/apps/register` or connect-key) with quota for the data | replica operator. Verify: the account exists on the replica, not enrolled. Rollback: unregister (before T2 only). |

**Admin control throughout:**
- the platform host policy gate admits each replica, and a ban stops it (sticky until the admin's admit);
- the service index (kind storage = 3) is discovery only.

**LIVE policy state** (root's read-only preflight, 2026-10-23T05:51Z, block 52972683,
`outputs/decentralization-audit/production-policy-carrier-preflight-20261023.json`):
- The production book `0xab21…` (owner EOA `0x0b2d…ee61`) has the global host policy anchor UNANCHORED.
- Under the production activation rule ("anchor") the gate is ON but NOT ACTIVATED.
  - `gate-preflight` then prints ADMISSIBLE because no policy is active, not because a policy admitted the host.
  - The role admits on the registry row alone: active, endpoint and operator match, read at a fresh agreed block. The
    registry is resolved through the book (`0x868e…`), never the stale static `REGISTRY` env (`0xCB65…`).
- A platform-policy BAN of a storage replica therefore takes effect only after root anchors a reviewed, signed policy
  carried off-DigitalOcean (root's rollout). This package neither invents nor drops an allowlist.
- The existing API's legacy operator/measurement/HV admission filters are unrelated to storage replicas and stay as they
  are.

## 3. Stage P: client publication (owner)

1. Catalog version: artifact `00e9cde0929dc7b8726ca4b7b9c9afb51ec4bf6d952039c907c032256ec79afc` + config `f6b48940`
   (`client/catalog-config.c2.json`). memMb = 2048 (the live 0.1.8 value; root may change it before publishing).
   Copy-mode guard: NOT applied (root decision pending; the artifact stays `00e9cde0`). NEVER `aa15a054`.
2. **Gate:** the front + relay writer-authority binding (`relay/lease-generation.mjs` + `isolation/m2` measured front;
   committed in `6f2c7da46` on `work/native-front-abort`) is DEPLOYED. The front must deliver `$ENCLAVE_WRITER_AUTHORITY`
   (the deployment's real lease16 Claimed fact) and `$ENCLAVE_INSTANCE_ISOLATION`. Without it C2 never becomes ready (fail
   closed). There is no deployment evidence of it today: this is an external gate (§8).
3. Nothing switches yet: 0.1.8 keeps serving.

## 4. T1: first fenced boot, ENROLMENT (IRREVERSIBLE online; root + owner)

**Order matters** (root's cutover review, 2026-10-23). A rollback that loses no acknowledged write exists ONLY when every
legacy writer is stopped BEFORE the coupled backup is captured and stays stopped until the forward cutover.

| step | who | what | verify |
|---|---|---|---|
| T1.1 quiesce | owner | Stop the 0.1.8 deployment and everything else that writes through it. Adapter writes fail from here on. Record `legacyStoppedAt` (UTC, with zone). | `/healthz` of 0.1.8 is gone. Root reads the live counts twice, a few minutes apart (read-only `SELECT count(*) FROM objects` / `accounts`): they are equal. |
| T1.2 backup | root | A FRESH coupled v28 backup with the **v3 runner** (`backup/runner/vm_fresh_backup.v3.py`): `--expect-db-version 28 --expect-binary-sha256 2c0e5b06… --expect-geoip-sha256 18bf1695…`, staged and run exactly as the B2 recipe. Then the pinned `pull_encrypt.py` (`ad297d48`) and **`backup/local/verify_archive.v2.py`**. | `…-integrity-v2.json` PASS, with `binarySha256 = 2c0e5b06…`, `dbVersion 28` and the authenticated `capturedAt`. The original B2 runner `62f43690` cannot do this: it reads `/opt/enclave-indexd/indexd`, the v26 binary. |
| T1.3 preflight | root | Run `vm-state.sh`, read the live counts into `counts.json`, then `cutover.py t1-preflight --vm-state … --backup …-integrity-v2.json --now <UTC> --legacy-stopped-at <T1.1> --live-counts counts.json` | **GO** only if all of these hold: the primary is exactly as prepared (`2c0e5b06`, schema 28, quiet, 0 fenced, 0 CAS); the backup is CAPTURED ≤ 2 h ago (the authenticated manifest time, never the verification time) and not in the future; it was verified after the capture and ≤ 2 h ago; the legacy writer was stopped BEFORE the capture; the live counts equal the backup's (nothing written since); one account, ≥ 1491 objects, from the minipc VM. It prints `dataLossBoundary` (= the capture time). |
| T1.4 secret | owner | `cutover.py replicas --stage t1 --inputs replicas.json` → `$SIAS3_REPLICAS` = `[{"name":"<primary>","indexer":"https://sia.enclave.host","appKey":"$SIA_APP_KEY"}]` (the SAME app key 0.1.8 uses, by reference) | |
| T1.5 switch | owner | Switch the deployment to the C2 version. The legacy writer stays stopped. ~20-25 min NOT READY is expected after a fresh claim (front binding). Each membership step then takes ~5 min (§0 timing). | `cutover.py verify --stage t1 --healthz … --fact … --inputs replicas.json --account-row <root's read-only "fence\|cas_mode\|seq_enabled\|event_seq">`: ready; this claim's lease16 authority; C2 verified, no clone assumption; ballot = 16<<48\|claimBlock<<16\|logIndex; epoch ≥ 1 stable with the record admitted; W1/N1; the account fenced at that generation and in CAS. Then known CIDs and one write. |

**Rollback is decided by the live enrolment state, never by readiness.** Enrolment can commit before a later startup or
readiness failure: the FIXTURE `rehearsal/main_enrollfail.py` kills C2 right after its fence install, never ready, and the
account is enrolled. Run `cutover.py rollback-decision --vm-state <fresh vm-state.sh output>`:

| decision | when | what is allowed |
|---|---|---|
| `LEGACY_REDEPLOY_SAFE` | `fencedAccounts` = 0 AND `casEnrolledAccounts` = 0 | Stop any C2 instance, redeploy 0.1.8. A full rollback, nothing lost. |
| `FORWARD_ONLY` | either count > 0 | Keep C2: restart it, or stay at N = 1, and repair forward. 0.1.8 cannot write to an enrolled account and there is no online downgrade (sticky CAS; no force-unenrol). |
| `UNKNOWN` | the state is unreadable | Do nothing until it is re-read. |

**Restoring the T1.2 backup is NOT a routine rollback.** On the same VM with the same seed it discards every write
acknowledged after `dataLossBoundary`: all C2 writes, since the legacy writer was stopped before the capture. It is root's
explicit decision only, with every writer stopped, and never automatic.

## 5. T2: independent replicas join (owner secret update; no new catalog version)

| | |
|---|---|
| gates | ≥ 2 (interim) or ≥ 3 (final) S-stage replicas admitted, funded, app key registered, reachable at non-DO https URLs from the deployment's egress. T1 verified. |
| secret | `cutover.py replicas --stage t2` → primary + every new replica (W = majority, e.g. 3 of 4 with three new) |
| steps | owner updates the secret → the same deployment restarts under the same claim: it serves while MIGRATING (the old indexer keeps serving), repair backfills the new members, maintenance commits epoch 2 |
| verify | `cutover.py verify --stage t2`: stable at epoch ≥ 2 on every replica, every member loaded, behind 0, record admitted, voting, no error or fork; W = the majority. Then known CIDs and one write. |
| rollback | BEFORE the commit: re-list the t1 secret. AFTER: never edit the list back (REPLICATION.md:423-424): replace members one at a time with `retiring`. |

## 6. T3 / T4: adapter and retirement

- **T3:** the adapter's `S3_ENDPOINT` is unchanged (same sia-s3 deployment). Owner secret update only if the endpoint
  changes.
- **T4** (only after two repair passes with every member behind 0 AND ≥ 3 new members):
  - `--stage t4a`: the primary is listed `retiring`. Verify t4a: stable at epoch ≥ 3, the new members admitted.
  - Then `--stage t4b`: the primary is dropped. Verify t4b.
  - Only then root STOPS the minipc indexd. The VM, its database, backups and phrase are KEPT (read-only) until the
    post-cutover gates pass. Its Sia contracts lapse on their own schedule.
  - **Rollback:** before t4a commits, re-list t2. After it, forward only.

## 7. Post-cutover gates (NOT satisfied by any fixture here; each is an explicit live measurement)

- **G1:** fresh distributed write. After t4b, write new objects and read each back. Then `sia-s3 recovery export` per
  replica shows every new member holds them.
- **G2:** cross-host loss. Stop ONE production replica host: reads and writes continue (W = 2 of 3). Restart it: it is
  re-read and caught up.
- **G3:** provider failure. With the four DigitalOcean machines unreachable, the deployment's indexers stay reachable
  (their non-DO ingress) and serve.
- **G4:** admin control. A platform-policy ban of one replica host stops it (sticky). The set continues at W = 2. The
  admin's admit restores it. This needs the global host policy ANCHORED first (root's reviewed policy rollout); while it
  is unanchored the ban path is inactive (§2).
- **G5:** cold recovery of the NEW set from Sia hosts with a sealed snapshot (`recovery read`), with every indexer
  stopped.

## 8. External requirements (real; none invented, none performed)

1. **Hosts:** ≥ 3 new storage replica hosts in DISTINCT site/provider/power domains, each a registered, ADMITTED Enclave
   host running the role. Known today: metal0 only (Linux host OS). The minipc shares metal0's site and uplink; there is
   no third. Needs new hardware or operators; no purchase is authorized.
2. **Ingress:** a non-DigitalOcean https `applicationAPI` URL per replica (F's host-service interface,
   `interfaces/F-host-services.md`).
3. **Signatures:**
   - each host's registry operator signs its descriptor (metal0: `0xC9D0…E6aB`);
   - the slug owner `0x0b2d…eE61` publishes the catalog version;
   - the deployment owner redeploys and updates secrets.
4. **Funding:** each replica wallet's Sia funding (spend; not authorized).
5. **Front:** the front + relay writer-authority binding deployed (root's release).
6. **Backup:** a fresh coupled v28 backup, with the v3 runner and v2 verifier, taken AFTER the legacy writer is stopped (T1.1-T1.3; root).
7. **Platform policy:** anchoring the reviewed global host policy (book setMany by its owner, root's rollout; no new
   contract, no ledger 17). It is a prerequisite for policy bans of storage replicas (G4), not for T1 or T2.
8. **Storage paths:** `/var/lib/enclave-storage-indexer/<r>` (≥ 3584 MiB free + data growth) on each host; PostgreSQL 18
   system binaries.

# Moving the funded us-west lease relay onto minipc (host-managed loopback relay)

Root runs every step; nothing here was run on minipc or DigitalOcean. Public values only. The key and send record pass
only through root's ssh pipes. They are never printed, hashed into logs or written to a workstation.

| what | value |
| --- | --- |
| payee (moved key) | `0x51ff183da8fF3b2dE08Da88331EED65e2F6A835c`: same key, same approved float (max 0.0002, min 0.00005 ETH), no new funding, approval or contract |
| source | DigitalOcean us-west `134.199.235.187`, unit `enclave-lease-relay.service`: a REAL unit file `/etc/systemd/system/enclave-lease-relay.service` (sha 4b3e5ac7, CAS-checked), enabled and active (root, read-only) |
| source key | `/var/lib/enclave-lease-relay/relay.key` |
| source send record | `/var/lib/private/enclave-lease-relay-state/relay-send.json` (DynamicUser StateDirectory, root-verified path) |
| target | minipc, task `\Enclave\Relay`, `http://127.0.0.1:8549` (loopback only) |
| target key and send record | `C:\ProgramData\Enclave\lease-relay\relay.key`, `...\relay-send.json` (SYSTEM + Administrators only) |
| node settings | `C:\ProgramData\Enclave\lease-gas\lease-gas-config.cmd` 9ed3c199 → 2324904b: `LOCAL_RELAY=http://127.0.0.1:8549`, `RELAYS=https://134.209.248.172` (eu-central: a TEMPORARY fallback, not the final cutover). us-west's URL is removed, because its key now lives here. |
| control | ONE file: `windows/node/lease-gas-runtime.bundle.mjs` 64712447 → d2e363c5. The other 79 files are unchanged, and no manager-shared file is touched. |

Stage: unzip the package to `C:\ProgramData\Enclave\activation-stage\local-relay-20261021` (`$S`). Every step is
`powershell -NoProfile -ExecutionPolicy Bypass -File "$S\<step>.ps1"`.

## Order (stop before start; nonce reconciled before the key signs anywhere new)

0. Read-only, both hosts:
   - `bash root/ps-readonly-checks.sh minipc` parses every PowerShell source with PS 5.1 and FAILS CLOSED (exit 1 on any
     parse error, a missing result or a different file list). It also reports the CAS baselines, the relay directory,
     the task and port 8549;
   - on us-west, `sudo bash do-source-stop.sh --check` (read-only: unit/env sha, key 0600 root, record shape, no earlier run);
   - `$S\10-preflight.ps1` must end `PREFLIGHT OK`. This is the **fresh root preflight of the baseline installed hashes**:
     1 "before", 79 unchanged, settings 9ed3c199.
1. `$S\12-prepare-relay-dir.ps1` creates only the empty, ACL-restricted relay directory.
2. On us-west, `sudo bash do-source-stop.sh --stop`, the exclusive stop. Each step is verified and journaled in
   `/var/lib/enclave-lease-relay-migration/progress.log`:
   - a create-only protected `unit.rollback` copy, plus `state-pre-stop.sha256` (AUDIT ONLY: an in-flight send may still settle while the relay stops);
   - stop, verified as inactive, with no process, no :8549 listener, and nothing (local or the https front) answering
     `/v1/info` as the payee. ONLY THEN is the authoritative stopped journal captured (`state-at-stop.sha256`, create-only);
   - disable;
   - the unit FILE moved aside to `unit.moved`, because `mask` refuses while it exists;
   - daemon-reload, mask, daemon-reload, verified masked;
   - `stop-receipt.json`, written only if the record still IS the stopped journal. It carries the stopped sha, the pre-stop
     sha (audit) and `journalChangedDuringStop`.
   The unit file and `relay.env` are CAS-rechecked immediately before every write.
   It must print `SOURCE STOPPED`. Any failure FAILS CLOSED: nothing is restarted, and the step and the abort command are
   printed. From now until step 7, minipc relays through eu-central.
3. From root's workstation, `bash root/transfer-relay-files.sh us-west minipc`. It requires the stop receipt and uses
   standard SFTP remote to remote (`scp -3`; the bytes pass through the workstation's memory only, never a file) via
   `root/transfer-lib.sh copy_create_only`:
   - it refuses before copying if the final name exists (an existing key or journal is never overwritten);
   - it copies into a unique hidden `.incoming-*` name in the protected directory, bounded by a timeout;
   - a failed or interrupted copy removes that temporary file and leaves no final;
   - the sha256 is compared on each host, and only `intact` / `MISMATCH` is printed;
   - then a create-only rename.
   Each file must print `intact`. (The earlier raw-stdin PowerShell pipe is gone: root's real upload stalled on it at
   237568 bytes.)
4. `$S\14-relay-migration-check.ps1` is read-only and must print `RECONCILED`. It checks:
   - the record is `{}`, or the payee's own signed transaction;
   - the nonce is reconciled at a block the quorum agrees on;
   - nothing unknown is in flight;
   - the balance is within the float;
   - `https://134.199.235.187/v1/info` no longer answers as the payee.
5. `$S\15-install-relay.ps1 -Reviewed` installs and starts the relay in migration mode. No key is generated, the
   existing key and record are kept, and the relay must answer as exactly the payee; otherwise its task is stopped and
   disabled.
6. `$S\10-preflight.ps1 -AfterRelay` must end `PREFLIGHT OK`.
7. `$S\20-activate.ps1 -Reviewed` stops Node, applies the bundle (CAS), swaps the settings (CAS) and starts Node. It
   observes that the agent is app-funded, its loop started after the swap, the VMs kept running and the relay is the
   moved key. Exit 0 = ACTIVATED.
8. `$S\30-verify.ps1` is read-only. At the next claim or renew, `lease-relay.log` shows the relayed operation, and on chain
   `LeaseGasPaid.payee` is the moved key. The first request after the move may be answered `RelayBusy` while the old
   record's bytes are re-broadcast; that one goes to eu-central.

## Rollback (never automatic): two different cases

**A. Abort BEFORE the key ever ran on minipc.** This covers a failed or partial stop, a failed transfer or gate, and an
install that never served:
- `sudo bash do-source-restore.sh --abort-before-transfer` on us-west. `relay.env`, the protected unit copy and the key
  (stat only) are CAS-checked before any write, and no `.from-windows` record may exist.
  - The source record must be byte-identical to the STOPPED journal.
  - If the stop failed BEFORE that capture, there is no receipt, so no transfer was possible. The relay must then be
    verifiably stopped now (inactive, no process, no listener, nothing answering as the payee), and its own current record
    is the authoritative journal (recorded create-only, never overwritten).
- It removes the mask link, puts the reviewed unit back (CAS: only into an EMPTY unit path, and only bytes with the
  reviewed sha; anything else there is refused, never overwritten), then daemon-reload, enable and start, and verifies it
  answers as the payee.
- After a stop that failed at step 2 (still running from its own unit) it reports `NOTHING TO RESTORE`.
- Any copy that reached minipc but never started: leave it in place for root to remove deliberately.
  `95-rollback-relay.ps1` shows nothing serves 8549.

**B. After the target STARTED** (its record is now the key's journal):
1. `$S\90-rollback.ps1` (bundle and settings back, CAS; Node restarted);
2. `$S\95-rollback-relay.ps1` (stopped and disabled, nothing on 8549; key and record kept);
3. `bash root/transfer-journal-back.sh minipc us-west`. It refuses unless the Windows relay is verifiably out of service
   (task disabled or absent, nothing on 8549), then copies minipc's `relay-send.json` to
   `/var/lib/private/enclave-lease-relay-state/relay-send.json.from-windows` with the same create-only SFTP copy (mode 0600);
4. `sudo bash do-source-restore.sh --after-target-start --windows-out-of-service <the stage's relay/lease-relay-migration-check.mjs>`.

   It requires the stop receipt, then runs the gate with an EXPLICIT environment: PATH, plus us-west's public `relay.env`
   names (RECORD, DIGEST, RPCS, QUORUM, MAX/MIN_FLOAT), `KEY_FILE=/var/lib/enclave-lease-relay/relay.key` (the protected
   original; the unit's KEY_FILE is a LoadCredential copy that vanishes on stop), `STATE` = the returned record, and the
   expected payee. Only on a pass does it keep the source's old
   record create-only as `relay-send.json.before-restore`, install the returned one, and restore and start the unit as
   in A.

Nothing is deleted on either side. `/var/lib/enclave-lease-relay-migration` keeps `unit.rollback`, `unit.moved`, the
receipts and `progress.log`.

## Not part of this rollout

- Designated relay discovery (`SERVICE_INDEX`) stays off. That comes later.
- eu-central stays on DigitalOcean as the temporary fallback.
- No host-wallet funding.

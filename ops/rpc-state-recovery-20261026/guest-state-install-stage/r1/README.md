# guest-state-install-stage/r1 (PREPARED by Claude; nothing run). Guest-side install of the KEPT host-fetched state archive

**Separate from** resumable-state-recovery-stage r2/r3 (6d), which is unchanged. **The host fetch** (r3) leaves `/mnt/usb/enclave-rpc-production/state-recovery-r3/state.tar.zst`.

**Pipeline** (root runs each step; the archive is never deleted):
1. `host/archive_provenance.py` (host, read-only): binds the r3 `fetch-complete.json` and the archive bytes (sha256) into a provenance record.
2. `host/transfer_to_guest.sh`: a bounded LOCAL rsync (`--partial --append-verify`) over the VM's pinned SSH forward into `/srv/enclave-base-holder/tmp/state-gsi/` (root 0700). No WAN.
3. `guest_state.py import-verify`: guest sha256 == provenance; size == manifest.
4. `enclave-base-state-extract-gsi.service`: CONFINED extraction by the pinned base binary's legacy `--url file://` path (reth 7134be3: stream_and_extract only, no init_db) into `stage/`.
   - Only `stage/`, `x-home/` and `extract-state/` are writable; no network, no capabilities.
   - The output set must be exact.
5. `enclave-base-state-install-gsi.service`: never extracts.
   - Exact staged set and the root-qualified BLAKE3 (pinned sha256 + known-answer test) against the manifest's 4 hashes BEFORE any rename.
   - Then chown + rename into `data/db`. Idempotent after a crash.
   - Writes `state-installed.json`.
6. `units/enclave-base-retention.service.d/60-state-install-guard.conf`: `ExecStartPre=+ guest_state.py guard` on EVERY retention start, after the unit's own pre checks and before reth.
   - Allowed only while `data/db` is exactly the installed, unmodified state and no `retention-complete` marker exists.

**Tests:** `test/test_guest_state.py` (13, labelled stubs) and `jobs/root-gsi-r1-tests.sh` (256 MiB, `unshare -Urn`, no HOME override).

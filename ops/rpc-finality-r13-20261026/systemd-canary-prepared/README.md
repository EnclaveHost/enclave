# bootstrap-systemd-canary-stage: the guest systemd canary for the r13-final bootstrap units (PREPARED; NOT run on the guest)

**Status:** the canary is gated. `FINAL-PINS.json` is null, so `tools/assemble_canary_bundle.py` refuses and `guest/systemd_canary.sh` refuses any upload with a null pin. Root fills the pins from the QUALIFIED r13-final:
- the stage path and its `SHA256SUMS`;
- the five files' shas;
- the sha of `guest/canary_units.py` reviewed here.

Offline tests: `jobs/root-offline-tests.sh` (10 tests, shared queue 512, `unshare -Urn`).

## Run (root, after r13-final qualifies; read every step first)
1. **[WS] Fill the pins and assemble:** fill `FINAL-PINS.json`, then run `python3 -I tools/assemble_canary_bundle.py <outdir>`. The output is `bundle.tar`, `BUNDLE.sha256` and `FINAL-PINS.json`.
2. **Guest, root:** copy `guest/systemd_canary.sh` and `guest/cleanup.sh` to the guest. Upload the three files to `/run/enclave-sdcanary-in-<ID>/`, where `ID=$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)`. Then run `bash systemd_canary.sh <ID>`. It ends with `## systemd-canary rc=N`.
3. **Fetch and clean up:** fetch `/run/enclave-sdcanary-<ID>/result.tar`, then run `bash cleanup.sh <ID>` (removes only its own units and paths).
4. **Safe to run while the snapshot download runs.** That is in fact required for the busy check. It touches no production unit, path, process or datadir.

## What an rc=0 PROVES (on the guest's real systemd, with the r13-final bytes)
1. **Root phase.** The release-mode sandbox is the live `enclave-base-holder.service` sandbox (`systemctl cat`: ProtectSystem=strict, ProtectHome, PrivateTmp, NoNewPrivileges, UMask, IPAddressDeny, limits) plus the r13-final drop-in's User/Group=root, handshake env, CapabilityBoundingSet and InaccessiblePaths. In that sandbox:
   - the process runs as euid 0 with the handshake env and exactly the drop-in bounding set;
   - it can read an rpcbase-only file (CAP_DAC_READ_SEARCH suffices);
   - **ReadWritePaths on a directory and on a single FILE work:** it appends to a journal dir analog, and takes O_RDWR + flock on a lock-file analog through the **reviewed wrapper's own `release_launch_lock`/`launch_lock`/`_secure_path`**;
   - a non-listed /etc path and the launch directory itself are read-only (EROFS);
   - the three InaccessiblePaths are denied;
   - the **reviewed `holder_gate.own_datadir`** lchowns a root file to rpcbase (CAP_CHOWN suffices);
   - the reviewed wrapper refuses the handshake env in legacy mode.
2. **Privilege drop.** The **reviewed `service_identity` + `drop_privileges`** run in that sandbox, then execve (as the wrapper does). After that:
   - all uid/gid are rpcbase, with no effective or permitted capabilities;
   - `setuid(0)` fails;
   - rpcbase writes its data and tmp analogs;
   - rpcbase cannot write the journal or read root-only files.
3. **Busy refusal.** With the REAL `enclave-rpc-base-snapshot.service` active, the **reviewed `holder_gate datadir-idle`** as an ExecCondition SKIPS the start: the ExecStart never ran. If the download is not active at run time, this check is reported **NOT EXERCISED** and nothing is claimed.
4. **Order.** A start of the holder-sandbox unit with `Requires=`+`After=` a permit unit re-runs a FAILED permit before the holder starts. A permit that keeps failing keeps the holder from starting. This is the 50-finality-restart.conf mechanism, exercised with a **MOCK permit** (named as such).
5. **Runtime directory.** The reviewed reproof unit's directives (User=root, NoNewPrivileges, PrivateTmp, RuntimeDirectoryMode=0755, RuntimeDirectoryPreserve=yes) create a private runtime directory as root 0755. The **reviewed `finality_state.publish_status`** writes its 0644 status there. The directory and file survive into the next unit (Preserve).
6. **Invariants.**
   - Production MainPIDs/ActiveStates (EL, CL, snapshot, forwards, holder) are unchanged.
   - Production unit files and `/etc/enclave-rpc` metadata are unchanged; no `/run/enclave-rpc` is created.
   - Host MemAvailable stayed ≥ 16 GiB: a sampler every 2 s stops only the canary's own units below the floor.

## What it does NOT prove (by design)
- **Not the holder itself:**
  - no real holder start;
  - no real wrapper `run('base')` (coverage/L1/blob gates, launch record/journal consume);
  - no real node, `--bootstrap.anchor`, release binary exec or real datadir.
  - Those are the first-bootstrap runbook's steps (activation plan r2 + WIRING-ADDENDUM).
- **`RuntimeDirectory=enclave-rpc` itself** is not created. A private name with the same directives is used, so production `/run/enclave-rpc` is never touched.
- **No real `permit-restart-auto`/harness** (mocked). Real `Type=exec` is replaced by oneshot for `--wait`.
- **Memory:** limits are 512M/64M/128M instead of 28G/25G.
- **`wait-l1`:** run bounded at 120 s against the r13-final wrapper's `l1-ready` from inside the sandbox. It is **informational** (it depends on L1 sync at run time), not a required check.
- **No cold-boot ordering after a reboot**, and no `systemd-analyze verify` of installed units (nothing is installed).
- **`IPAddressDeny` enforcement** is copied but not probed.

## Files
| File | Purpose |
|---|---|
| `guest/canary_units.py` | Renderer, probes, verdict |
| `guest/systemd_canary.sh` | Orchestrator, with preflight, floor sampler, evidence and invariants |
| `guest/cleanup.sh` | Owned-only cleanup |
| `tools/assemble_canary_bundle.py` | Workstation bundle assembler |
| `FINAL-PINS.json` | Null pins until r13-final qualifies |
| `tests/test_systemd_canary.py` | Offline tests |
| `jobs/root-offline-tests.sh` | Bounded offline job |

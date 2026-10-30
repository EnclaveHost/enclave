# compact-header-extraction-stage/r1 (prepared by Claude 1881; nothing run by Claude)

This stage extracts an exact allowlist of files from the preserved compact qcow2 backup, read-only:

| | |
|---|---|
| backup | `base-origin.compact.qcow2`, 120867323904 B; saved SHA `a3b00e5f…` is provenance only |
| filesystem | ext4 UUID `11c6bbac-f823-4052-a87a-066eed6ad590` |
| files | `data/reth.toml` plus the six `static_file_headers_{52500000_52999999,53000000_53499999}{,.conf,.off}` files |
| total | 362,900,885 B (`canonical-state-input-inventory-1859/compact-backup-reconciliation.json` `8db4b41b…`) |
| output | a NEW private dir under `/vm/enclave-volumes/tr004-base-recovery-20261026` |

This is **not** a recovery, canonical-state, structural or reset acceptance.

- `extract.py` has three subcommands:
  - `run`: the extraction;
  - `waiter`: the r9 `--exec` that only writes READY and waits for RELEASE;
  - `request`: prints the exact purpose-bound request.
- **Lifecycle:** the frozen r9 `overlay_session.py` is reused unchanged (sha-pinned private copy, our own child) with a zero-patch plan. The copy is done by `run` after READY, through O_NOFOLLOW walks of the allowlist only.
- `jobs/coordination.py`: the reviewed 1773 runner's busy check and multipart reservations, plus multipart driver detection. It writes nothing.
- `jobs/tests.sh`: unit tests (10), run as `unshare -Urn`, small lane.
- `jobs/e2e-tests.sh`: real r9 sessions over the r9 fixture (6). Needs FUSE, so it cannot run under unshare.
- `jobs/root-extract.sh REQ REQ_SHA`: production. Main lane 1024, coordinated, never automatic.

For hashes, root commands and limits, see `logs/claude-compact-header-extractor-1881.md`.

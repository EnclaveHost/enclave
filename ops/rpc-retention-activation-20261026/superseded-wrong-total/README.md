# base-retention-stage/activation (50cf; PREPARED; nothing run live): the SECOND (cached retention) Base snapshot download

| File | What it is |
|---|---|
| `retention_guard.py` | root, read-only `pre`/`status` gate, plus the `post` verifier that writes the distinct `retention-complete` marker |
| `enclave-base-retention.service` | separate oneshot; never enabled, `Restart=no`, `Conflicts=enclave-base-holder.service`; same sandbox/resources as the first download |
| `retention_activate.sh` | root: `install` / `check` / `start` / `status` / `stop` (deletes nothing) |
| `cached_download_preflight.py` | byte copy of `../v2` (sha `af70424c…`, tested) |
| `test_retention_guard.py` | 13 offline tests |

Report: `../../logs/claude-retention-activation.md`.

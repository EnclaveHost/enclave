# base-retention-stage/activation-r2 (50cf; PREPARED; nothing run live). Supersedes ../activation (kept, with its receipts)

**What r1 got wrong (root review):** r1 required 18 *selected* archives. The pinned manifest (`1f0c4e6c`) selects **26** under the tested policy (transactions and receipts 96..106, account/storage changesets 105..106). Only **18** are *missing* after the first download, and fewer on each resume, so r1's `pre` and `post` would have refused forever.

**r2 changes:**
- **Selection:** pins that exact 26-archive selection and requires the 8 first-download archives (chunks 105..106) to be present; the missing count may be anything from 0 to 18. `post` requires all 26.
- **Concurrency:** `--download-concurrency 16` (root's actual live value; same 4 GiB).
- **Busy check:** the activation script checks for a busy state explicitly (a running oneshot is `activating`; `is-active` missed it).
- **Marker:** the completion marker is read-only (0444, root-owned via `+post`).

**Tests:** `test_retention_guard.py` has 15 tests, including the **real** sha-verified manifest (first batch → resume with a partial → complete) using sparse files.

**Report:** `../../logs/claude-retention-activation-r2.md`.

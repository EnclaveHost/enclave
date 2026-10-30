# A2–A4 prepared (2026-10-25): publication refreshed after root's 13/13 mutant run

**Status:** PREPARED, mock-tested, NOT executed, NOT production-ready.
- **Unit:** stage `unit-rr2` OK (20 + 2 + 1).
- **Mutation:** root `root-a2-mutants-2140` rc 0, with exactly the 13 expected mutants KILLED by assertion failures and
  the baseline 20 + 2 + 1 OK.
- **Production is blocked by:**
  - **G-a:** `OPEN_GAPS = ['bytecodes-content-unverified']`. The native bytecode checker is source only and unbuilt.
  - **G-h:** the original-game A1 re-check is not integrated.
- **Not done:** no live DB access, no reth integration, no deployment and no commit by the worker. Root reviews and
  commits.

| File | What |
| --- | --- |
| `PROCEDURE.md` | the procedure. **§7** is the root review publication: frozen hashes, test history and open gaps. The narrative was corrected for publication (profile, gate order, process cleanup, A1 scope); the stage copy is not changed |
| `a2a4.py`, `selection.py`, `write_download_receipt.py`, `mutants.sh`, `a2a4-config.example.json`, `test/*` | byte-identical copies of the frozen `finality-stage/a2-a4-execution/` files that root tested |
| `bytecode-check/` | the A2 stage's checker source: **unbuilt, untested**, unchanged from the previous publication |
| `logs/root/` | root's runs: `root-unit-2132` (**rc 1, 4 failures**), `root-tests-2104` (not started), `root-a2-mutants-2140` (**rc 0**) and its 14 per-run logs |
| `logs/stage/` | every stage run: early failures, not-started attempts, `unit-rr1` (1 failure) and `unit-rr2` (OK) |
| `logs/not-started-*.log`, `logs/superseded/` | kept unchanged from earlier publications. `superseded/README.txt` describes an older round and is historical |

**Excluded:** `__pycache__`, binaries, keys and the real manifest. Test fixtures are derived from strings and hold no
key material.

`SHA256SUMS` covers every file in this directory except itself.

**Commit note for root:** the repository `.gitignore` has `*.log`, so 31 of these `.log` files (all
`logs/root/mutants-20261025T214030Z/*.log`, `logs/stage/*.log`, `logs/not-started-*.log` and `logs/superseded/*.log`)
are ignored. Add them explicitly (`git add -f source/ops/rpc-backend-bootstrap/2026-10-25/a2-a4-prepared`), or the
published evidence and this manifest will not match the commit.

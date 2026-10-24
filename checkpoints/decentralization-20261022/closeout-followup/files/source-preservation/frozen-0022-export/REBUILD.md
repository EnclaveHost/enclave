# frozen-0022 export (2026-10-24): how to rebuild

"0022" is this batch's identifier: its actual start, 2026-10-24T00:21:55Z (`date -u`). It is SOURCE + EVIDENCE only.

**State at the freeze:**
- Control recovery is NOT done: the control is the rolled-back `ed918e4b`, unregistered.
- The two original apps are protected TEMPORARILY by a root-run keeper, with a 4 h TTL to 03:53:51 and at most 8 renewals per app.
- No secret lifecycle test has been run. The original committee is unchanged and code-frozen.

**How each side was exported.** From Git objects only, as a first-parent series:
- each commit is `git format-patch --full-index --no-renames <first parent>..<commit>`;
- hunk headers carry no function context.

| Side | Base | Head |
|---|---|---|
| boot-fee-release | empty | 979a9ef, efecad2 → **3562faa1** |
| gate-v5 | empty | **f5077c21** (proposal; NOT activated) |
| lease-keeper | empty | **b3c298c0** (source; runtime state not captured) |
| m-funding | empty | 76ab248 → **fe7e1057** (assessment and unsigned plan builder) |
| current-docs5 | 155a23f4 (frozen-2355) | **cd4f51a3** |

`verify-frozen-0022-export.py` rebuilds current-docs' base from the 2217, 2246, 2329 and 2355 chains in 1a69ae56, and the others from
empty. Every tree is exact.

**Snapshot:** root's public keeper receipt `outputs/decentralization-audit/custody-temporary-lease-protection-20261023.json`, as
observed at 00:01:40Z (bb8ab3e2…). It was read and reviewed first, and holds only public tx hashes, lease times, unit status and
limitations.

**Never read:** keeper state, intents, journals, signatures, key paths and private backups. The live repo's newer commit 3055ee7 was
not designated and is not captured.

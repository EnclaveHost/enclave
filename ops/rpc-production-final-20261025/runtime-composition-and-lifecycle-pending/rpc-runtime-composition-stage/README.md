# rpc-runtime-composition-stage: one reproducible source tree from the four pushed RPC heads (PREPARED 2026-10-26; nothing run)

| file | what |
|---|---|
| `COMMIT-MANIFEST.json` | exact heads (repo, branch, commit, tree, segment commits), lineages, merge bases, stage pins, pending seam input |
| `compose.sh` | private new repo; fetches ONLY the pinned branch refs from the local repos (read-only); stage 1 automatic + pinned; stage 2 only with a reviewed, sha256-pinned resolution set; seam only with a root receipt |
| `tools/review-bundle.sh`, `tools/apply-resolutions.py` | stage-2 review bundle (base/ours/theirs/diff3/route post-snapshot delta per conflict); exact resolution applier |
| `CONFLICTS.tsv`, `STAGE1-OVERLAP.txt` | the 124 stage-2 conflicts with class and blob ids; the one stage-1 auto-merged file |
| `proposed/RESOLUTIONS.PROPOSED-PARTIAL.tsv` | 62 UNREVIEWED "keep lineage" proposals; not usable alone |
| `jobs/validate-composition.sh` | bounded offline root job: compose + component-vs-composed test comparison + invariant probes |
| `inspect.git` | private inspection repo (objects via alternates to the two source object dirs, read-only); not an input, may be deleted |

Root: `./jobs/q-exit-status.sh rpc-runtime-composition-validate-1 1536 unshare -rn bash rpc-runtime-composition-stage/jobs/validate-composition.sh`

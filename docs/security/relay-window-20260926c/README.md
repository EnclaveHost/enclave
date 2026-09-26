# The pre-warm pacing push, in rs-10's window

This follows enclave-87's order of 2026-09-26. The window opens on 63's word that all 3 canaries are accepted on 5db18199,
and runs:
1. `../attested-release-integration/retire-f7888d86/rs-10.sh apply`, then `rs-10-accept.sh apply`.
2. At least 10 min later (the NucBox soak): `pace-push.sh`, then `pace-accept.sh`.

**What gets pushed:** relay/prewarm-pacing, 2 commits on main 317b3152 (bf GO):
- e85019c6: a 750 ms gap between predictions, and ONE retry of catalog_unreachable after 61 s;
- 0a512d93: the default sleep's timer is unref'd.

**How it's derived:** the scripts are relay-window-20260926b's pc-2 scripts (reviewed by bf and 5d, and run at 04:31Z), with
only these changes:
- the pinned PATCHIDS, the FILES list (relay/secrets-release.mjs + its test) and the secrets-release.mjs content hash;
- `2` commits instead of `4`; the branch name; the `pace-` names;
- health in the CERT_SEPARATE mode with ADMIT = the admitted release (5db18199 after rs-10; overridable). The default
  mode's accept.sh 09-24 lines cannot pass since cs-3.

**What stays the same:**
- the checks: the context guard (main unchanged under relay/, site/ and scripts/ since 317b3152), the last completed Deploy
  on main = BASE + success, the ≥10 min restart age, and DRY=1;
- the instant probe with automatic revert;
- `pace-recut.sh` for a moved main.

**DRY, 05:38Z:** it refused on health. That was correct: canary 0ddbd824 was mid-relaunch (000), during 63's move to
5db18199.

# accepted-image-enrollment-stage/r2 provenance (prepared; NOT run by Claude)

**Source tree `d9a7002530afc3c1dcb6e6682f58004ed33ee20e`** = enrollment r1 `583f2d7c` (frozen, SUMS `ccee4c59…`) + `patches/accepted-image-enrollment-r2-vs-r1.patch` (7 files, +570/−335).
- I reproduced it from r4 `929fc19a` + assets r1/r2/r3 + enrollment r1 + this patch in a clean temporary repo.
- **KVM-owned modules are not edited.**

**Fixes** (`inputs/claude-enrollment-security-review.md`; root note through 15:08):
- **B1:**
  - `metal/guest/derived-state.mjs` `readState(dataDir, committedScan)`: every decision uses the scan of a FRESH majority round (`node.commit({heartbeat:true})`, same epoch, primary, lease); a local byte that is not the committed one refuses;
  - the RAM journals are re-seeded from exactly those bytes (`journalDir` wiped, including KVM's in-flight marker);
  - one role-wide lock for starts, commits, verifies and enrollment.
- **B3:** enrollment checks the signature first, then under the lock: stops the relay, takes a fresh scan, runs the rules, re-reads right before recording, commits, and confirms the committed sha. It restarts only after the lock is released.
- **B4:**
  - rotate `floorDigest` = the committed bridge floor's;
  - recover `highWater` ≥ the committed bridge AND reader floors, per chain, exact on ties;
  - a never-enrolled recover carries no state;
  - `at` ≤ now + 24 h.
- **B5:** `relay/derived-writer-authority.mjs` `declaresDerivedStateApi`: the exact constant plus 4 frozen functions, else `null`. The runtime declaration is in `proposed/derived-reader-runtime.exports.patch`, used **only** in `kvm-check` mode with a frozen KVM closure.
- **Paths:** exactly two durable names. `journalNameMapper` maps only the two canonical absolute RAM paths, with no relative path, traversal, foreign file or symlink. `stateDir` is deleted with the split fields.
- **Deadlines and outcomes:** requests carry `timeoutMs`, and the role writes nothing past the deadline. Replies say `outcome: "refused"` (not written) or `"unknown"` (may commit later). The client codes are `derived_commit_refused` / `derived_commit_outcome_unknown`, and every failure fences.
- **No downgrade:** the role-only `ENCLAVE_DERIVED_INTENDED=1` whenever the reader is bound. `relay/api-relay.js` then builds no public-RPC lease reader and refuses writer authority whenever derived is unavailable.
- **Crash guard:** it also disables derived on an unexpected exit within `derivedStableMs` (60 s) after serving.

**Tests** (`test/derived-state-enrollment.test.mjs`, 14): real roles, the real `ReplicaNode` (partition/delay), real viem signatures, real child IPC with a stand-in child. **This qualifies the role transport only, not the derived reader path.**

**Job:** `jobs/root-accepted-image-enrollment-r2.sh` with modes `check`, `kvm-check KVM_DIR SUMS_SHA` and `image`; helper `jobs/kvm-overlay.py`.

**Inputs:** the security review, root's note, and the r2 contract (`inputs/`).

**Dependencies NOT resolved here:**
- **B2:** partial genesis, KVM-owned.
- **The rotate/recover carry-floor runtime:** KVM-owned, required.
- **The exact KVM export module paths:** the proposed patch assumes `network/derived-reader/provider.mjs`.

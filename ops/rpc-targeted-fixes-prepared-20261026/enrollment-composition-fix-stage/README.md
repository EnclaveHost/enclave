# enrollment-composition-fix-stage (PREPARED; nothing run)

**Files owned (nothing else):**
- `patches/network-enroll-rpcs.patch`: the runtime patch, one declaration plus a two-line comment.
- `tests/network-enroll-chain-rpcs.test.mjs`: a new regression with 6 tests.
- `jobs/root-enrollment-fix.sh`: root's targeted runner.
- `README.md`, `SHA256SUMS`.

**Not touched:** the active, frozen r12 tree (only its git objects are read, with `--no-optional-locks`), the real branches, and
r12 itself.

## Cause

At the r12 candidate `debbfb377d90f4193ea9182f5cb67d714ffaa322`, `windows/node/network-enroll.mjs:238-244` uses `rpcs`, but
nothing declares it.
- **consumer-windows** (`e4f507d6b`, blob `4c8d8e9d2`) declares
  `const rpcs = Array.isArray(config.chainRpc) ? config.chainRpc.filter((u) => /^https:\/\//.test(String(u))) : [];`
  directly before its `agentChain()` authority block.
- **route** (`b3fde181`, blob `5f5a8fc5d`) had moved that line below its own `agentChainAuthority`/`verified` block.
- **The composition** kept consumer-windows' authority block and route's surrounding code, so neither copy survived.
- **The effect:** `ReferenceError: rpcs is not defined` on every legacy (no chain authority), non-fresh pass. That is exactly
  r12's `host-service-transport` final tests 8, 9 and 14 (route baseline 14/14).

## The fix

Restore consumer-windows' declaration in consumer-windows' position (patched blob `43c50a1f…`). Nothing else changes.

- **Verifier and invalid selections:** a selected chain authority still takes the first branch. `agentChain()` with an empty
  RPC list gives exactly the verifier, or, for an invalid selection, no RPC at all. Public RPCs are never consulted or written
  beside it, so there is no public fallback.
- **Legacy:** legacy configs follow the node's https list as before: at least 2, http dropped, never emptied, verifier
  selection removed on leaving.
- **Preserved:** the hostServices opt-in, invalid-block preservation, the challengeReplica and the policy carriers are
  untouched code paths.

## Root

The command is in `jobs/root-enrollment-fix.sh`. It needs no forge, anvil or network.

**Setup:**
1. It binds the candidate's exact blobs.
2. It exports the candidate twice (unpatched and patched), copies the dependency closures (`DEPS.txt` identity, r12's
   `deps-identity.py`) and builds the network runtime.
3. It copies in the regression.

**Expectations:**
- **Unpatched (the original failure, preserved):**
  - `host-service-transport` is exactly 11 pass / 3 fail (tests 8, 9, 14);
  - the regression is exactly 2 pass / 4 fail (tests 1, 2, 5, 6);
  - every failure must be `rpcs is not defined`.
- **Patched:**

  | Test file | Tests |
  |---|---|
  | `host-service-transport` | 14 |
  | `host-services-carriers` | 9 |
  | `host-services-cold-start` | 12 |
  | `windows-chain-authority-runtime` | 12 |
  | `windows-chain-authority` | 10 |
  | `windows-node-network-enroll` | 12 |
  | `windows-node-wallet-enroll` | 1 |
  | the regression | 6 |

  Every file must also show 0 skip, todo and cancelled.

**Excluded:** `windows-verifier.e2e` needs the Helios/reth rig, so it would skip; it is excluded rather than skipped.

# accepted-image-enrollment-stage provenance (prepared; NOT run by Claude)

## Source
| tree | how it is made |
|---|---|
| `929fc19a…` → `5052bd58…` → `c0a5f4e4…` → `59e11251…` | r4 + accepted-image r1/r2/r3 patches (all frozen; root 1384 PASS on r3, release `1910fe12`/tree `3bb4a24f`) |
| **`583f2d7c3039ecbb04ce582f180e54546253a85e`** | + `patches/accepted-image-enrollment-vs-r3.patch` (6 files, +866/−16) |

**Files in the patch** (role side only; no KVM module is touched: `network/derived-reader/*`, `network/deployment-lifecycle-journal.mjs` and `network/lifecycle-finality-bridge.mjs` are unchanged):
- **`metal/guest/derived-state.mjs`** (new): the enrollment package rules (genesis | rotate | recover, no reset), the gate, the restore marker, the RAM seed and descriptor, commit-request checks, and the provider result for KVM's `enrollDerivedState`.
- **`metal/guest/platform-api-role.mjs`:**
  - the gated, async relay start;
  - IPC handlers `derived-commit` (write, then `node.commit()`, then the exact committed-scan sha check) and `derived-enroll-verify`;
  - the crash-loop guard;
  - `POST /platform-api/derived-enroll`;
  - the restore marker on an admin `recover` with state;
  - `derived` in status (only when `derivedReader` is bound).
- **`relay/derived-state-commit.mjs`** (new): the child-side client. It serializes requests, binds each to boot, id and subject, fences on anything else, and ignores late replies.
- **`relay/derived-writer-authority.mjs`:** uses the role descriptor only with a runtime that has `enrollDerivedState`, and passes the accepted KVM options. Without the descriptor it behaves as before.
- **`metal/guest/measured-control.mjs`:** the two new role-only names are refused in the bound `relayEnv`.
- **`test/derived-state-enrollment.test.mjs`** (new, 12 tests): three real roles, the real `ReplicaNode` over a partitionable/delayable in-process transport, real viem signatures, and a stand-in relay child using the real client over the real child IPC.

## Inputs copied (`inputs/`)
- the contract as written (`derived-state-ipc-contract.md`);
- root's API note (`image-enrollment-root-note.txt`);
- the read-only state audit;
- root 1384's r3 verdict (the source of the pinned counts for the unchanged suites).

## Job
`jobs/root-accepted-image-enrollment.sh`: r3's strict harness on the new tree.
- **Additions:**
  - the bundle must carry the edited role, `derived-state.mjs`, the client and the adapter;
  - the new suite (12);
  - exact r3 counts for the unchanged suites.
- **Reused:** the r3 stage helper `accepted-image-assets-stage/r3/jobs/unenrolled-startup-config.mjs` (`9f26069e…`, covered by r3 SUMS `3e209517…`).

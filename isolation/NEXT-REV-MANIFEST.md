# The chain rev after aee2059f: input manifest (STUB)

Status: a stub, recorded 2026-09-26 on enclave-87's order; nothing is built. It rides whenever the next rev is cut.
Base: `isolation/seccomp-evidence` `4cd26e58` (release `aee2059ffcc7bd8a…`, cut by enclave-53; on metal-iso0 since e8).
The cut is enclave-53's; the tree swap and the node image are enclave-63's. `⟨…⟩` marks what the cut fills in.

## 1. 5db18199 leaves `SECCOMP_UNSTATED_RELEASES` (enclave-87, after e8: all 3 canaries on aee2059f, no 5db18199 guest left)
- **The change:** `isolation/m2/judge.mjs` drops the entry
  `'5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77'` from `SECCOMP_UNSTATED_RELEASES`. The table is then
  the W^X legacy table alone (the KAT pair `5c3561f9`, `6f14ce75`), and its comment names rs-12, as `4cd26e58` did for
  f7888d86 and rs-10. A caller naming 5db18199 then gets the full rule: a self-test without `seccomp=<hash>` is refused.
- **Tests** (`test/isolation-runtime-identity.test.mjs`):
  - 5db18199 moves into the refused set ("states no seccomp filter");
  - the "may omit it, named by the caller" loop keeps only the legacy pair;
  - the table test becomes the legacy table alone;
  - a mutant that puts the entry back must fail them.
  guestd's `datapath_chain_test.go` is unaffected: its fixture monitor states a filter, and it names 5db18199 only in a
  comment.
- **Host-side only:** `judge.mjs` is outside the release dir that `release-manifest.py` walks, so this change alone does
  not move the domain release id (as `4cd26e58` did not). The tree commit does move.
- **The pairing** (as f7888d86 with rs-10):
  - rs-12 (enclave-e3 retires 5db18199 on the relay) lands at or before the swap. After rs-12 the relay is the gate, and
    this table is the second fence, so this is not urgent;
  - at the swap, no live guestd record names 5db18199: read the records then;
  - it ships on BOTH consumer trees together: guestd's `-isolation` tree AND the metal-iso0 node image **N3**, whose
    `node-image-manifest.json` must show `isolation/m2/judge.mjs` (and `isolation/m4/guestd/supervisor-guestcert.mjs`) with
    this rev's sha256s.
- **The unit:** `-isolation-release` = `@<the new release dir>/release.json`; `-legacy-isolation-release` for iso-03be27d6
  unchanged (5c3561f9, 6f14ce75); `-unrecorded-releases` stays dropped.

## 2. Also queued for this rev (test-only; image and tree behaviour unchanged)
- `isolation/parity-pool-5d` `dd3e90d4` (enclave-5d; enclave-b4 GO): the node-bridge parity test gives the SNP gate a guest
  pool with room and the version's policy (red on the lane since `829ea21b`).

## 3. Not in this rev
- The NucBox's per-image table (`windows/vbslike/verify/judge-hv.mjs` `SECCOMP_UNSTATED_IMAGES`, v43's `49500527`): it
  lives on main and retires with v43's image, in a NucBox rev.
- The KAT pair `5c3561f9` / `6f14ce75`: they stay listed until the legacy tree retires.

## Filled at the cut
| | |
|---|---|
| tree commit | ⟨53⟩ |
| release id | ⟨53⟩ (unchanged by item 1 alone) |
| `judge.mjs` sha256 | ⟨53⟩ |
| N3 node image, prediction | ⟨63⟩ |
| rs-12 accepted at | ⟨e3⟩ |
| records at the swap (none naming 5db18199) | ⟨63⟩ |

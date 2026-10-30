# Source ownership and completion

`main` is the maintained source for enclave.host. The project goal is decentralized,
censorship-resistant hosting. Preserve independent authority selection, verified
identity, owner authorization, and fail-closed admission when composing changes.

- Before coding, fetch and inspect main, active worktrees, and relevant unfinished
  work. Coordinate concurrent owners; never overwrite their uncommitted changes.
- Implement reusable source in its maintained package. Dated `ops/` directories,
  installed overlays, and qualification snapshots are evidence, not a second
  development source tree. Reconcile deployed fixes back into maintained source.
- A completed implementation includes its necessary checks, commit, push, and
  integration into main within the user's authorized scope. A local commit,
  deployment, branch, or draft PR alone is not completion. If blocked, report the
  exact failing check or missing input and retain a concrete next action.
- Before merging, resolve conflicts semantically and verify imports, generated
  artifacts, security boundaries, and affected tests. Never resolve a conflict by
  discarding newer safety checks merely because an older branch contains a fix.
- Keep historical experiments and incomplete candidates explicitly identified.
  Preserve their source and provenance; do not describe unqualified code as a
  deployed capability or make it a default without its release gates.
- Source integration and production activation are separate. Deployment is an
  explicit workflow dispatch. Merging source does not authorize payments,
  contract changes, image publication, service restarts, or changes to live VMs.
- Never bypass secret scanning. Verify and narrowly classify public fixtures or
  dependency digests, retaining tests that real secrets are still rejected.

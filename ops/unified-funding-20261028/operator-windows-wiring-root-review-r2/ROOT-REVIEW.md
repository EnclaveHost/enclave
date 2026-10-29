# Windows wiring repair r2: partial delivery and root qualification

The Claude source-only run timed out (124); its frozen 249-file delivery is incomplete, not a successful author completion. All five changes and terminal/mutation evidence are separately committed in operator-windows-wiring-delivery-r2. No unexpected mutations or readonly-input drift were found. No backend or native Windows activation occurred.

## Executed checks

- Initial baseline: 82 pass / 4 fail. The review copy omitted the prior review's node_modules link. Failures are retained module-resolution errors, not product findings.
- Restoring the exact existing dependency location, with no product changes: 92 pass / 0 fail / 0 skipped or cancelled.
- Seven prior root failures plus a positive installer preflight: 8 pass / 0 fail. The external fixture now supplies config schema 2, the derived virtual-service SID, read-only service access and explicitly TEST migration evidence. The four installer refusal assertions and all three runner assertions remain; coded refusals verify they reach the intended boundary.
- Two additional tests: 0 pass / 2 fail. Migration evidence and release manifest were omitted from the installer's trust-path ACL observations. Their bytes were still hash checked; this is a missing protected-location policy, not a demonstrated digest bypass.
- Separate repaired tree changes exactly one product file: installer trustPaths now includes both files and their ancestors. Full combined suite: **102 pass / 0 fail / 0 skipped or cancelled**. Runs overlap and must not be summed.

The actual source modules, Linux owned storage, shipped client and inert signer/RPC/relay run locally. External Windows ACL, identity, process and qualification responses are labeled TEST fixtures. These results do not prove native EXLOCK, effective service access, Windows process death, OS-crash durability or Base authority.

## Remaining deployment work

The candidate only accepts NT SERVICE virtual accounts and SCM-service exclusion records. Existing installer source registers a SYSTEM scheduled task. Actual target principal is still unknown; verify it rather than changing production identity to fit this candidate. Source references: config serviceIdentity/currentIdentityProbeScript; installer migrationEvidence; existing windows/installer/install-host.ps1 scheduled-task registration.

Old-writer exclusion requires a current, continuous cutover boundary. The candidate's dated evidence file and repeated legacy-file reads are insufficient to prove a stopped writer remains excluded. Hashes bind evidence bytes, not current operating-system state. The reviewed migration must establish this boundary without resetting or replaying obligations.

Claude did not finish an r2 report, complete release closure or new focused author regressions. Historical reports in the frozen tree describe earlier revisions. Native resource admission, independent death observer, actual runtime EXLOCK and all required workload/authority qualification remain open. Production Top up is live; three original apps are confirmed recovered. Automatic refill and the new protocol migration remain unfinished.

## Preservation and resources

Frozen candidate and repaired tree have separate complete manifests. Exactly one product file differs between them. The known r12 repairs, chain quarantine and shipped bundles remain unchanged. Five bounded root test units are terminal with MainPID 0; all owned test temporary directories were removed. All runs used the shared queue, 512 MiB hard / 450 MiB RSS, 27,648 MiB free-memory floor, CPU 1, no swap and an isolated loopback network. No payment, service restart, production journal mutation or Windows qualification ran.

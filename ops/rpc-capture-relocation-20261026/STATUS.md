# Capture deployment and reversible storage relocation

Root1312 passed 28 historical verification and 12 runner tests, with zero skips, plus reproducibility, relocation, tamper and real-entrypoint refusal checks. Bundle020cc8bf was installed at its immutable content-addressed path on the RPC guest under root1318; it verified as root and rpcbase. This installed tools only: no capture, database access, service restart or activation. Actual Node18 fixture execution remains pending; ldd resolved the KZG executable dependencies.

Root1316 passed the affected r8 integration:58 tests, wrapper49 plus baseline34 and mutation rejection, readiness93, ops27, legacy36 on each side, and r18 reproducibility. Identical baseline readiness receipts were reused only with pinned code identity. Full r18 candidate qualification is separately pending; this does not claim readiness or live historical coverage.

Root1322 passed all22 relocation tests. Earlier failures are preserved. r4/r5 restore and strictly verify directory mtimes, reject destructive rsync options and escaping relative links, require durable mounts and fresh writer checks, and preserve new writes during rollback. The controlled rsync diagnostic preserved mtimes with every actual flag; the original cause remains unproven. r5 repairs a stale fake swap entry in one test, without changing r4 production code. No live relocation, reclamation, mount or deletion has occurred. Renaming sources to retired copies does not free space; a separately reviewed verified-copy reclamation step is still needed.

Signed capture r1 passed6 synthetic tests under root1310; these deliberately reach native header refusal and are not successful mainnet execution or authority. Its review is being addressed in the KVM chat.

ELF artifacts are deliberately omitted from Git. EXTERNAL-BINARIES.json identifies their exact hashes and existing committed build source/job. Restore and verify those bytes before checking the complete stage manifests or deployment. The original manifests remain unmodified. Test jobs retain their recorded workspace paths and pins for provenance.

Administrator controls, the120-second consumer freshness ceiling, finalized ownership claims, and the physical16GiB host memory floor remain intact. Production synchronization, historical KZG coverage, positive native execution, accepted SNP deployment, consumer cutover and public-RPC blackout remain incomplete.

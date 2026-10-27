# Composite database validation source: not production qualified

This checkpoint preserves the preparation and reviews of a read-only checker for the multipart database. These revisions have not yet passed the actual fixture suite; production activation remains disabled. Copying and independently verifying database bytes does not establish database integrity, canonical chain state, synchronization or production RPC readiness.

Root review rejected r1 cleanup that could skip ending children after an unmount exception. Root rejected r2 because a non-timeout unmount exception could still skip ending the same child, and rejecting an existing work directory could nevertheless clean that previous run. The r3 revision addresses these defects; actual fixtures are still required. Read the included author and independent reviews for remaining limitations. Never activate r1 or r2.

Correction to review 1784 A1: the existing shared queue holds its exclusive main lock throughout every >=512 MiB job. Fixture tests use 512 MiB and preservation uses 1024 MiB, so their normal lifecycles are serialized. Do not cancel a healthy preservation batch merely to insert fixture tests. The 256 MiB concurrent lane is unsuitable for those tests. Queue cancellation can interrupt cleanup and is not the session stop procedure.

Original array writes, paused downloads and production RPC VM remain paused. No original data, recovered parts, credentials or binaries are included. The original remains protected until a separate recovery acceptance decision.

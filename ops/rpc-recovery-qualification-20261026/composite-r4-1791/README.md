# Composite validation r4: fixture qualification queued

Runtime bytes are identical to reviewed r3. One test expectation now accepts either libfuse detaching its own mount or successful explicit lazy detach, while still requiring failed ordinary unmount, CLEANUP-INCOMPLETE, all owned children ended, and no remaining mount. No safety or production-readiness gate is relaxed.

Root verified the exact stage hashes and queued the actual twelve-fixture suite through the exclusive 512 MiB main lane. This checkpoint contains no test PASS claim: the queued test is named cmv-r4-tests, and its eventual receipt must be inspected separately. Production use remains unconditionally disabled. The healthy 1024 MiB multipart preservation jobs continue through the same exclusive main lane. Never stop their queue wrapper to insert tests.

Structural validation does not establish canonical chain state, safe/finalized readiness or completion of RPC replacement. Keep the original image and stopped downloads until separately authorized recovery decisions.

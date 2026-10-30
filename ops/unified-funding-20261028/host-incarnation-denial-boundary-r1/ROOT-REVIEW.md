# Host Offline denial and persistence boundaries

Five independent requirements checks run against the frozen root-r3 actual profile and host-incarnation sidecar: one positive control passes, four requirements fail, zero skips. These results do not qualify the unfinished profile or any production behavior.

1. Online then Offline at the same host generation returns and retains Online. The first persistence assertion fails, so the later reopen/stale-Online branch in this test did NOT run. A corrected implementation must retain the Offline denial and reject an older Online view at that same generation; legitimate qualification recovery advances generation.
2. Accepting a new-generation Online context after an Offline context passes. This is a sidecar forward-progress control, not qualification of a real attestation or registry transaction.
3. Removing an already observed journal makes its next read return null, instead of refusing lost authority state.
4. A nested context whose generation contradicts its floor/digest is returned rather than rejected.
5. Injecting a directory fsync error after the file rename correctly makes acceptance throw, but the following same-process read returns the saved context. Failed durability must remain unknown; reading the same renamed bytes does not prove it was durable.

Tests use only owned temporary files, exact staged modules and an injected fsync error restored in finally. No chain, signer, provider, hardware, runtime, service, or production app was exercised. They do not demonstrate a live serving bypass or duplicate payment. No candidate implementation was edited; these are independent acceptance cases for the active source-only permit/adapter continuation.

The owned unit enclave-host-incarnation-denial-r1-20261029 terminated with expected test exit1/MainPID0. Limits were256MiB outer/220MiB inner, floor27648MiB, one CPU through runner affinity, no swap,100-second service cap/30-second child. Both guard summaries missed this short child's sampling window and report peak0/minimum n/a; these are NOT measured zero memory or proof of a sampled host floor. Input hashes checked before/after; all owned temporary files removed.

Published tests.log strips trailing whitespace from blank lines for repository checks. Exact raw failed output remains at /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/host-incarnation-denial-boundary-r1/tests.log (SHA256 5e138313b2e39d8adeddc59d5f5dd822386d8c273b2305abe210ae83266270ba). Assertions and outcomes are unchanged.

This source result adds to, and does not invalidate the narrow scope of, the previous8 handoff+93 existing composition checks. That review already excluded full permit, persistence-fault and new-registry native qualification. The current Claude task must implement host-wide Offline revocation, signed context, final post-signature checks and durable refusal before activation; field labels alone do not authenticate any input.

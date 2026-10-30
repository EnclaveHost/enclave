# Pre-listing bootstrap and independent endpoint boundary review

Status: three reproduced baseline limitations; no production change and no passing claim for the new qualification feature. This is part of the highest-priority lifecycle/capacity/gas feature within complete censorship-resistant decentralization.

## Executed evidence

The exact pinned original workload and Shield expectation loader were imported. All three behavioral assertions pass with zero skips:

1. The CPU/RAM workload refuses a candidate with no paid lease before sending the workload, even when the caller includes a bounded local test authorization. The reference is a real child process with synthetic output. The arbitrary authorization field is deliberately unsupported; this is evidence that a new explicit adapter is needed, not a request to accept caller assertions.
2. The Shield expectation loader refuses a missing deployment row before obtaining its host attestation session.
3. With a valid fixture row and mock derivation/session, that loader constructs `https://<id8>.app.enclave.host/` despite an independent candidate endpoint. No DNS lookup or network request was made by these tests.

These are software boundary tests using fake derivation, host-session and reference outputs. They do not verify hardware, real attestation, paid work, gas eligibility or enrollment. The original registered-host behavior remains untouched. The earlier witness audit remains separate.

The owned small allocation used 256 MiB outer / 220 MiB inner, floor 27648 MiB, one CPU, no swap, 100-second service cap and 45-second test timeout. Exit 0; sampled outer peak 237 MiB, minimum available 33994 MiB. Inner sampling missed short child peaks (reported 18 MiB), so it is not a whole-run peak guarantee. Input hashes were checked before and after; no input drift. Unit terminated and no test network server was created.

## Actual dependency composition inspected

- `availability/verified-http.mjs` already challenges attestation with a fresh nonce, binds a guest TLS key, checks independently supplied app/runtime expectations, and pins the subsequent workload to that same key. Reuse those actual checks. It accepts an expectation loader, but its existing service composition is not independent.
- `scripts/availability/service.mjs` readiness and SNP expectations depend on an Enclave app hostname and `/v1/expected-guest`. The source labels the prediction as operator-bootstrap trust. Public recursive DNS resolvers in `availability/public-dns.mjs` do not remove the Enclave authoritative namespace or prediction authority.
- `availability/shield.mjs:createShieldExpectations` requires a live assigned deployment, derives catalog/config expectations, and constructs that same app namespace. Do not forge a live deployment row to bootstrap an unregistered host.
- `windows/node/isolation-client.mjs` exposes an existing finite manager interface; `isolation-lifecycle.mjs` holds capacity while removal is unknown. A pre-listing test needs its own authenticated local job context and retained unknown-outcome journal. It cannot call the ordinary serving path with a fictitious paid lease.
- `isolation/m4/guestd/server.go` binds a bytes32 launch name into SNP HOST_DATA. A test-job binding must be a real documented namespace/digest consumed consistently by launcher and verifier, not a claim that the job was a chain deployment. This review did not launch a guest or qualify deployed guestd bytes.
- Registry source 68310acc requires the exact Enrollment/Recovery digest in QualificationPassed, plus hardware, descriptor, attestation, resource, test digest, generation and validity. Old EnclaveCapacityEvidence Receipt signatures have a different domain and type; they are not a new-registry qualification signature.

## Next implementation requirements

Deliver a direct, bounded qualification-job transport and expectation loader sourced from owner/payer-approved immutable artifacts and verifier policy. No required Enclave prediction relay, DNS suffix, privileged catalog admission or fallback to those authorities. Keep key/nonce/app/runtime/hardware/generation checks; rejecting central dependencies must not weaken attestation. Real evidence verification must precede signing the exact registry qualification intent and releasing listing gas. Initial failures stay unlisted; existing authenticated Offline remains independent of Online freshness or affordability.

Acceptance must include central DNS/prediction endpoints unavailable or refusing the host while an independently addressed, correctly attested test succeeds. It must also reject changed job context, mismatched transport key, wrong runtime/hardware, reused nonce/intent and failed workloads. A mocked success alone is insufficient; actual native verifier rejection vectors and real registry signature/enrollment integration are required before qualification. Full real-hardware/production inclusion and sponsor-liability evidence remain separate deployment requirements.

Claude's current host-incarnation repair is a different staged component of this same feature. No second source author was launched by this review. Do not change its live outputs or duplicate it.

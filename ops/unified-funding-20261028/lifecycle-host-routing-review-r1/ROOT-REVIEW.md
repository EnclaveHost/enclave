# Lifecycle host routing review — 2026-10-29

Status: staged source, NOT integrated or deployed. This is a component of the highest-priority work toward completely decentralizing Enclave for censorship resistance. It is not completion of that goal or permission to activate this candidate.

## Proven changes

The Claude author completed rc0. Its output was written under the peer it/work tree instead of the instructed wo/work tree. Root preserved that output, copied a stable review snapshot, and recorded every original file hash in author-pins.json. No installed host was edited.

The generator pins candidate host.mjs SHA256 8f0b92bb7b3eb0662d706ab0da0f80b07ec4621f78105384c59a907b89d469c7. The baseline checkout was ecf364c0a81b9176163d254dcfc9685572bde0cd at review; host bytes match the author's earlier baseline pin. A generated host routes selected IDs to the existing lifecycle runner and excludes those IDs from legacy lease operations. Unrouted behavior is covered against the unmodified candidate host. This is not the installed production host.

All 29 author tests passed. Root added two independent regressions and observed both fail before changing code:

1. A local owner stop during asynchronous unsigned intent preparation still allowed one running-intent submission. Root added a post-await context check before returning the unsigned intent to the runner's journal.
2. A snapshot matching ledger/controller/deployment but naming a different local host was served. Root bound the read to the attached host identity as well.

The combined 31 tests pass, zero skipped. The suite uses the real candidate host/runner with a loopback fake Base RPC and mock lifecycle authority/runtime/funds, not actual Base authority, hardware, production signatures or real transactions. Separate test processes, concurrency 1, shared small lane 256 MiB/no swap, inner RSS 220 MiB and host floor 27648 MiB, CPU0. Final measured peak 187 MiB; minimum host available 32421 MiB. Failed root-before.log retained. No duplicate debit, on-chain failure or live security incident is inferred from these mock tests.

## Material unresolved requirements

Do not promote this candidate solely because those tests pass:

- It unconditionally feeds platformPolicy.serviceRefusal and newWorkRefusal into routed hosts. The existing service gate is a global address-book-owner policy. That is incompatible with limiting veto to wallet-owned hosts. Existing local owner/operator controls must remain, but independent hosting cannot require Enclave approval. The next source job addresses this without a global policy-off bypass.
- Existing host-admission-policy always applies catalogAdmissionRefusal, even when the wallet does not elect catalog approval. Integrity validation must remain; optional owner-selected moderation cannot become a compulsory central authority.
- A successfully activated route still depends on the old global book's current ledger address. A future change to the retired ledger should not disable independent service after an authenticated finalized handoff. Old pending intents must remain tracked; no journal clearing or inferred cancellation.
- A new-work refusal currently holds reconciliation before reading actual running/pending state. Owner/platform restrict() only fences/stops locally; it does not update on-chain lifecycle state. Authenticated offline must have an independent submitter and survive ordinary admission failures. The peer is preparing the corresponding emergency-offline protocol delta; no production path is qualified yet.
- Missing composition includes real owner-scoped admission, measured available capacity and pending allocations, host/runtime/permit/ingress integration, actual quiescence proof, new contract funding authority and paid settlement. No implicit allow or synthetic proof is acceptable.

Existing r6 chain adapter and its 66 prior offline checks must be reused where applicable; they do not establish present Base authority or independent emergency submission. The next job must audit both the host and adapter boundaries, not just replace a refusal string.

## Next source work

Root task lifecycle-host-authority-r2-20261029 contains exact requirements. Its process waits for the identified peer emergency-offline author process to finish before requesting the shared main lane once. It has no production activation or financial authority. Root reviews output before executing its generator/tests. The peer owns emergency-offline contract work; root owns host integration, production and spending coordination.

Earlier goal response was a scope acknowledgement, not implementation progress. This review yields concrete source fixes and changes the next integration action. Goal remains active. No app recovery count, payment, grant, relay, host or controller state changed in this review.

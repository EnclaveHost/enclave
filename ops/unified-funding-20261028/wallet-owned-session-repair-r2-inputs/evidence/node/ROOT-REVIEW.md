# Root wallet-owned creation review, r1

The unmodified frozen product passes all seven authored JavaScript consumer cases and fails all three independently added root requirements: **7 PASS / 3 FAIL / 0 skip / 0 cancelled**. The root file copies the unchanged author tests/fixtures and appends three cases; these counts overlap, and are not ten additional independent author cases. No Solidity compilation or test has run yet.

Reproduced through the actual shared resolver/createCustodyGate/sessionRowRefusal/host authorization modules with inert chain fixtures:

- An empty configured factory list permits an unapproved PROD wallet-owned row through custody.
- Absence from one configured factory is treated as proof of a legacy-unbound row, also permitting custody. This is not exhaustive creation/policy provenance.
- Once a factory is cached, changing the RPC chain identity does not cause the next decision to reject.

These tests demonstrate authorization-return behavior, not transmission of actual secret bytes, real Base state or native process failure. The author's positive tests manually supply walletPolicy and inert bound-state records; they do not prove SDK/create/real constructor integration.

Execution was admitted once under512MiB hard/450MiB RSS/floor27648/CPU1/noSwap/sharedqueue, network namespace, minimal child environment and no credentials. Peak170MiB inner/221MiB outer; minimum available31759MiB.203 source hashes and11866 files across13 resolved dependency packages checked before and after. Temporary test directory removed and unit MainPID0. Source products are unchanged; missing generated api-relay network bundle was not imported or fabricated. See exact command runner/pins/results.

Further source blockers: SDK client/open and host constructor/shipping path remain unwired. Incomplete factory configuration cannot become the independent-owner discovery mechanism or an operator veto. Legacy broad delegation can still reach new wallet records on-chain. Peer identified secrets-release's policy check preceding asynchronous verification with no final recheck, plain secrets fetch awaiting custody after its policy check, and owner-policy _ownerBinding reading the mutable book ledger without the pinned _ledger guard. These last findings are source review only, not tests claimed passing or failing here.

Full original202-file delivery is committed separately as UNVALIDATED wallet-owned-session-create-delivery-r1. Tests and partial implementation are not production deployment or existing funded-app migration. No signing/payment/ownership change occurred. Next: separately reviewed bounded Solidity compile/size/test closure before another source author; peer preparation only, no execution delegated.

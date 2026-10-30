# Wallet-owned session creation: prepared source author

Status: PREPARED ONLY. Root review/admission is required before launch. No author/auth command, test, build, live call or transaction has been run. Candidate source consists only of byte-for-byte copies with named provenance overlays, not product edits.

## Proposed bounded slice

An additive executor/factory and authenticated wallet-controlled environment/content binding, wired through the real relay, host and secrets consumers, with minimal explicit SDK/CLI version support. Existing ledger creation/transfer/fundFor interfaces suffice for future records. The original vault, ledger, catalog, defaults and already deployed apps remain unchanged. New-version grant, funds, delegation and onboarding are explicit; no old grant/balance migration is implicit.

55 agentic turns / 1800 child seconds / 2100 outer seconds is an upper bound, not a completion estimate. Full production deployment, onboarding UI, grant/funding migration, catalog publishing, old funded-app preservation and end-to-end runtime verification are outside this author. The report must identify unfinished positive seams rather than pretending refusal-only enforcement completes the feature. Root may reduce or split the task before admission. Existing pending signatures remain with the human and coordinator.

## Seed and provenance

S is the coordinator's production source checkout. contracts/SessionVault.sol matches deployed v2 exactly. Four captured installed relay modules are copied verbatim over S versions, with old/new hashes and full diffs in seed-provenance.json and overlay-diffs. Supporting funding/fee modules come from the quarantine candidate whose sessions.mjs exactly matches the installed capture. These are source snapshots, not proof of every process's loaded/current code. All installed funding, queue, fee and quarantine guards are immutable in this task. Host and api-relay wiring are current checkout source, not fresh host captures; activation later requires a fresh source merge, never wholesale deployment of this seed.

The shipped SDK bundle and complete r3 wallet-release source are readonly evidence. No prior root repaired release/census module is part of the editable product surface. Source-pinned quarantine, activation and queue-envelope regression suites and helpers are provided as readonly regression references; authored tests must exercise actual changed consumers, not weaken those assertions. Product package/lock remain unchanged.

## Scope and acceptance

TASK.txt is the detailed contract. Required table: every deployment action and off-chain api.* scope, staging/prod behavior, wallet content approval/revocation and three real secret-release consumers. New app.publish is explicitly unsupported until separate catalog ownership work; rejecting it does not constitute full app API parity. No global Enclave operator can authorize or revoke wallet policy. Identity must derive from wallet authorization plus verified code/factory/domain/chain/ledger, with no arbitrary-owner trust and no omitted-policy downgrade.

The first meaningful acceptance is actual atomic new create -> same-ID wallet transfer -> owner-attributed funding and positive staging/owner-promoted-prod authorization through real consumers, plus failure cases. Root must separately review and run bounded contract/Node tests and measure EIP170/EIP3860 and gas. Static copying/import inventory is NOT compilation or test success. Existing chain test helper may compile or launch Anvil; author must never execute it. Tests later require a separate admitted closure including Foundry/solc/runtime dependencies, local fixtures and no production endpoints.

## Account and execution gates

Root independently runs the exact pinned Claude executable's `auth status` only after approving preparation and checks loggedIn=true, email=steven.r.batchelor@gmail.com, subscriptionType=max. Runner repeats those checks before author launch and records only those three public account fields. No auth checked during preparation; no login/API key fallback.

Root creates root-author-approval.json with launchAuthorized=true and preparedSha256 equal to reviewed PREPARED.json only after source/runner/pin/account/resource review. Missing/stale approval fails before auth. Prepared launch-command.txt is text only. Shared queue, CPU1, 1536MiB hard, 1408MiB RSS, 27648MiB available floor and noSwap are mandatory. Runner verifies exact executable, inputs, candidate bytes, CPU affinity, private persistent ext TMPDIR and one-attempt exclusive marker. Do not run outside the reviewed systemd/queue/guard wrapper. Tool restrictions limit author tools; they are not an OS filesystem sandbox. Root freeze/replay audit must reject out-of-scope mutations.

Collector runs ONCE after actual unit terminal, known PIDs gone and exact executable/CWD scan clear; root supplies real admission identities. Preserve failures/partial work. No rerun/retry author automatically. No contract, deployment, default, finance or UI activation is authorized by this preparation.

# Final awaited witness read: independent acceptance evidence

Status: **not qualified for activation**. Six focused acceptance tests over the frozen root-r2 real witness and protocol modules produce **1 PASS / 5 FAIL / 0 skips**. The five failures are required rejection assertions; they are not softened into passing defect demonstrations.

The positive case verifies an actual EIP712 witness signature. Each negative case explicitly reaches the third authority read, which occurs after signing, and holds that promise before applying the condition. The frozen implementation releases the signed response after:

- `close()` during that await;
- `fence(id, 3)` during that await;
- the deterministic clock advancing beyond the permit expiry;
- the final authenticated-observation fixture reporting the app is no longer admitted;
- a newer assignment observation extending effective authority from 1010 to 1018 while authenticated readiness covers only 1010.

The last case uses the SAME signed record. Its initial block timestamp is 990 and the refreshed timestamp is 1000; the actual validator bounds authority by block age and the record deadline. A refreshed context must not silently increase the window beyond the readiness evidence. After the final awaited read, revalidate current time, closed/fenced/denial state, the app and host authority, and readiness coverage. Preserve the existing signature and policy checks.

## Scope and provenance

Real generated witness, typed-data crypto, ephemeral TEST signers and actual file journals. Authority/readiness observations and clock are synthetic test fixtures. This does not prove chain inclusion, hardware enforcement, real independent witness readers, or production exposure. No RPC, funds, browser, host or production mutation occurred. The process ran inside an owned network namespace without network routes.

The 13 frozen modules are copied byte-for-byte from `host-authority-permit-root-review-r2/protocol-tree/network`; `input-pins.json` records exact source hashes and the runner checks source and copy before and after execution. No active Claude output was edited or executed. `test.sha256` pins the independently written test.

Unit `enclave-witness-final-await-r1-20261029`, invocation `9f4c7ea986364ad39447642c263f09c9`, terminated with exit 1 from the five retained assertions; MainPID 0. Shared small queue 256 MiB, inner RSS limit 220 MiB, available-memory floor 27648 MiB, one CPU, no swap, service limit 130 seconds and test-child limit 45 seconds. Outer observed peak 145 MiB/minimum available 33968 MiB; inner peak 95 MiB/minimum 33966 MiB. No child is left running.

The existing completion task includes this boundary. These tests must be rerun against its frozen terminal output with any fixture/provenance adaptation explicitly reviewed; the baseline failures do not predict that output's result. Production remains unchanged. The full censorship-resistance goal also still requires concrete ingress/storage/secret enforcement consumers, independent authenticated readers, qualified prelisting and sponsorship, and fenced live migration.

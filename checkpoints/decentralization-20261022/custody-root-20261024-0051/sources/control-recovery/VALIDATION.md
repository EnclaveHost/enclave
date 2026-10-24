# Root validation, October24

No activation performed. Candidate image remains the previously staged5db/bc731 image; this kit adds procedure checks only.

- root-full-1:56 Python and17 Node tests passed after fixing the interrupted SDK test's outdated balance assertion. Mutation runner then refused an obsolete source-string target; scan passed. This was NOT a passing full run.
- root-full-2:56 Python,17 Node,89 mutations killed/zero survivors; gitleaks, crypto-key and rewritten-literal scans passed. Peak200MiB within512MiB queue allocation.
- Added mandatory actual keeper-unit inactive/failed precondition before activation, to prevent concurrent signers.
- root-keeper-guard first invocation had an incorrect import working directory; no tests ran.
- root-keeper-guard2:2/2 additional tests passed from the kit directory, covering active/transitional/unknown/unreadable unit refusal and confirmed stopped states. No production systemctl mutation occurs in these tests.

Gatev5 is byte-identical to the separately validated f5077c21 proposal (11 real HTTP fixture cases and7 mutation checks). The final precondition addition does not alter gate, fee, rollback or attestation logic. Production activation and operational KEEP remain unverified.

The read-only live funding preflight did not pass. Its first run exposed an incomplete JSON-RPC response being converted to BigInt; the transport now explicitly refuses HTTP errors, invalid responses and missing results. Root added a transport regression test; root-node-transport and root-node-diagnostic pass18/18 Node tests. Fee-read errors now report only provider, method and short cause, without request parameters.

At00:49:03UTC the live read refused specifically: mainnet.base.org setProofKey eth_estimateGas: out of gas, gas required exceeds24228. The operator remains at its insufficient balance. This is NOT a funded candidate/rollback fee proof; rerun the full read after approved funding. No keys, signing, delegation change or control restart occurred in these probes. The earlier89-mutation run predates the transport/diagnostic-only addition; no other gate/funding arithmetic was changed.

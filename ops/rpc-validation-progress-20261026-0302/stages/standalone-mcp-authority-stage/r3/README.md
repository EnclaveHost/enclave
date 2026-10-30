# standalone-mcp-authority-stage/r3 (PREPARED; nothing run): r2's product + pinned offline Foundry artifacts so no rig test skips
| file | what |
|---|---|
| `jobs/standalone-mcp-authority-r3-tests.sh` | the r2 runner (r2 inputs read and pinned) + a Foundry phase: pinned forge/solc, identical contract-input closure in both trees, one forge build per source in EACH clone, required artifacts with bytecode, both builds byte-identical |
| `CONTRACT-ARTIFACTS.txt` | the 8 sources compiled and the 9 artifacts the rigs read |
| `R2-PINS.sha256` | r2's SHA256SUMS (product, patch, CANDIDATE/BASE hashes, EXPECTED-TAP: exactly 73) |
Root: `./jobs/q-exit-status.sh standalone-mcp-authority-r3 2560 unshare -rn bash standalone-mcp-authority-stage/r3/jobs/standalone-mcp-authority-r3-tests.sh`

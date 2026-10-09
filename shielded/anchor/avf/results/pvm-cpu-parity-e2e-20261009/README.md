# The phone at parity with the CPU hosts (2026-10-09, production, Base mainnet)

Builds `d77da9e3…` (config, waf, egress) and `ad6ec91d…` (sealed secrets), protected, release key; relay `545026b91`,
`e17652a63` (main). Every purchase below was made by the platform's agent wallet as an ordinary buyer, pinned to
`pixel10-pvm-cpu`, and served at its public `https://<label>.app.enclave.host` through TUNA with the VM's own certificate.

| time (UTC) | what | evidence |
|---|---|---|
| 04:03:46 | **a catalog socket app**: pixelboard 0.1.4 (`ports: http:8000`, wasi:cli/run + wasi:sockets) bought, claimed, served | deployment `0xf14fa921…`; `GET /api/board` 200 publicly; compile 541 ms |
| 04:52 | the fleet's capability fold: `rateCap`, `proofOfTime`, `mem64`, `cpuFallback`, `configCidOverride` back to true fleet-wide (the phone had folded them false by omitting them) | `GET /availability` |
| 04:56 | **a configured app**: api-mcp-adapter 1.0.0 with a `config` override (one HTTP tool), `waf` rules, and a staged secret | deployment `0x77e75476…`; claim tx `0x1586cc7a…` |
| 05:00:12 | **a live config edit** (`setConfig`): the agent saw it on the next round, judged it, relaunched the VM on it, same lease | tx `0x79fe0a6d…`; agent `config-edited`, `options` (454 B) |
| 05:02 | **the owner's protection rules, in the VM's front**: `DELETE /mcp` → 405 `waf_method`; `/.env` → 403 `waf_path`; the app's own key check → 401 | the platform's exact bodies |
| 05:06 | **egress**: `tools/call` → the app in the VM fetched `https://api.github.com/repos/bytecodealliance/wasmtime` through the phone, the host agent and the app's own TUNA circuit (DoH through it), TLS verified in the VM → `"bytecodealliance/wasmtime"` | MCP response |
| 05:16:06 | **the owner's secret, sealed to the VM**: the relay verified the VM's v4 evidence and its seal-key statement over its own nonce, sealed the one staged secret to that key and signed it (keyId `06212e5df9c3779a`); the agent relaunched the VM with 354 bytes of ciphertext; the VM checked the signature against the key its build pins and opened it | agent `secrets-sealed` / `secrets-applied`; VM `secrets sealed by the relay (opened in pvm-rt)` |
| 05:17:05 | a second config edit points the app's `api_key` at `$MCP_ADAPTER_API_KEY` (the value exists only as the sealed secret): re-released while the old VM served, relaunched; `$NAME` resolved in the VM | tx `0x8dcb3653…` |
| 05:33 | with the key: `tools/list` and `tools/call` → `"bytecodealliance/wasmtime"` (egress again); without it: 401; the WAF answers unchanged | MCP responses |

Found and fixed live on the way: vsock 7788 was already the sealed port (egress there refused every app: moved to 7790,
static assert added); `adb exec-in` from node dropped the options file's bytes (`adb shell` with stdin); the CLI did not
hand the device its egress port (no `adb reverse` for 18189: ConnectionRefused in the VM); the relay refuses a pVM host
plaintext secrets by design (app-evidence hosts get them sealed to the VM: relay/pvm-secrets.mjs, pvm-rt
sealed_release.rs); a config edit left TUNA proving the app against the old expectation until a reload (tuna-enroll now
signals the privacy agent).

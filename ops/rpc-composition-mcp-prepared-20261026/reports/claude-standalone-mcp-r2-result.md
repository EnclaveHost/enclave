# Standalone MCP authority r2 (2026-10-26 UTC). PREPARED, NOT RUN

**Stage:** `standalone-mcp-authority-stage/r2/` (r1 frozen).

**Exact manifests and hashes:**
```
e3ffe9066b08a934382e0e37ac8d1d19c77b9ac04348327ee5bb9e7bd428eea4  SHA256SUMS
dccad59c208273c25c9da7e08b33341e44481c7d68b5e9a5ad180f103a034604  standalone-mcp-authority-r2.patch
db2a338532f4f2293390a7a56f9a047a12d2b703d81da66cda0351638d974b10  jobs/standalone-mcp-authority-r2-tests.sh
2159abb15813cdd8bb17586b325cac35e0a36bc9411f8658e1cf0b5b093fd44a  EXPECTED-TAP.txt
12245443fff2fc345ed654de7303258168018ae674f0dd1b11631a006dd18453  cli/independent.mjs
62fbcff321c4bcf01256651bbb58abb7a18f9a7bdb2f41207918031a4afbcfd1  mcp/independent.mjs
27fedacb018cd87d5d61230197d1da557ab2214261d968163490e17caf10dcd9  mcp/independent-secrets.mjs
00338a592c669d41cb2bd6a1250e17142240056f9759c3ea30735c710c1edd5d  cli/independent.mjs
ad8d0314faa59bffcfcecbe75683b77b455c2d918494d632ece69dd3a0730c7c  mcp/independent.mjs
646fc7569a58806fdb4ff9059bd667bb40f49225912cedd8070c7e5d3b44fb44  mcp/independent-secrets.mjs
a06a99cbb1e5d0a61d51f1526ab7b508828269fcf1def16e5cc34fdb2735bd11  test/mcp-independent-verifier.test.mjs
```

---

# standalone-mcp-authority-stage r2 (PREPARED, NOT RUN): root-review corrections on top of r1 (r1 frozen in `../`)

**Not done:** no tests, builds, queue use, network, SSH, live change or upstream commit. Only `node --check` and
`bash -n` were run.

## Base

- **Pin:** `relay-consumer-source` **`b6ac5d657`**.
- **Exact before-hashes:** `BASE-b6ac5d657.sha256`, checked by the job.
- **Same files at the newer head:** the 3 source files are byte-identical at the current head `12b41d459` (the credit
  page commit is file-disjoint):

  | File | sha256 (both heads) |
  | --- | --- |
  | `cli/independent.mjs` | `12245443…` |
  | `mcp/independent.mjs` | `62fbcff3…` |
  | `mcp/independent-secrets.mjs` | `27fedacb…` |

## Changes from r1 (root review)

1. **Corrected comment** (`mcp/independent.mjs`, above `VerifierChain`). The `VERIFIER_CLIENT` mark **distinguishes**
   the clients `createChainAuthority` builds from ordinary RPC clients; a configuration value cannot produce one. It is
   **not a security boundary against in-process code**: `Symbol.for` is a global registry key that any code in the
   process could set. The trust boundary is the operator's profile (`chainAuthority` plus a loopback-only
   `chainVerifier`) and the verifier. There is no security redesign; the code is unchanged. The test comment says the
   same.
2. **A public tool-path test for custody v2 refusal (new test 7).** It uses the real `createIndependentServer(...)
   .dispatch({method: "tools/call"})` for the local server (`get_secrets`, `set_secrets`) **and** the remote adapter
   (`get_secrets`/`set_secrets` with `action: "prepare"`), on a verifier profile.
   - each call is `isError` with the exact custody v2 refusal;
   - **the verifier received 0 requests** (no chain read);
   - **a process-wide fetch recorder saw 0 requests**: no custodian, no default RPC, nothing.

   **Why the order is guaranteed:** `backend.run` runs `authority.ready()` (no chain read; the verifier client is lazy)
   and then the handler. Every v2 handler calls `custodyContext` right after its argument check, and the guard is that
   function's first statement.
3. **Existing quorum secrets functionality unchanged (new test 8).** On a quorum profile, `get_secrets` proceeds to its
   chain reads: both fixture peers are asked, and it fails only on the offline fixture with a quorum error, **never**
   with the verifier refusal.
4. **Recorded destinations (new test 9).** For the stale, replaced-block and unavailable verifier cases, a fetch
   recorder shows **every** request went to the configured verifier URL and **none** to a public RPC host (publicnode,
   drpc, 1rpc, mainnet.base.org, blastapi, tenderly, nodies, llamarpc, ankr, alchemy, infura).

**Unchanged from r1:** the seam, the selection and refusal rules, the legacy quorum, and wallet/admin/attestation
behaviour.

**v1:** the hosted relay's v1 secrets path is not in these files and is untouched. The independent MCP serves custody
v2 only, and quorum profiles keep it exactly as before.

## Files (`SHA256SUMS` covers all)

| File | Notes |
| --- | --- |
| `base/`, `BASE-b6ac5d657.sha256` | the 3 source files at `b6ac5d657` |
| `candidate/`, `CANDIDATE.sha256` | the 3 files + `test/mcp-independent-verifier.test.mjs` (**9 tests**) |
| `standalone-mcp-authority-r2.patch` | 335 lines. Applies to `git archive b6ac5d657` (before-hashes verified) and reproduces `CANDIDATE.sha256` exactly (checked) |
| `EXPECTED-TAP.txt` | exact counts |
| `jobs/standalone-mcp-authority-r2-tests.sh` | the r1 runner with r2 paths and the r2 patch |

**Expected counts: exactly 73**, with 0 fail/skip/todo/cancelled:

| Suite | Tree | Tests |
| --- | --- | --- |
| `mcp-independent-verifier` | candidate | 9 |
| `mcp-independent-unit` | candidate and base | 10 + 10 |
| `mcp-independent` | candidate and base | 13 + 13 |
| `cli-combined-independent` | candidate and base | 4 + 4 |
| `chain-authority` | candidate | 10 |

## Root job (offline; queue cap 1408)

```
./jobs/q-exit-status.sh standalone-mcp-authority-r2 1408 unshare -rn bash standalone-mcp-authority-stage/r2/jobs/standalone-mcp-authority-r2-tests.sh
```

**Exit codes:**

| Code | Meaning |
| --- | --- |
| 0 | PASS |
| 1 | FAIL |
| 30 | INCOMPLETE |
| 20 | SETUP (never a verdict) |

## Limits (unchanged from r1)

- **The guest MCP activation gate stands:** a rebuilt bundle, a new measured control release, an in-guest loopback
  verifier with a reviewed proof-source route (not live), and a bound config.
- **The recorder serves no proofs.** The tests prove selection, refusal and destinations.
- **No proof or SNP qualification is claimed.** The verifier is the unsafe tier.
- **Unchanged:** Custody v2 stays refused, and lease consumers stay on HOLD.

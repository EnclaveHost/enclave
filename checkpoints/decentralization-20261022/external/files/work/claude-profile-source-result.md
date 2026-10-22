# Deployed-runtime source verification: result (2026-10-19)

**What I did not do:**
- no commits, pushes or SSH;
- no access to private configuration;
- no wallet use, chain writes or production changes;
- no subagents or new windows.

**What I did not modify:**
- the authority profile's six files (profile digest still `sha256:ee957827…4cb8`);
- contract sources;
- browser, CLI, Windows, management, custody or isolation code;
- `/home/steven/Projects/enclave`, which I read only with `git show` and `cat-file`.

**Network access:**
- read-only public Base RPCs: publicnode, base.org, drpc;
- one anonymous, blobless, bare clone of the public `https://github.com/EnclaveHost/enclave.git` into scratch (9.1 MB in
  total).

## Files (new, owned)

| File | Purpose |
| --- | --- |
| `enclave/scripts/network/verify-deployed-sources.mjs` | Reusable verifier. Strict manifest validation, pinned compiler (version, npm package, `soljson.js` SHA-256), source reads by commit+blob+SHA-256 from any git directory, single-job compilation with no import callback, an agreed live read (`LeaseReader.agreed`, 2–8 HTTPS RPCs), and a byte-level comparison. The comparison covers CBOR metadata and handles immutables, links and library guards. Optional profile cross-check. Writes results only with `--out` and never overwrites. |
| `enclave/contracts/deployments/source-verification-base.json` | The manifest: repository, compiler pin, review block, 10 builds and 13 contracts. Each contract records its commit, unit, path, git blob, source SHA-256, settings, address, runtime size, code hash, metadata IPFS hash, expected immutables and links, its profile name, and the basis for those values. Also one external proxy (USDC) with its implementation and admin slots. SHA-256 `6ca31d5f802a2db3a40859a89e43947509ccec482231a4819389abf0057aa8e4`. |
| `enclave/test/deployed-sources.test.mjs` | 11 offline tests. |
| `enclave/docs/network/deployed-sources.md` | Results, what counts as a full match, findings, the USDC proxy distinction, usage and remaining gaps. |

**Saved evidence:** `work/claude-profile-source-live-verification.json`, the full `--out` report of the live run.

**Scratch:** `work/profile-source-verification/`. It holds the search and authoring scripts, the agreed live code
snapshots and the partial clone.

## Live result

- **Block:** 52831645, hash `0x30d9dd7e442eb874d8744efd858152449c83c210bd02cbb1fac12f9e34fbe40f`.
- **RPCs:** base-rpc.publicnode.com, mainnet.base.org and base.drpc.org. No peer failures.
- **Profile cross-check:** on, with digest `sha256:ee957827…`.
- **Resources:** peak RSS 366 MiB, about 40 s, one solc job at a time.

| Contract | Address | Commit (full) | Unit / settings | Status |
| --- | --- | --- | --- | --- |
| registry | 0x868eb7fc5b5a84b2ff082eafc9bf40b7aac5ccac | b17db9a33b3500783a67774f4e47ec648e833699 | EnclaveRegistry.sol / runs 200 | full-match |
| deployments | 0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b | 4b7419bb0955ffd02a6ce8d75809dac0a18f302f | EnclaveDeployments.sol / runs 1 viaIR | full-match |
| ledgerBandwidthLibrary | 0x3dfee18b44b7ecd389eca78da10b6ad032802215 | same | same | full-match |
| appCatalog | 0x18419ca2b502d423a8de6269aeee171a378626e3 | f2e9a71d0fb25b67a774be76b29081f6cb6f8ec3 | EnclaveAppCatalog.sol / runs 200 viaIR | full-match |
| proofOfTime | 0x6f462d77727f10f05a3e660650e7dcc9cc60e6b2 | 44d5b928b9afe7d207bed0f1d8d4ae6976dd6401 | runs 200 viaIR | full-match |
| enclavePay | 0x580270e88e5df35dad59e7fe3d907ebea96673a6 | cf6022cce34034455f7d28a98b2059ac35525857 | runs 200 | full-match |
| verificationFees | 0x87c7266543ff5839b2c20226bd9b3cd511a23641 | 28dd23c2e289413232553f54be939b618fd576d3 | runs 200 viaIR | full-match |
| connectivity | 0x5f8b636e0768e84bd47b736652030b65db615111 | 4b7419bb0955ffd02a6ce8d75809dac0a18f302f | `contracts/EnclaveConnectivity.sol` + `contracts/EnclaveDeployments.sol` / runs 200 viaIR | full-match |
| paymentRouter | 0xf17157b42ebbd65e33dd592878a8f1769c69d56a | 09ccf9cdb7624c9ef96584c00db95dd21fb9de92 | runs 200 | full-match |
| keyAttestations | 0xb49241efe5af6078be6aa84850ae45eed34df61b | ee28c686f8361f9e883776112a742217398c7340 | runs 200 | full-match |
| legacySessionVaultFactory | 0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c | 4aea7d8986681bb7ccfef27067e7222a8eafbcdf | SessionVault.sol / runs 1 viaIR | full-match |
| legacySessionVaultImplementation | 0x66c76a47209f44612343dbeab98b8ef77ad01f65 | same | same | full-match |
| legacySessionVaultLib | 0x5510ae9fed97577d75c69545384af7d8bad05027 | same | same | full-match |
| usdc (external) | 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 | — | proxy, CBOR solc 0.6.12 | proxy-runtime-pinned-source-not-verified |

**USDC slots.** The run observed implementation `0x2ce6311ddae708829bc0784c967b7d77d19fd779` (a contract) and admin
`0x4fc7850364958d97b4d3f5a08f79db2493f8ca44` (an EOA). Neither is pinned (`implementationPinned: false`): Circle's admin
can upgrade the implementation without changing the proxy hash.

**Compiler.** `0.8.35+commit.47b9dedd.Emscripten.clang`, package `solc@0.8.35`. The `soljson.js` SHA-256 is pinned in
the manifest.

**Code hashes.** Every Enclave code hash equals the one pinned in the profile. Each entry also records its source blob
and SHA-256, the metadata IPFS hash and the immutable values.

### What "full match" means

- **Equal length.**
- **Identical bytes, including the CBOR metadata.** The metadata embeds the keccak of every source, the unit names and
  the settings.
- **Only compiler-declared slots may differ:** `immutableReferences`, `linkReferences`, and a library's own-address guard
  (`library_deploy_address` under viaIR, `PUSH20 <self>` under legacy codegen).
- **Consistent slot values:** every occurrence of a slot carries the same value.
- **Slot values equal the manifest.** Before recording them, I cross-checked 26 values against independent sources:
  - the address immutables against the profile's getter bindings;
  - the legacy vault's args and library link against `ledger-15d-base.json`;
  - the library guards against each library's own address.
- **Disclosed, never matched:** a metadata-only difference is reported as `executable bytes equal but metadata differs
  (partial match only)`.

### How the sources were found (reproducible, no explorer labels)

1. **Read the live runtimes**, using agreed reads at one block.
2. **Decode the CBOR metadata.** Every Enclave runtime names solc 0.8.35 and an IPFS metadata hash.
3. **Reproduce solc's IPFS metadata hash** (single-block UnixFS, SHA-256). Validated against a fresh compile.
4. **Search history with metadata-only compiles** (about 60 ms each):
   - every historical blob of each candidate file in the full history, with imports resolved at the same commit;
   - optimizer runs {1, 200}, viaIR on and off, and unit names bare or under `contracts/`.
5. **Connectivity needed a wider search:** cross products of its source with all 34 ledger blobs, a wider settings grid,
   and unit-name prefixes.
6. **Full compiles for every match:** each matching revision was compiled fully and compared byte for byte by the tool.

## Findings that change earlier statements

1. **The registry is deployed at schema 4, not HEAD's schema 5.**
   - HEAD's blob `b7064f3e` dates from `9895865c` (2026-08-11).
   - It adds `CAP_*`, `registerRelay`, `setCaps` and `CapsSet`.
   - Their selectors (`204d567f`, `4d13968b`, `1819aa1d`) are absent from the live runtime.
   - So the parity audit's "`register`/`registerRelay` permissionless" and capability-bit statements describe source, not
     `0x868e…`.
2. **The deployed ledger is rev 16d (blob `3f3d2c3a`). HEAD's `contracts/EnclaveDeployments.sol` also says
   `deploymentsSchema = 16`, but differs in 68 lines.**
   - The deployed ledger has wallet-chosen `setDelegate` delegates, accepted by `_requireOwned`.
   - The schema number does not identify the code.
   - The set of contract-owner-checked functions is identical in both sources, so the profile's ledger owner-power text
     holds for the deployed bytes.
3. **The ledger links an unlisted library, `EnclaveLedgerBandwidth` at `0x3dfee18b…`.** It is now source-verified. The
   profile pins it only transitively, through the ledger's hash.
4. **Connectivity was compiled with `contracts/`-prefixed unit names, at runs 200.**
   - This is not the artifact pipeline. No committed artifact contains its metadata, and the deploying script is not
     identified.
   - The sources are committed. Connectivity blob `c0fb0bed` is paired with the live ledger blob.
   - The deployed contract uses the pre-v2 `tuna` interface.
5. **These deployed sources are byte-identical to the work repo's HEAD:** catalog, proof of time, pay, verificationFees,
   connectivity, router, key attestations and SessionVault. For them, the profile's owner-power text describes the
   deployed bytes.
6. **The router's immutable `treasury` `0x271a…f44d` is an EOA with an EIP-7702 delegation.** It points to
   `0x63c0c19a282a1b52b07dd5a65b58948a07dae32b` (11,185 bytes). The key holder can change it, and neither the key holder
   nor the delegate is verified.
7. **Owner and payout `0x0b2d…` and the USDC admin are EOAs.** The ledger's `ethUsdFeed` `0x71041ddd…` is an external
   contract and is not verified.

## Tests

**Command:**
`node --test test/deployed-sources.test.mjs test/authority-profile.test.mjs test/host-contract-pins.test.mjs test/lease-reader.test.mjs`

**Result:** 40/40 pass. 11 of those tests are new, and none were skipped.

**Coverage of the new tests:**
- **Manifest:**
  - strictness;
  - coverage of every profile `observed` entry;
  - agreement with the profile bindings and the ledger-15d record;
  - 13 refusal cases.
- **Metadata:** reproduction of the IPFS metadata hash, and CBOR parsing.
- **Offline exact rebuilds** of the router, pay and key attestations from git HEAD, landing on the live code hashes.
- **Precise mismatches:**
  - one executable byte, with its offset and count;
  - metadata only, reported as partial;
  - a wrong, undeclared or missing immutable;
  - occurrences of a slot that disagree;
  - a length difference;
  - empty code.
- **Inputs that must not fully match:** a comment-only change, different runs, and a renamed unit.
- **Libraries:** links and own-address guards, under legacy codegen and under viaIR.
- **Source pinning:** blob, digest, commit and path, and refusal of unpinned imports.
- **Compiler pins:** version, `soljson.js` digest and package.
- **End to end with scripted peers:**
  - a full match;
  - an upgraded proxy implementation that still passes, which shows it is not pinned;
  - two agreeing liars, refused at the comparison;
  - a single liar, which yields no quorum;
  - wrong chain;
  - stale blocks;
  - missing code;
  - changed proxy bytes.
- **CLI refusals.**

**Other checks:** all 10 builds' sources also resolve from the independent full clone at `/home/steven/Projects/enclave`.

## Remaining verification gaps

1. **USDC.** The proxy and implementation sources are not verified, and the implementation is upgradeable by its admin.
   This is external trust. The tool can only pin the proxy bytes and report the slots.
2. **Unverified addresses:** the EIP-7702 treasury delegate `0x63c0c19a…` and the ETH/USD feed `0x71041ddd…`.
3. **Compiler binary.** The `soljson.js` digest has not been cross-checked against the official
   `binaries.soliditylang.org` list. Only the local npm package is pinned.
4. **Connectivity deploy pipeline.** The script is unidentified. Its inputs and output are reproduced exactly.
5. **Contracts outside the profile** were not attempted: the address book, session v1, credit vault, featured, reviews,
   availability, host paymaster and secret vault v1.
6. **Bytes, not behaviour.** Source verification proves the bytes come from the source. It is not an audit of the
   source's behaviour. Owner powers remain as documented.
7. **RPC trust.** Chain reads are an RPC quorum, not a light client.
8. **Profile not updated.** The authority profile still labels these runtimes `observed`. Its owner-power text still
   says the powers are not proven for these bytes, and its doc does not mention schema 4 vs 5 beyond noting the
   difference.
   - **Suggested coordinator follow-up:** a reviewed v2 profile that references this manifest, records `source-verified`
     provenance and adds the ledger library. It would have a new digest.
9. **The parity audit's registry statements need correcting.** Its `registerRelay` and capability-bit statements do not
   describe the deployed registry.

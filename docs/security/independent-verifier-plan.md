# An Enclave-owned verifier: trust map, gap analysis, recommendation, rollout

Status: investigation and bounded proof of concept, branch `research/independent-verifier`.
Written 2026-09-24 against main at fcb980c0 plus the feature branches named in section 2.6.
Nothing in this document changes production verification; section 9 is the only path by which it may.

## 0. Summary

Today "verified" on the hosted fleet means: the `@tinfoilsh/verifier` library, fetching through two Tinfoil-run
proxies, checks a Tinfoil-shim document against a Tinfoil-produced release predicate, chains it to AMD's
Genoa root embedded in the library, and binds it to a Tinfoil-shim certificate format. The relay, metal and
isolation paths already verify SEV-SNP first-party (`relay/snp-verify.mjs`), but that code has no release
provenance, no revocation handling, no browser build, and cannot verify an ABI/2 document on main.

Recommendation: **option B, own the orchestration and formats, keep audited primitives**, seeded from the
existing first-party code. Concretely: one evidence envelope with a closed format registry, one verdict model
with `verified | rejected | unsupported`, an explicit policy object (pinned roots, product lines, TCB floors,
VMPL, policy bits, binding rule per format, release identity, collateral freshness), collateral that is
verifiable from any source because everything chains to a pin, and release provenance verified against an
identity **we** state (repo, workflow path, tag pattern, OIDC issuer, predicate type) with the Sigstore root
taken from Sigstore's TUF repository. Cryptography and X.509/Sigstore parsing come from Node's crypto,
WebCrypto, and reviewed libraries (`@freedomofpress/sigstore-browser` today, `sigstore-js` as the Node
reference). No cryptographic primitive is invented, and no new mandatory service is introduced: the verifier
runs in the client (browser, CLI, relay), mirrors are optional caches of vendor-signed data, and the enclave
self-check stays a diagnostic.

The proof of concept (section 8) verifies authentic Genoa and Turin evidence offline, exercises adversarial
mutations of every input independently, and uses Tinfoil's verifier as one differential reference.

## 1. Scope and terms

- **Evidence**: bytes a client obtains from the party being verified (report, certificate, document).
- **Collateral**: vendor-published data needed to judge evidence (AMD ARK/ASK/VCEK/CRL, Sigstore trusted
  root, Google attestation roots, Intel PCS data, NVIDIA RIMs). Public, signed, cacheable.
- **Policy**: what the verifier's operator or user decided to accept. Never learned from the server.
- **Verdict**: `verified` (admission-safe: every security check passed and the policy omitted nothing),
  `limited` (every cryptographic check passed but the policy explicitly skipped a security check, or the
  report version's semantics are unimplemented; the omissions are listed; never admission-safe), `rejected`
  (a check failed), `unsupported` (the evidence class or version is not implemented; never green). Each
  carries reasons, per-check results (`true`, `false`, or `null` for not judged) and the authenticated claims.
  A research policy (no TCB floor, `crl: none`, no certificate binding, no nonce, an unjudged report
  version) can therefore be run and inspected, but its best outcome is `limited`, and `status === "verified"`
  is the only outcome a consumer may treat as acceptance.
- Dependency classes, kept separate throughout: **library** (code we run), **network service** (a host we
  fetch from at verification time), **release format and build toolchain** (who defines what a
  "measurement of our release" is), **hardware root** (whose signing key ends the chain), **deployment
  operator** (who runs the machine and the ingress).

## 2. Current trust and dependency map

### 2.1 Consumers of verification and what each trusts

| consumer | code | library | network services on the verification path | release format | hardware root | operator |
|---|---|---|---|---|---|---|
| Browser "verify it yourself" | `site/js/core/verify.js` -> `site/vendor/verifier.js` (built by `scripts/build-vendor.mjs`, pin 1.1.10; upstream is at 1.2.1) | `@tinfoilsh/verifier` 1.1.10 (Apache-2.0), `@freedomofpress/sigstore-browser` 0.1.14 (Apache-2.0 LICENSE file), `crypto-browser` 0.1.7 (Apache-2.0) | `github-proxy.tinfoil.sh` (releases/latest, tinfoil.hash, attestations), `kds-proxy.tinfoil.sh` (VCEK), `api.github.com` (repo casing), the enclave host (RAD + certificate) | Tinfoil predicate `snp-tdx-multiplatform/v1` produced by `tinfoilsh/measure-image-action` | AMD Genoa ARK/ASK embedded in the library (Genoa only) | Tinfoil (shim, TLS key, ingress) |
| CLI `enclave attest` | `cli/enclave.mjs` `verifyEnclaveOrigin` | `@tinfoilsh/verifier` ^1.1.7 (cli/package.json) | same proxies | same | same | same |
| Enclave self-check | `supervisor.js` `runSelfCheck` / `verifyMatchingRelease` | `@tinfoilsh/verifier` 1.1.10 | same proxies, hairpin to its own origin | same | same | same; labelled diagnostic, not trust |
| MCP / docs | `relay/mcp.js`, `site/components/attest-chain` | text pointers only | n/a | n/a | n/a | n/a |
| Relay attach gate (permissionless sellers) | `relay/tunnel.js` -> `relay/snp-verify.mjs` | none (node:crypto) | `kdsintf.amd.com` directly (or the report's own cert table) | none: `METAL_ALLOWED_MEASUREMENTS` env allowlist, `METAL_MIN_TCB` env | Milan/Genoa/Turin ARKs pinned by sha256, corroborated against go-sev-guest | the seller |
| Metal buyer tool | `metal/verify.mjs` | none | `kdsintf.amd.com` | none: local `metal/dist/manifest.json` from `sev-snp-measure` | same pins | the seller |
| Isolation judge (M2..M4) | `isolation/m2/judge.mjs` | none | KDS or `--no-kds` | none: `--measurement` on the command line | same pins | the lab |
| Android pVM attach | `relay/avf-verify.mjs`, branch `relay/pvm-app-attest.mjs` | none | none at verify time | APK code hash + signer hash policy from env | Google attestation roots pinned (2 fingerprints) | the phone owner |
| Windows VBS attach | `relay/vbs-verify.mjs` | none | none at verify time | enclave identity policy from env | AMD fTPM EK root pinned | the node owner |
| Windows partition (T0-hv) | `windows/vbslike/verify/judge-hv.mjs` | none | none | launcher key | none (no hardware root; `hostExcluded=false` by contract) | the node owner |
| GPU (NVIDIA CC) | `supervisor.js getMeasurements` publishes the NVML report and a pointer to NRAS/nvtrust | none | n/a | n/a | not verified first-party anywhere | n/a |
| Intel TDX | `supervisor.js parseTdxQuote` | parse only | n/a | n/a | not verified anywhere | n/a |

Source lines: `supervisor.js:41` (import), `:3460` (`RAD_PATH`), `:3630-3662` (proxy probing of sibling
flavors), `:3701-3769` (`getMeasurements`), `:6732` (public re-serve of the RAD); `site/js/core/verify.js:37-64`
(same probing in the browser), `:70` (`EXPECTED_REPO` pin); `cli/enclave.mjs:912-946`;
`relay/tunnel.js:402-507` (formats `sev-snp-guest*`, `android-avf-pvm/v1`, pad v2, `windows-vbs-enclave/v1`);
`relay/api-relay.js:130-141` (env policies), `:1408-1413` (`computeEligible`: dialed rows trust their own
`availability.teeCpu`).

### 2.2 What the Tinfoil library actually checks (1.1.10, read from `dist/`)

- `bundle.js`: fetches `/.well-known/tinfoil-attestation` and `/.well-known/tinfoil-certificate` from the
  host, `releases/latest` + `tinfoil.hash` + `attestations/sha256:<digest>` from `github-proxy.tinfoil.sh`,
  and the VCEK from `kds-proxy.tinfoil.sh` using the Milan/Genoa TCB layout and the full 64-byte chip id.
- `sev/cert-chain.js`: **Genoa only** (`fromReport` throws for any other product; a Turin report fails even earlier,
  in the parser's TCB_VERSION check, which applies the Milan/Genoa layout to a field Turin lays out differently), ARK/ASK from
  `sev/certs.js`, RSA-PSS on the VCEK, P-384 key, no `CSP_ID` (VLEK refused), certificate validity at `now`.
- `sev/report.js`: fixed-offset parse with MBZ checks, VCEK signer only, ECDSA P-384 only.
- `sev/validation.js`: **Tinfoil's** floors baked in (`minimumTcb` bl 7 / snp 14 / ucode 72, firmware
  build 21, version 1.55; DEBUG and MIGRATE_MA refused; SMT allowed). No caller policy in the site/CLI path.
- `sigstore.js`: embedded trusted root (JSON-identical to Sigstore's TUF `trusted_root.json` v14 on
  2026-09-24, checked), bundle v0.3 only, policy = GitHub OIDC issuer + repository + `^refs/tags/`, in-toto
  statement with only the recognised fields, predicate must be Tinfoil's, subject digest must equal the
  digest fetched from GitHub. **The workflow path is not part of the policy**: any tagged workflow in the
  repo may sign.
- `cert-verify.js` + `dcode.js`: the served certificate must carry the enclave's domain, an `.hpke.` SAN set
  encoding the HPKE key that `report_data[32:64]` states, and a `.hatt.` SAN set encoding
  sha256(format + body). This is the shim's format; nothing else produces such a certificate.
- `client.js`: the five steps `fetchDigest, verifyEnclave, verifyCode, compareMeasurements, verifyCertificate`;
  `securityVerified` only when all pass.

### 2.3 What the release actually is

`.github/workflows/tinfoil-release-publish.yml` runs `tinfoilsh/measure-image-action@e9967c4a` (v0.9.2)
with `id-token: write` and `attestations: write`. The GitHub attestation for v0.5.841 (fixture
`test/fixtures/verifier/release/`) is a Sigstore v0.3 bundle whose Fulcio certificate states issuer
`https://token.actions.githubusercontent.com`, repository `EnclaveHost/enclave`, ref `refs/tags/v0.5.841`,
build config `https://github.com/EnclaveHost/enclave/.github/workflows/tinfoil-release-publish.yml@refs/tags/v0.5.841`,
trigger `workflow_dispatch`, and a Rekor v1 entry with inclusion proof and promise. The in-toto predicate
is `https://tinfoil.sh/predicate/snp-tdx-multiplatform/v1` with `snp_measurement`, `tdx_measurement`
(rtmr1, rtmr2), the kernel `cmdline` (dm-verity root hash, `tinfoil-config-hash`), `hashes` of Tinfoil's
CVM image (`version v0.7.5`: root, initrd, kernel, raw) and the base64 `tinfoil-config.yml`.

So the launch measurement's **meaning** (this measurement is our containers under Tinfoil's OS) is defined
by Tinfoil's image and Tinfoil's action. We can verify the signature chain and the identity that produced
it; we cannot today recompute `snp_measurement` from sources we hold. That is a build-toolchain dependency,
distinct from the library and from the proxies, and the one that survives every option in section 4 until
either Tinfoil's image inputs are archived and re-measured per release (`sev-snp-measure`) or the fleet
runs our own image (metal, M4b).

### 2.4 Network services, and what each actually is

| host | operated by | content | replaceable by | consequence if it lies or is down |
|---|---|---|---|---|
| `github-proxy.tinfoil.sh` | Tinfoil | CORS front for `api.github.com` and release assets | direct GitHub calls (server side), a signed release index we publish (section 5), any mirror: bundles are self-verifying | lie: cannot forge a bundle, can serve an older genuine release (rollback) or nothing; down: browser verification fails |
| `kds-proxy.tinfoil.sh` | Tinfoil | cache of `kdsintf.amd.com` VCEKs | KDS directly, the report's own certificate table, any mirror: VCEK chains to the pinned ASK and its extensions must match the report | lie: cannot forge; down: no chain (KDS itself rate-limits with 429) |
| `kdsintf.amd.com` | AMD | VCEK, cert_chain, CRL | mirror + auxblob | same |
| `rekor.sigstore.dev`, `fulcio.sigstore.dev`, `tuf-repo-cdn.sigstore.dev` | Sigstore | not contacted at verify time; the trusted root is embedded; bundles carry inclusion proofs | TUF refresh of the root on a schedule | root expiry blocks verification of new releases only |
| the enclave host | Tinfoil shim (hosted) / metal agent / domain front | RAD, certificate | none: this is the evidence | n/a |

### 2.5 Evidence classes and the binding rule each uses

| format string | technology | `report_data[0:32]` | `[32:64]` | freshness | first-party verifier today |
|---|---|---|---|---|---|
| `https://tinfoil.sh/predicate/sev-snp-guest/v2` | SNP, hosted | sha256(TLS SPKI) | HPKE public key | none in the report; the certificate's `hatt` SAN binds the document to the served certificate, whose validity window is the clock | none (Tinfoil lib only) |
| `sev-snp-guest-metal-v1` | SNP, metal | sha256(SPKI) or sha256(SPKI || nonce) on attach | zero | relay nonce per attach | `relay/snp-verify.mjs`, `metal/verify.mjs` |
| `sev-snp-guest-domain-v1` | SNP, isolation | ABI/1 sha256(SPKI || nonce); ABI/2 `Bind2` = sha256("enclave-bind-v2\n" || SPKI || nonce || RuntimeID) | AppID from the monitor | verifier nonce | `isolation/m2/judge.mjs` (+ `expectedBinding`, branch only) |
| `hyperv-partition-domain/v1` | none (T0-hv) | same as domain | AppID | verifier nonce | `windows/vbslike/verify/judge-hv.mjs` (launcher signature, no hardware) |
| `android-avf-pvm/v1`, pad v2, ABI/2 app | AVF | sha256(transcript) as the AVF challenge; ABI/2: `Bind2 || AppID` (64 bytes) | n/a | relay nonce | `relay/avf-verify.mjs`, `relay/pvm-app-attest.mjs` (branch) |
| `windows-vbs-enclave/v1` | VBS enclave + TPM | `EnclaveData` = sha256(bound transcript) | n/a | relay nonce + TPM quote nonce | `relay/vbs-verify.mjs` |
| `tdx-guest-metal-v1` | TDX | as metal | zero | as metal | **none** (parse only) |
| `dev-unattested-metal-v1` | none | n/a | n/a | n/a | must be refused (`metal/verify.mjs` exits 1) |
| NVIDIA CC report | GPU | NVML nonce | n/a | owner nonce | **none** |

### 2.6 The feature branches (read-only)

- `origin/isolation/portable-runtime-jit` (fb5e466c) and `origin/windows/custom-vbs-like-hyperv` (67762434):
  `isolation/contract/runtime.{go,mjs}` (RuntimeIdentity, `RuntimeID`, `Bind2`, `CacheKey`, vectors),
  `relay/snp-verify.mjs` gains `expectedBinding`, `isolation/m2/judge.mjs` gains `checkRuntime` and
  `checkRuntimeSelfTest`, `judge-hv.mjs` imports the same `checkRuntime`. One parser, three consumers.
- `origin/pvm-cpu/portable-runtime` (4840c57e): `relay/pvm-app-attest.mjs` restates RuntimeID/Bind2 with a
  note to import `runtime.mjs` once it lands, `verifyPvmAppAbi2` expects the AVF challenge to be
  `Bind2 || AppID`. The relay-side frame for the ABI/2 pVM attach is not decided (pVM owner, 2026-09-24).
- Agreed with both owners on 2026-09-24: the verifier **imports** `runtime.mjs`, `verifyPvmAppAbi2` and
  `abi2FromLog`, never copies them; ABI/2 bindings enter the SNP verifier as caller-supplied bytes; the
  contract vectors are reused as data with the commit hash noted.
- Proposed by the pVM owner on 2026-09-24 (not yet pushed): a client-verified evidence interface. A client
  sends `EVIDENCE <nonce>` over a relay-spliced stream and the pVM answers one JSON line (format
  `enclave-pvm-app-evidence/v1`: echoed nonce, AppID, Ed25519 transport SPKI, canonical runtime identity,
  self-test, certificate chain) whose AVF challenge is `Bind2(spki, nonce, RuntimeID) || AppID` over the
  CLIENT's nonce; `verifyPvmAppEvidence` checks the envelope and delegates to `verifyPvmAppAbi2` with the
  caller's nonce, app id and pins, never the envelope's. The harness will import it and register the
  format as a delegated AVF class. Changes requested: a closed envelope shape with exact lengths, the
  client nonce inside any delegated-key signature, an application-layer (HPKE) key for the browser path
  because browser JavaScript cannot read the peer TLS certificate, and a pure result that is `ok` only
  when every pin list is non-empty.

## 3. Gap analysis of the first-party implementation

Judged against the required properties, for `relay/snp-verify.mjs` (R), `metal/verify.mjs` (M),
`isolation/m2/judge.mjs` (J) and, for contrast, `@tinfoilsh/verifier` (T).

| property | R | M | J | T | gap the new verifier closes |
|---|---|---|---|---|---|
| signature chain to pinned roots | yes: sha256 pins for three lines, chain from KDS or auxblob | yes (same pins) | via R | Genoa only, PEMs embedded | keep the pins; add certificate validity windows, ASK subject/CN checks, and refuse VLEK explicitly |
| platform and TCB policy | caller `minTcb` on reported TCB, per-product layouts; no floor built in | `--min-tcb` | `--min-tcb` | Tinfoil's floors, all four TCBs, firmware build/version | policy object with explicit floors for reported **and** committed TCB, product allowlist, firmware version floor as an option |
| debug / VMPL / configuration | DEBUG, MIGRATE_MA refused; VMPL pinned (default 0) | same | same + boundary tuple above VMPL0 | DEBUG, MIGRATE_MA; SMT allowed; VMPL unchecked | export SMT, single-socket, CXL, RAPL, ciphertext hiding as claims; policy chooses which are required |
| nonce and replay / freshness | challenge bound into `report_data` | key-only or challenge | nonce | none (TLS certificate binding instead) | per-format freshness rule, stated in the verdict; no nonce means "possession at attest time, freshness rests on the certificate window" |
| measured workload / app / runtime identity, ABI/2 | measurement allowlist from env; ABI/2 only on the branch | manifest measurement | measurement + AppID + ABI/2 (branch) | measurement from Tinfoil predicate | measurement allowlist **derived from verified provenance**; app id and Bind2 as explicit inputs |
| TLS / transport key binding | SPKI from the handshake | served key | handshake SPKI | HPKE + hatt SANs | both rules, chosen by format; the hosted rule verified without Tinfoil code |
| release / build provenance against a trusted policy | none | none | none | repo + tag prefix, embedded root | Sigstore verification with our identity policy (repo, workflow path, tag pattern, issuer, predicate), trusted root from TUF, subject digest, minimum release |
| reject malformed / truncated / replayed / substituted / unknown / missing | bounded KDS fetch, length check `>= 0x330`, unknown format -> deny | exits on unknown format | reject | strict parser with MBZ checks | strict envelope (exact report length, base64 strictness, gzip caps), explicit `unsupported` verdict class |
| separation of evidence classes | tunnel dispatches by format string | SNP only | SNP | SNP (Genoa) only | one registry; TDX, GPU, unknown -> `unsupported`; dev formats -> `rejected` |
| key rotation / revocation / collateral expiry | VCEK cached per URL; no CRL; ARK pins only | no CRL | no CRL | certificate validity only | CRL parsed and ARK-signed, ASK serial checked, `nextUpdate` as the collateral clock, VCEK cached by public key not bytes (KDS re-signs: fixture shows two valid certs for one key) |
| rollback | none (env allowlist) | none | none | `releases/latest` only (older genuine releases verify) | minimum release / monotonic release index policy |
| offline verification | `kds:false` + `seedCertChain` | no | `--no-kds` | no (proxies required) | offline collateral store is the default in tests; network sources are adapters |
| browser | no (node:crypto) | no | no | yes | WebCrypto + a browser X.509 parser (section 4) |
| relay-side re-verification of dialed rows | no (`teeCpu` self-reported) | n/a | n/a | n/a | run the verifier on the RAD the row serves |
| self-check as diagnostic | n/a | n/a | n/a | n/a | keep; run both verifiers there in shadow |

Smaller findings recorded while reading: the comment in `relay/snp-verify.mjs:76-79` names
`verify/trust/ask_ark_*.pem` which does not exist on main (the chains are `test/fixtures/amd/*-cert_chain.pem`);
`metal/verify.mjs` builds its own `parseReport` beside the imported one; `parseSnpReport` accepts any length
`>= 0x330` while the ABI fixes the report at 0x4a0; the site bundle's build script must be re-run by hand
after a pin bump; `cli/package.json` floats `^1.1.7` (AGPL below 1.1.9) while `scripts/build-vendor.mjs`
pins 1.1.10.

## 4. Options

| | A. extend the existing verifier | B. own orchestration and formats, keep audited primitives | C. from scratch |
|---|---|---|---|
| what it is | grow `relay/snp-verify.mjs` + `metal/verify.mjs` + `judge.mjs` in place, add provenance, browser build | a `verifier/` package: envelope, policy, verdict, per-format binding, collateral adapters, provenance; primitives from node:crypto / WebCrypto / X.509 and Sigstore libraries; R's checked functions imported, not copied | new parsers for X.509, DER, Sigstore bundles, TUF, PKCS |
| crypto risk | low (node:crypto) but browser needs a rewrite anyway | low: reviewed libraries for everything with a spec | high: exactly what "do not invent primitives" forbids |
| dependency on Tinfoil after | library gone; proxies gone; release format stays until section 5.4 | same | same |
| covers hosted format | needs new code | yes (binding rule + SAN decode, ~60 lines) | yes |
| browser | not without restructuring (node-only APIs throughout) | designed for it: pure functions over bytes, crypto injected | yes |
| effort to first shadow run | 3-4 weeks | 2-3 weeks (prototype exists) | 8+ weeks |
| reviewability | mixed concerns (relay attach, CLI printing) | one package with one verdict type and fixtures | large surface |
| chosen | as the seed | **yes** | no |

Libraries to keep (versions verified in `node_modules` on 2026-09-24): `@freedomofpress/sigstore-browser`
0.1.14 (LICENSE file Apache-2.0, package.json says MIT) for Sigstore bundle verification in both browser and Node (it is what the site already ships);
`sigstore-js` (`sigstore`, `@sigstore/verify`, Apache-2.0) as a second, official implementation for Node
differential runs; `@noble/hashes`/`@noble/curves` (MIT, already dependencies) only if WebCrypto lacks an
algorithm; for X.509 in the browser `@peculiar/x509` (MIT) or the ASN.1 already inside `crypto-browser`.
AMD report parsing stays ours: fixed offsets from the ABI specification, cross-checked against
go-sev-guest's layout, tested on authentic v3 and v5 reports.

## 5. External roots and collateral: what remains necessary, what can be mirrored, what offline means

| root or collateral | necessary? | mirror / cache | freshness rule | offline |
|---|---|---|---|---|
| AMD ARK + ASK (Milan, Genoa, Turin) | yes, the hardware root | pinned by sha256 in code and shipped as PEM; refreshed only by a reviewed repository change; corroborated against go-sev-guest (re-done 2026-09-24, all three match) | ASK rotation shows up in the CRL (Genoa revoked serial 020001 on 2022-10-31) and as a new `cert_chain`; an unpinned root fails closed | yes |
| VCEK | yes, per chip and TCB | cache by (product, chip id, TCB) -> public key; any source is acceptable because the chain and the extension match decide; the report's own certificate table (metal, domains) needs no network at all | no expiry semantics of its own (KDS re-signs on request; two valid certificates for the same key are in the fixtures) | yes with a cache or the auxblob |
| AMD CRL | yes for ASK revocation (VCEK serials are all 00) | fetch per product, ARK-signed, ~6-week `nextUpdate` | policy `crl: required` refuses past `nextUpdate`; `crl: stale-ok <days>` verifies with a stated warning; `none` says so in the verdict | yes within `nextUpdate` |
| Sigstore trusted root | yes for provenance | shipped from TUF (`trusted_root.json` v14, hash-checked); refreshed by a TUF client on a schedule, never by fetching a bundle's own idea of a root | Fulcio leaf certificates live 10 minutes; verification anchors at Rekor `integratedTime` or an RFC 3161 timestamp carried in the bundle, so no live Rekor call | yes |
| GitHub release index (tag -> digest -> bundle) | today yes; replaceable | publish a signed release index (a Sigstore-signed JSON we produce in the release workflow, mirrored at `enclave.host` and in the repo) so a verifier needs neither `api.github.com` nor a proxy; bundles are immutable and cacheable | minimum-release policy + monotonic index defeats rollback to an older genuine release | yes with a cached index |
| Tinfoil CVM image inputs | yes while the hosted fleet runs Tinfoil's image | archive `kernel`, `initrd`, `root` hashes and the OVMF per release; recompute `snp_measurement` with `sev-snp-measure` if the image is published | n/a | n/a |
| Google attestation roots | yes for AVF | pinned (2 fingerprints), source `android.googleapis.com/attestation/root` | rotation by reviewed change | yes |
| AMD fTPM EK root | yes for VBS | pinned | same | yes |
| Intel SGX Root CA + PCS (TDX) | when TDX is supported | PCS data is signed and cacheable (`tcbinfo`, `qeidentity`, PCK CRLs) | TCB info has `nextUpdate` | yes within `nextUpdate` |
| NVIDIA device CA + RIMs (GPU) | when GPU evidence is verified | RIM bundles are signed and cacheable; NRAS is optional | RIM validity | yes with cached RIMs |

**Guarantees this buys.** With a warm cache (chains, CRLs within `nextUpdate`, trusted root, release index and
bundles), a client verifies with **zero** network calls beyond the enclave itself, and the verdict states
which collateral was stale. Nothing here replaces trust in Tinfoil with trust in our relay: the relay's
verdict is diagnostic to a client exactly like the enclave's self-check; a client that wants to trust
nothing but silicon vendors and Sigstore can, because every mirror's content is vendor-signed.

## 6. Required properties, and how the design meets each

1. **Signed quote and certificate chain against pinned roots.** Root fingerprint pinned per product line;
   ARK self-signature, ASK by ARK, VCEK by ASK (RSA-PSS SHA-384), validity windows at the verifier's
   clock, ASK serial not on the ARK-signed CRL, product line from the report's CPUID (v3+) must equal the
   chain that verified, VCEK extensions must equal the report's chip id and reported TCB.
2. **Platform and TCB policy.** Explicit floors per product for reported and committed TCB; optional firmware
   build/version floors; DEBUG and MIGRATE_MA always refused; SMT, single-socket, CXL, RAPL, ciphertext
   hiding exported as claims and required only when the policy says so; VMPL equal to the expected level.
3. **Nonce, replay and freshness.** Formats with a nonce bind it in `report_data[0:32]`; the verifier only
   ever compares against a nonce **it** chose. Formats without a nonce (hosted) get "key possession at
   attest time" and rely on the served certificate's window and the `hatt` binding; the verdict says which.
   A verifier keeps no server-side replay state because the nonce makes replay impossible by construction.
4. **Measured workload, app, runtime identity, ABI/2.** The measurement allowlist is the output of verified
   provenance, never an env var in the client path; the app id is an expected input compared to
   `report_data[32:64]`; ABI/2 bindings are computed by the contract's own `runtime.mjs` and passed in as
   bytes (identical to the branch's `expectedBinding`); a document that states ABI/1 when ABI/2 was expected
   is rejected (no silent downgrade).
5. **TLS / transport-key binding.** The SPKI comes from the verifier's own handshake, never from the
   document; hosted format: sha256(SPKI) and the `hatt` SAN; metal and domain: sha256(SPKI || nonce) or Bind2.
6. **Release provenance against an explicit policy.** Sigstore bundle verified with the pinned trusted root;
   identity policy = issuer `https://token.actions.githubusercontent.com`, repository `EnclaveHost/enclave`,
   build config `.github/workflows/tinfoil-release-publish.yml@<ref>`, ref `^refs/tags/v\d+\.\d+\.\d+(-cpu|-gpu8)?$`,
   predicate type allowlist, subject digest equal to the release digest, minimum release version. The repo
   named by the server is never used, only compared.
7. **Reject malformed, truncated, replayed, substituted, unknown, missing.** Envelope: exact lengths, strict
   base64, gzip only where the format says, size caps, closed format registry; parser: MBZ ranges that are
   reserved in every ABI version, signer type, signature algorithm; unknown format -> `unsupported`; dev
   formats -> `rejected`; missing context (no SPKI, no nonce where required) -> `rejected`. A report version
   whose fields the verifier has not implemented (version 6, ABI Rev 1.59, ETCB fields at 0x220..0x280) is
   `unsupported` by default, before any collateral or signature work; the judged range is versions 2..5.
   Structurally parsed but unjudged semantics never count as verified (independent review, 2026-09-24).
8. **Separate evidence classes.** One dispatcher: SNP (three families), TDX (`unsupported` until a QVL-grade
   implementation is chosen), AVF (delegates to `relay/avf-verify.mjs` and the pVM ABI/2 module), VBS +
   Enclave Shield (delegates; tier `vbs-dev` never reads as verified; a CPU verdict never implies GPU
   protection), GPU (`unsupported` until NVIDIA evidence is verified first-party), Hyper-V T0-hv (launcher
   signature, `hostExcluded=false` always).
9. **Key rotation, revocation, rollback, offline.** Section 5. Additionally: a rotated enclave TLS key
   invalidates the cached RAD (the supervisor already reports `observedTlsKeyFingerprint` beside the
   attested one), and the GitHub OIDC signing identity has no key to rotate: its identity is the workflow
   path, which tag and branch protection must guard.
10. **Self-check and gateway responses are diagnostics.** Unchanged: `verification.selfCheck` and any relay
    verdict are displayed, never used as the client's verdict.

## 7. What must never happen (anti-goals, checked in tests)

- A green verdict for an evidence class the verifier does not implement.
- A measurement accepted because the server said which repo or which release to compare against.
- A chain accepted because it is self-consistent (any root that is not the pin fails).
- A binding skipped because context was missing.
- A `vbs-dev` or dev-unattested document reading as attested.
- A GPU claim derived from a CPU verdict.

## 8. Proof of concept (deliverable 2)

Location: `verifier/` and `test/verifier-*.test.mjs` on this branch; fixtures `test/fixtures/verifier/` (sources,
capture times and hashes in `SOURCES.json`). Commit: 6db627e4 (fixtures 7d70de94) on `research/independent-verifier`. Not in scope: a browser bundle,
TDX, GPU, live relay wiring, any change to production code (nothing outside `verifier/`, `test/`, `docs/security/`
is touched).

| module | what it owns | primitives it reuses |
|---|---|---|
| `verifier/envelope.mjs` | the closed format registry (section 2.5), strict base64, gzip only where the format says, size caps, `unsupported` vs `rejected` | node:zlib |
| `verifier/snp.mjs` | strict 0x4a0-byte parser with the ABI's must-be-zero ranges (version-aware: MIT vectors from v4, ETCB in v6), VCEK-only signer, P-384 r/s range, chain VCEK -> ASK -> pinned ARK with subject CNs and validity windows, ARK-signed CRL (ASK serial, `nextUpdate` policy), floors on reported and committed TCB, firmware floors, guest-policy bits, VMPL, measurement allowlist, binding rule per format, one verdict | `relay/snp-verify.mjs` (`AMD_ARK_SHA256`, `decodeTcb`, `TCB_FIELDS`, `snpProductHint`, `kdsVcekUrl`, `vcekMatchesReport`, `checkMinTcb`), node:crypto |
| `verifier/der.mjs` | a bounded DER reader for the CRL and a certificate's subject Name | none |
| `verifier/tls-binding.mjs` | SPKI hashing, the shim's `hpke`/`hatt` SAN encoding, `hashAttestationDocument`, the hosted certificate rule | node:crypto X509Certificate |
| `verifier/collateral.mjs` | file, memory, HTTP (AMD KDS or any mirror) and layered adapters with the same shape; source and fetch time reported | fetch |
| `verifier/provenance.mjs` | the release identity policy (repo, workflow path, tag pattern, issuer, trigger, visibility), in-toto v1 statement shape, predicate allowlist, subject digest, minimum release | `@freedomofpress/sigstore-browser` (Fulcio chain, SCT, Rekor inclusion, DSSE) |
| `verifier/index.mjs` | dispatch by technology; the verdict shape (`status`, `admissionSafe`, `omissions`, per-check `true/false/null`); AVF delegates to `relay/avf-verify.mjs` and requires the attested key's signature; the pVM ABI/2 module is imported when present; TDX, VBS, Hyper-V, GPU are `unsupported` with the pointer to their verifier | |
| `verifier/cli.mjs` | `verify`, `release`, `capture` (RAD + certificate + VCEK/chain/CRL from AMD), `differential` (runs Tinfoil's library on the same bytes) | |

What each suite proves (all offline, all on authentic bytes unless the case is a mutation of them):

| suite | passing means |
|---|---|
| `verifier-envelope` (6) | unknown formats are `unsupported`, development and T0 formats `rejected`, TDX/VBS/Hyper-V/GPU never green, malformed or oversized bodies refused before any cryptography |
| `verifier-fail-closed` (10) | the status is derived from the omission list (any omission -> `limited`); report version 6 is `unsupported` before any collateral work and, under the research policy, `limited` at best even when signature, chain, CRL and binding all pass (shown on a synthetic version-6 report); the authentic v3 and v5 paths still verify with nothing omitted; each policy relaxation (no TCB floor, `crl: none`, no certificate binding) is an omission that caps the verdict; on a synthetic AMD-shaped chain (own ARK/ASK/VCEK/CRL, pinned by the test and refused by the real pin) the metal format verifies with a nonce, is `limited` without one, refuses a replay, and the domain ABI/1 branch binds the nonce and app id |
| `verifier-snp-genoa` (17) | the hosted Genoa document verifies to AMD's pinned root with the served certificate binding and a TCB floor (without the floor the verdict is `limited`, not `verified`); a KDS re-issue of the same VCEK verifies identically (collateral source is irrelevant); with a floor the reported and committed TCB are judged; each of signature (r, s, signed region, out-of-range r), root (Milan or Turin chain under the Genoa name, no pin), VCEK (other chip, none), TCB edit, measurement (other, none), transport key (other, none), report_data, DEBUG, MIGRATE_MA, VMPL, SMT policy, product policy, shape (truncated, padded, zero, version 1, VLEK signer, reserved bytes, signature tail), CRL (stale under each mode, missing, foreign issuer, tampered), revocation (an ASK with the Genoa CRL's revoked serial), certificate windows, and the served certificate (wrong key, substituted document, wrong host, missing) is refused on its own |
| `verifier-snp-turin` (7) | the M4a v5 document verifies with the Turin TCB layout, ABI/2 binding and app id; another runtime identity, nonce, key or app changes the binding; ABI/2 to ABI/1 downgrade in either direction is refused; FMC floors are judged; Genoa's chain or VCEK do not verify it; a fresh nonce refuses the replayed report; any flipped byte refuses |
| `verifier-provenance` (10) | both release bundles verify against our identity with the TUF-sourced root; repo (including case), workflow path, ref pattern, issuer, trigger, visibility, subject digest, predicate type and the release floor each refuse independently; payload, signature, certificate swap, missing log entry, legacy chain form, wrong media type, two signatures, and a root without Sigstore's CA or logs each refuse |
| `verifier-tls-binding` (3) | the real shim certificate's SANs decode to sha256(format + body); chunk order, duplicates and non-base32 are refused |
| `verifier-differential` (3) | Tinfoil's library accepts the same authentic Genoa bytes with the same measurement and refuses the same single-byte mutations; it refuses the Turin report outright where ours verifies it (stated, not hidden) |
| `verifier-abi2-contract`, `verifier-pvm-abi2` | skip on main; on the feature branches they check the ABI/2 test vector against `isolation/contract/runtime.mjs` and judge the real Pixel captures through `relay/pvm-app-attest.mjs` |

Review correction (2026-09-24): the first cut let a version-6 report reach `verified` with a note, and let
policy relaxations reach `verified` with warnings. Both are closed: `verified` is now derived from an empty
omission list, every relaxation is an omission, and an unjudged report version is `unsupported` by default
(`limited` at most under an explicit research flag). The CLI exits 0 only for `verified`, 4 for `limited`.

### 8.1 Consumer admission gate and the pVM evidence adapter (bounded consumer integration, 2026-09-24)

`verifier/admission.mjs` is the one function that may release a client request. It releases only when the
verdict is `verified`, `admissionSafe`, has an empty omission list and every check `true`; when every
expectation was supplied by the client and matches the claims (SNP: allowed measurements from provenance, a
TCB floor, the root pin for the product the chain proved, the app id for a domain document; AVF/pVM: runtime
ids, APK code and authority hashes, root pins, app id); when freshness is the client's own single-use
32-byte challenge (or, for the hosted format only, the served certificate window); and when the transport
is bound in a way the client can check: a **native** client compares the peer key its own TLS handshake saw
with the key the evidence bound, a **browser** client releases only on an application-layer public key
bound in the evidence and never claims TLS certificate pinning, because browser code cannot read the peer
certificate. A nonce registry consumes the challenge before the verdict is read, so a replayed exchange
holds whatever its verdict. Everything else holds and names its reason.

`verifier/pvm-evidence.mjs` is the client side of the pVM owner's proposed interface (section 2.6). It
imports the owner's `verifyPvmAppEvidence` when present and never parses the evidence itself: it only
cross-checks the echoed nonce and app id against the client's own values (a hostile relay rewriting the
echo is caught before any certificate work), refuses empty pin lists, calls the owner's verifier with the
CALLER's nonce, app id and pins, and maps the result to the harness verdict with `freshness: "client-nonce"`
and the transport key to pin. Absent the module the verdict is `unsupported`, and the gate holds it.

| suite | passing means |
|---|---|
| `verifier-admission` (7) | on the authentic Genoa verdict a native client releases only when its own peer key is the bound key, a browser client releases on the HPKE key with TLS pinning explicitly not claimed; a `limited` verdict (no floor, no CRL) never releases; missing or mismatched client expectations (measurements, floor, root pins, wrong product pin) hold; on the authentic Turin ABI/2 verdict the nonce, app id and peer key are each required; the same nonce holds the second time; every non-verified or inconsistent verdict shape holds |
| `verifier-pvm-evidence` (9) | with an injected stand-in for the owner's verifier (modelling only that the certificate challenge covers nonce, app, transport key and identity): an honest exchange verifies and releases for a native client; a browser client holds until an application-layer key is present; a hostile relay rewriting the echoed nonce or app is caught by the consumer cross-check, and substituting the chain, transport key or identity, or pasting our echo onto another session's evidence, is caught by the challenge; stale evidence under a fresh challenge and a reused challenge hold; each empty pin list and a missing challenge or app id refuse; malformed envelopes refuse; without the owner's module the verdict is `unsupported` and holds. The last case runs against the owner's module once it is pushed |

Exact remaining integration gaps (nothing below is verified today):
1. `verifyPvmAppEvidence` is not pushed (pVM branch head 816f88f1 exports only `verifyPvmAppAbi2`); the
   adapter's contract test skips, and the substitution and replay detections that live in the owner's
   verifier are exercised only through the stand-in until then.
2. No authentic evidence fixture in the `enclave-pvm-app-evidence/v1` format exists; the real captures on
   the pVM branch carry the owner's nonce and no transport SPKI, so a real-envelope fixture waits for the
   owner's push.
3. The browser path: the owner's v2 (proposed 2026-09-24, not pushed) adds `appKey` (32-byte X25519) and
   `appKeySig` (Ed25519 under the attested transport key over the nonce, app id and key), with HPKE base
   mode (X25519, HKDF-SHA256, AES-128-GCM) requests in RFC 9458 shape to a sealed VM port. The adapter
   already accepts the v2 shape (closed: a stripped or grafted key is malformed, never a downgrade) and the
   gate releases a browser client only on a key the owner's verifier vouched for. Until v2 is pushed and a
   real v2 fixture exists, every browser request on pVM evidence holds.
4. The relay stream kind `pvm-evidence` and the `EVIDENCE <nonce>` request line are not wired anywhere on
   this branch; the adapter judges a JSON object it is handed.
5. The gate's expectations come from the caller; the catalog-to-expectation step (which app id, which
   runtime ids, which code hashes a client should expect for a deployment) is not built.
6. A native client's `observedPeerSpki` must come from its own TLS handshake; only Node clients can do that
   today, and no CLI command performs a live exchange.

Findings the harness produced: AMD KDS re-signs a VCEK on request (two valid certificates for one key, one month
apart, in the fixtures), so caching must key on the public key; Genoa's CRL revokes the pre-2022 ASK (serial
020001) and the current ASK is 020002, so the CRL check is live rather than decorative; report version 5 carries
MIT vectors at 0x1f8 that a "reserved must be zero" parser written against version 3 would refuse; Tinfoil's
library hardcodes its own TCB and firmware floors and refuses every non-Genoa part (a Turin report is rejected as
"TCB version field is malformed" by its Milan/Genoa layout check, before any product logic runs).

## 9. Rollout: dual verification, shadow, rollback

No automatic cutover. Each stage is a reviewed change with a configuration flag to fall back.

1. **Shadow in CI** (this branch): the harness runs on every push against the fixtures and, in a scheduled
   job, against live public evidence (a Tinfoil public host for the hosted format, the fleet when attached);
   the job also runs `@tinfoilsh/verifier` and fails on divergence.
2. **Shadow in the enclave self-check**: `runSelfCheck` runs both verifiers and publishes both results under
   `verification.selfCheck.{tinfoil,enclave}`; still a diagnostic; divergence is logged. Flag:
   `SELF_CHECK_VERIFIERS=tinfoil|enclave|both`.
3. **Shadow in the CLI**: `enclave attest --verifier both` prints both verdicts; the exit code follows the
   Tinfoil verdict until stage 5. Flag on the command line only.
4. **Shadow in the browser**: `site/js/core/verify.js` runs the new bundle beside `verifier.js` and renders
   the new verdict as a secondary line; the green state still comes from the Tinfoil result. Same-origin
   bundle built by `build-vendor.mjs` from this repository's code, so no CDN and no new host.
5. **Consumer gate**: clients (CLI, Node consumers, later the browser bundle) release requests only through
   `verifier/admission.mjs`; pVM evidence enters through the owner's `verifyPvmAppEvidence` behind the
   adapter; the gaps in section 8.1 close first.
6. **Relay**: dialed rows are re-verified with the new verifier (today `teeCpu` is self-reported);
   permissionless attach keeps `relay/snp-verify.mjs` until the new module has replaced it behind the same
   tests, then `expectedBinding` and the pVM ABI/2 frame land with the isolation and pVM owners.
7. **Cutover decision**: after an independent review of `verifier/` and at least four weeks of zero
   unexplained divergence, the primary is switched per consumer (CLI, then self-check, then browser) with
   the Tinfoil path kept as the fallback flag for one release cycle. Rollback = flip the flag and rebuild
   the vendor bundle; the Tinfoil package stays pinned until the fallback is removed.

## 10. Effort and milestones (engineering days, one engineer, excluding review)

| milestone | content | days |
|---|---|---|
| M0 (done on this branch) | map, fixtures, harness for SNP + provenance + hosted binding, differential run, CLI | done |
| M1 | strict envelope for every format in the registry, CRL policy modes, collateral adapters with a disk cache, Rekor v2 bundles, scheduled live differential job | 5 |
| M2 | browser build: WebCrypto signatures, X.509 via a reviewed library, same-origin bundle, site shadow line | 8 |
| M3 | CLI `--verifier both`, self-check both, relay re-verification of dialed rows | 5 |
| M4 | signed release index in the release workflow, mirror at `enclave.host`, TUF refresh job, minimum-release policy | 5 |
| M5 | independent review, cutover per consumer with fallback flags | 3 + review |
| later | TDX (QVL-grade), NVIDIA GPU evidence, measurement recompute from archived image inputs, AVF ABI/2 relay frame | separate plans |

## 11. Open risks

- **Measurement semantics** stay Tinfoil-defined for the hosted fleet (section 2.3). Without archived image
  inputs a "verified" hosted enclave means "runs the image Tinfoil measured for our config".
- **Hosted binding format** is the shim's certificate format; if Tinfoil changes the SAN encoding the hosted
  rule breaks loudly (rejected, not green).
- **Sigstore root and Fulcio identity** depend on GitHub's OIDC and Sigstore's public-good instance;
  workflow-path identity is only as strong as tag/branch protection on the repository.
- **KDS rate limiting** (429 after a few requests) makes a cache or the auxblob mandatory for anything
  interactive.
- **Browser X.509** needs a reviewed parser; Node's `X509Certificate` does not exist there.
- **Clock**: certificate windows and CRL `nextUpdate` need a trustworthy clock in the browser; a wrong clock
  can only reject, never accept, if `notBefore` and `nextUpdate` are both enforced.
- **TDX and GPU** are `unsupported` in the verifier; the site must not imply otherwise.
- **Relay dialed rows** trust self-reported `teeCpu` until stage 5.
- **pVM ABI/2** relay frame undecided; the payload printed a 72-byte zero-padded ECDSA signature once (pVM
  owner, 2026-09-24): the verifier must require canonical DER and refuse padding.
- **Isolation IGVM path**: `runtime.json` inside the guest image is outside the launch measurement there
  (`isolation/m3/PLAN.md` section 16), so the runtime identity is "the domain's word" until the SVSM carries
  it (M4b).
- **Supply chain of the verifier itself**: pinned versions, `THIRD-PARTY-NOTICES.md` regenerated, the same
  same-origin rule as today.

## 12. Specification and implementation references

The companion file `independent-verifier-references.md` holds the authoritative specifications (AMD 56860 Rev 1.59
and 57230 Rev 1.05, Intel DCAP API Rev 0.91 and PCS v4, NVIDIA nvtrust and NVAT, Android AVF remote attestation,
Sigstore bundle and Fulcio OIDs, TUF root v15), the current reference verifiers with versions and licenses, and the
licensing table. Three points from it shape this plan: go-sev-guest v0.15.0 parses report versions 2..5 while ABI
Rev 1.59 introduces version 6 (our parser accepts 6 structurally and says its new fields are unjudged); the Turin
fmcSPL query and 8-byte hardware id are confirmed in practice by KDS answering the URL `relay/snp-verify.mjs` builds;
and `tinfoilsh/measure-image-action` is AGPL-3.0, which is fine in CI and must never be bundled.

## 13. Licensing

`@tinfoilsh/verifier` 1.1.10 Apache-2.0 (1.1.8 and below AGPL, never use); `@freedomofpress/sigstore-browser`
0.1.14 Apache-2.0 by its LICENSE file (package.json says MIT; ship the Apache notice); `@freedomofpress/crypto-browser` 0.1.7 Apache-2.0; `@freedomofpress/tuf-browser` 0.1.11 MIT;
`@noble/*` MIT. Apache-2.0 requires the NOTICE and license text to ship with the bundle (`build-notices.mjs`
already does this); MIT requires the copyright notice. No copyleft obligation is introduced by option B.

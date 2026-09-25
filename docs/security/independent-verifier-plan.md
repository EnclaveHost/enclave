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
  caller's nonce, app id and pins, never the envelope's. The harness imports it (`verifier/pvm-evidence.mjs`)
  and registers the format as a delegated AVF class. Changes requested and adopted by the owner
  (2026-09-24, before the push): a closed envelope shape with exact lengths, the client nonce inside any
  delegated-key signature, an application-layer key for the browser path because browser JavaScript cannot
  read the peer TLS certificate, and a pure result that is `ok` only when every pin list is non-empty.
- Agreed v2 and sealed-request contract (owner, 2026-09-24, not yet pushed): v2 makes `appKey` (32-byte
  X25519) and `appKeySig` (Ed25519 under the attested transport key over `"enclave-pvm-app-key-v1\n" ||
  nonce || appId || appKey`) mandatory; a VM without a browser key answers v1, where both are forbidden.
  Requests use HPKE base mode X25519 / HKDF-SHA256 / AES-128-GCM with
  `info = "enclave-pvm-sealed-http/v1 request" || 0x00 || hdr(key_id 0, 0x0020, 0x0001, 0x0001) || AppID || RuntimeID`,
  AAD = the 32-byte evidence nonce (also in the clear at the frame head: nonce || hdr || enc || ct); the VM
  accepts a sealed request only under a nonce it answered this boot with this appKey, for 600 s and at most
  256 requests, refusing replay per (nonce, enc) and the nonce outright after the window; the response is
  RFC 9458-shaped (`Export("enclave-pvm-sealed-http/v1 response", 16)`, 16-byte response nonce, salt =
  enc || response_nonce). `appKey` lives for one boot; rotation appears as an unauthenticated refusal and the
  client then fetches fresh evidence under a new nonce and re-encapsulates, never re-sending a ciphertext.
  The WebCrypto port applies the same closed-shape rules and refuses, without fallback, where Ed25519 or
  X25519 is missing. Gate consequence: a pinned `appKey` is good for one evidence window; the client
  re-runs the gate on every refusal and never retries a sealed request.

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
algorithm; for X.509 in the browser: DECIDED 2026-09-24 (`browser-x509-parser-decision.md`): `@freedomofpress/sigstore-browser`'s
`X509Certificate` for structured access, `verifier/der.mjs` for the compared and signed bytes, WebCrypto for every signature,
with AMD's PSS profile checked from the certificate's own AlgorithmIdentifier bytes; `@peculiar/x509` and `pkijs` measured and declined.
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
which collateral was stale.

**Built (2026-09-24, M1 slice): `verifier/collateral-cache.mjs`**, an authenticated, freshness-aware disk cache in
front of any adapter (`cachedCollateral({ dir, upstream, now, roots })`; CLI `--cache-dir`). Every entry is
authenticated against the pinned AMD roots before it is served (the chain through `parseAmdChain`; the VCEK by subject,
issuer, validity, the ASK's signature and, since Codex's review of the first cut found it missing, its AMD extensions
naming exactly the chip id and TCB the slot is keyed by, through the verifier's own `vcekMatchesReport`, so an authentic
certificate for another chip or TCB can never occupy a slot and shadow a healthy upstream (finding F4, an availability
poisoning of this cache, not an attestation bypass, closed in the same change with Codex's reproduction and the
wrong-chip, wrong-TCB and recovery regressions); the CRL through `checkCrlAuthentic`; the two authenticators extracted
from the SNP verifier without changing its behaviour); an entry that fails is quarantined, never served, and the next source is tried; only
authenticated bytes are written, atomically with a sha256 sidecar; a poisoned or garbage upstream answer is refused
and not cached; a CRL past `nextUpdate` is refreshed from the upstream first and served stale only when no upstream
answers, flagged so the CRL policy decides (`required` rejects, `stale-ok` is limited within its bound); an authentic
CRL that revokes the ASK is served as is, never quarantined or replaced, so a warm cache cannot hide a revocation; a
warm cache answers with no network; a write failure is reported, never fatal and never a false hit. The verdict now
carries `claims.collateral` (source, fetchedAt, cached, stale per piece). `test/verifier-collateral-cache.test.mjs`
covers each of these on the real Genoa fixtures and on the synthetic chain (stale, fresh and revoking CRLs under one
ARK).

**Built (2026-09-24, M1 slice): the per-format document shape in the registry** (`verifier/envelope.mjs`, `SHAPES`):
each registered format names its body field exactly (no `body`/`report` alias), whether its top level is closed, and
the fields the verifier reads with their kinds and caps, taken from the producers as they are (the metal guest agent,
the isolation front, the relay's AVF and VBS handling, the Hyper-V judge). The hosted document is closed to exactly
`{ format, body }`, since the served certificate binds `sha256(format + body)` and nothing else; the metal and domain
documents stay open because they carry unsigned informational fields that evolve, but are bounded and every declared
field is validated when present; AVF v2 requires the pad key its transcript binds. `parseEnvelope` enforces this before
any cryptography and the verdict for a malformed shape is rejected. Nothing here replaces trust in Tinfoil with trust in our relay: the relay's
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
| `verifier-pvm-device` (11, skips without the owner's module) | on the two real Pixel 10 envelopes with client-held pins: both boots verify and release a native client on that boot's key only; a browser client holds on v1; replay of launch 1 against launch 2, a pasted nonce, a swapped key, a foreign chain, a fresh nonce over a genuine chain, wrong app/runtime/code hash/authority/root pins, empty pins, an expired or not-yet-valid leaf, stripped/extra fields, non-canonical base64 and another format each refuse |
| `verifier-sealed-stream` (12; the differential case runs under the strict command) | on the owner's sealed-stream fixture: the stream opens complete to the known plaintext however it is split, the ABORT variant is an authentic prefix; sequencing, replay, truncation, tamper, framing, trailing and cancellation attacks are refused with nothing released beyond the last authenticated chunk; the policy layer reads nothing unless the gate released a browser client with the pinned app key inside the window; the owner's reader agrees on accept/refuse and prefix for every case |
| `verifier-envelope` (11) | the registry refuses what it does not know or cannot judge (unknown, development, T0, TDX, VBS and Hyper-V formats never verified), malformed envelopes before any cryptography, and, since 2026-09-24, the per-format SHAPE: the body field's exact name with no alias (the domain and Hyper-V documents say `report`, the shim and the metal agent say `body`); the hosted document closed to exactly `{ format, body }` because the served certificate binds nothing else; the metal, domain and AVF documents open but bounded (at most 32 top-level fields and 1 MB) with every field the verifier reads declared and validated when present (transport keys strict base64 with caps, fingerprints, nonces and pad keys 64 lowercase hex, `abi` one of the two known values, `runtime` and `manifest` objects, strings capped), AVF v2 requiring its pad key; a malformed shape is rejected, never unsupported and never verified; the real Genoa, Turin and agent-shaped documents parse |
| `verifier-pvm-policy-deployments` (4; the differential runs under the strict command) | the optional deployment table on 24 lab-signed vectors (absent; one, three and 64 entries; the table in another position; empty; 65; non-array; non-object entries; extra or missing keys; uppercase, unprefixed, short and long ids; an unadmitted or non-hex app; duplicate ids) accepted or refusing the whole policy as the contract says; selection by id, by id plus app, unknown, tableless (also with an app given), non-canonical, mismatched, empty and app-only; a lower serial remapping a deployment is a rollback, the same serial with another table equivocation, a stranger's table and a bare catalog object refused; the owner's pinned `trust.js` agrees on every vector and selection |
| `verifier-collateral-cache` (9) | the authenticated collateral cache: cold, warm and offline with the verdict naming each piece's source; a poisoned cached chain or VCEK and a tampered or sidecar-less CRL quarantined and refetched, and fail-closed when the upstream is down; a poisoned or garbage upstream answer refused and not cached; KDS 429 through the real http adapter (cold fails closed, warm never asks); an unwritable cache reported and never a false hit, a leftover temp file ignored; a stale cached CRL refreshed from the upstream; a stale CRL with no upstream served flagged so only the policy can accept it (required rejects, stale-ok limited within its bound, beyond it rejects); an authentic revoking CRL served and never hidden |
| `verifier-pvm-client-persistence` (8, black-box, own runner) | against the BUILT client with a fake carrier and a held evidence request as the barrier: an accepted serial is committed before the client acts and survives a kill, a rollback is then refused without a request; concurrent old/new serials in both orders never lose the newer one; equal serial with other bytes is refused (same bytes idempotent); a read-only store means nothing is sent; a corrupt state is fatal; an attacker policy plus a stall leaves no trace. Failed 7 of 8 on 0.1.0 (the reproduction); passes 11 of 11 on 0.2.0 |
| `verifier-pvm-client-ext` (5, real Chromium, strict command) | the SHIPPED 0.2.0 extension zip (pinned and reproduced), unzipped and loaded unpacked in Chrome for Testing 151 over the DevTools protocol, with the lab relay holding `/evidence` as the barrier: a stall then SIGKILL of the whole browser leaves the committed serial for the relaunch, which refuses a rollback without a request; the same with only the tab closed; two tabs holding old and new serials in both orders never lose the newer one; equal serial with other bytes is refused as equivocation and the same bytes again are acted on; the commit event precedes the evidence request; every outcome carries Chrome 151's user agent under the computed unpacked-extension id. The 0.1.0 zip runs the first case as the preserved old-client failure (old serial remains, the rollback is acted on). Negative control: the four 0.2.0 cases run against the 0.1.0 zip fail on `1 !== 2`, `1 !== 3`, `the old tab must be refused, not act` and `equivocation must be refused without acting on it`. Proves persistence across browser process death and tab close on this machine; whole-machine power loss is not proven by anything here |
| `verifier-pvm-client-supersede` (4, pinned 0.2.0 SOURCE, strict command) | the superseded-policy refusal at request release needs evidence that verifies, so the owner's `cli.mjs` runs from the pinned sources with ONE import replaced through a Node loader hook (`verifyPvmAppEvidence` as imported by `web/pvm-client.js`; the store, flow, gate and sealing are the owner's code): client A commits serial 5 and waits on evidence, client B commits 6, A's evidence is released and verifies, A refuses at the gate (`serial 5 was superseded by serial 6`) and sends no sealed request; the same under a key rotation; a control reaches the sealed request; the stub refuses an envelope for another nonce. A source-level result, not one against the built artifact |
| `verifier-pvm-client-update` (10, built CLI, strict command) | update manifests signed by the lab release key and countersigned by the lab policy key, artifact downloads held as barriers: a valid update stages its exact bytes and the state records it, tampered staged bytes are reported; a wrong countersignature, a stranger's release key and a non-newer version are refused with nothing on disk; two stagers of different versions in both completion orders (the older never replaces the newer); a policy-key rotation by signed `nextPolicyKey` after which the retired key's policies and a rollback under it are refused; a release-key rotation and a policy commit in both orders, neither losing the other's fields, then the successor signs and the retired key and a stranger do not; a storm of six concurrent updates and six policy commits ends at the highest version and serial with every loser refused by the monotonic rule and one generation per commit. Finding F2 (`verifier/integration/findings.json`, closed): the sequential and concurrent same-version re-stage cases require that a refused stager leaves the staged bytes untouched and that the state's digest and the file on disk never disagree; they failed on 6784f671 (strict verdict NOT ACCEPTED, exit 3) and pass on the owner's 0.2.1 fix e7a2badc, now the pin; the same artifact again is idempotent there (no generation, file untouched) and other bytes under another source commit are refused; the pre-fix build stays pinned as `pvm-client-dist-f2` with a regression fixture that requires the defect to reproduce there |
| `verifier-pvm-policy` (7) | on the seven real signed lab policies of the installed-client device run, from the run's anchor and rollback memory: genuine policies accepted in order, the attacker's refused (and genuine only under the attacker's own anchor), rollback, equivocation and the install floor refused, root narrowing that excludes the device's root accepted as a policy, the kill switch disables the old client, a non-admitting policy yields no expectations, a genuine policy's expectations are what the gate takes, and every forgery of bytes, signature, shape or window refuses; each outcome equals the device's |
| `verifier-admission-vectors` (3) | `verifier/admission-vectors.json` is the gate's rule as data: 40 deterministic cases (hosted, domain ABI/2, pVM v1 and v2 verdicts; native and browser clients; every expectation, omission, verdict-shape and nonce-reuse hold) replay through the gate with the same decision and reason, the file has not drifted from the generator, and exactly six cases release; another implementation of the client's release decision is held to this file |
| `verifier-sealed-traces` (4; the differential case runs under the strict command) | on the thirteen Pixel 10 device traces: every genuine stream opens complete under the page's context, every relay mutation fails with the page's class after the same number of chunks and releases only an authentic prefix, both replays are refused, and the owner's reader agrees on class and prefix for all 26 streams |
| `verifier-pvm-evidence` (10; the stand-in returns the owner's v2 result shape) | with an injected stand-in for the owner's verifier (modelling only that the certificate challenge covers nonce, app, transport key and identity): an honest exchange verifies and releases for a native client; a browser client holds until an application-layer key is present; a hostile relay rewriting the echoed nonce or app is caught by the consumer cross-check, and substituting the chain, transport key or identity, or pasting our echo onto another session's evidence, is caught by the challenge; stale evidence under a fresh challenge and a reused challenge hold; each empty pin list and a missing challenge or app id refuse; malformed envelopes refuse; without the owner's module the verdict is `unsupported` and holds. The last case runs against the owner's module once it is pushed |

Contract and device results (2026-09-24, against the owner's pushed revision 31f0fe2c of
`relay/pvm-app-attest.mjs`, staged untracked into the research worktree for the run, never committed here):
the contract test passed (empty pins and unknown fields refused, the echoed nonce never used as the
challenge); the adapter's field assumptions matched the owner's result shape without change; and the new
`verifier-pvm-device` suite (7 cases) verified the two REAL Pixel 10 envelopes (`test/fixtures/verifier/
pvm-evidence/`, boots l1 and l2) with client-held pins (app id, APK code hash, APK signing authority, the
known identity's RuntimeID, Google's roots), released a native client only on that boot's transport key,
held a browser client (v1 has no application-layer key), and refused, from the real envelopes: launch 1's
evidence against launch 2's nonce, our nonce pasted onto old evidence, the other boot's key or chain under
this boot's echo, a fresh nonce over a genuine chain, a wrong app, runtime, code hash, authority or root
pin, each empty pin list, a clock a month later or before issuance (the RKP leaf is short-lived), a
stripped or extra field, a non-canonical chain entry and another format string. These cases skip where the
owner's module is absent (main, and a clean checkout of this branch) and run wherever both trees meet.

Reproducible cross-branch acceptance (2026-09-24): `verifier/integration/pins.json` pins the owner's modules
by branch, FULL commit and the sha256 of each blob they need (`pvm-app-attest` at
`afd437a25305ba32f83d0384eb30240a31cd4391`, `pvm-sealed` at `fbd87038ba93ea1f52ec52f27a49c661d55598f0`);
`verifier/integration/resolve.mjs` reads those blobs from that commit's tree with `git cat-file`, hash-checks
them and the worktree copy of `relay/avf-verify.mjs` the adapter also uses, and materialises them under the
gitignored `.verifier-integration/` with a manifest, exiting 2 on any mismatch; `npm run test:integration`
(`verifier/integration/run.mjs`) resolves, then runs the acceptance suites with `ENCLAVE_PVM_MODULE` set and
`ENCLAVE_STRICT_INTEGRATION=1`, under which a missing or wrong module FAILS the suites and any skipped case
fails the run. Result against the pin: 30 tests, 30 pass, 0 skipped. `test/verifier-integration.test.mjs`
spawns the real scripts and proves a wrong commit, a tampered blob hash and a worktree mismatch each exit 2
leaving no usable entry, a missing or export-less module fails strict mode, an unknown pin refuses to run,
the non-strict default skips with a stated reason, and the strict command passes end to end. No copy of the
owner's module is tracked on this branch.

Exact remaining integration gaps (nothing below is verified today):
1. The owner's module lives on `pvm-cpu/portable-runtime`; plain `npm test` on this branch alone skips the
   acceptance cases (stated), and `npm run test:integration` is the command that must pass.
2. The real envelopes carry the client's nonce of that exchange, so the device suite proves "binding
   verified for that exchange"; a live exchange with a nonce chosen at test time is the owner's device run
   (22/22 in their `check.txt`), not reproducible offline.
3. The browser path, v2: pushed by the owner at afd437a2 (`verifyPvmAppEvidence` accepts v1 and v2; the
   result adds `appKey`, returned only after its signature verifies, and the sealed-channel constants
   600 s / 256 requests; a WebCrypto copy lives at `shielded/anchor/avf/web/pvm-verify.js`, chain leaf-first,
   same closed-shape rules; the owner's parity test runs this branch's adversarial cases in both). Against
   that revision the device suite verifies the REAL v2 envelope (`pvm-evidence/l1-v2-evidence.json`, build
   rt13, clock 2026-09-24T07:26:36Z): a browser client releases on the signed app key with the sealed
   window pinned and TLS pinning explicitly not claimed, a native client on the transport key; refused:
   the relay's own key under the VM's signature, a half-stripped or grafted key, v2 fields under a v1 label,
   yesterday's key binding under another nonce, a foreign chain or key, an expired leaf, the v1 build's code
   hash, an extra field. The known downgrade (both fields stripped, format relabelled v1) VERIFIES as v1 with
   a null app key: a browser client holds on it, a native client may still pin the transport key, and a
   client that requires v2 passes `formats: [v2]` so the adapter refuses it as a downgrade. The owner's
   device run: 35/35 (Chromium 152, Firefox 155; replay, swapped app key, downgrade and a forged CA refused
   before sending; tampered, replayed and cross-boot sealed requests refused by the VM). Still not built on
   this branch: the HPKE client itself (encapsulation, the frame, re-fetch on refusal).
4. The relay stream kind `pvm-evidence` and the `EVIDENCE <nonce>` request line are not wired anywhere on
   this branch; the adapter judges a JSON object it is handed.
5. The gate's expectations come from the caller; the catalog-to-expectation step (which app id, which
   runtime ids, which code hashes a client should expect for a deployment) was not built. CLOSED for the pVM client
   (2026-09-24, contract agreed with the owner before coding, their 0.4.0 at 28a6efbf pinned and reproduced): the
   signed policy may carry an optional `deployments` table, 1 to 64 entries of exactly `{ id, app }`, the id the
   ledger's bytes32 in canonical form and never normalised, the app one the policy admits, no id twice, any fault
   refusing the whole policy; selection is by id after the commit and before any evidence request, the expected app
   comes from the signed table and never from a catalog or a relay, nothing is implied by default, `--app` alone keeps
   its meaning only when no deployment is named, and the delegated child selects for itself. This branch's verifier
   (`verifier/pvm-policy.mjs`: the table, `selectDeployment`, `expectationsForSelection`) agrees with the owner's
   pinned source on every vector and selection (`verifier-pvm-policy-deployments`, in the strict command). Limit,
   stated: the evidence names app, runtime and code, not a deployment, so a hostile relay can route a deployment's
   traffic to another genuine instance of the same app; the client proves "a genuine instance of the app the signed
   policy expects for this deployment", not that deployment's physical instance or operator; the id never routes; the
   extension validates the table through the same trust code but ignores selection.
6. A native client's `observedPeerSpki` must come from its own TLS handshake; only Node clients can do that
   today, and no CLI command performs a live exchange.
7. Encrypted incremental response streaming on the sealed channel: the protocol text and offline fixture
   exist (owner's 36f040d1), the consumer reader is built on this branch (`verifier/sealed-stream.mjs`) with its
   sequencing, replay, truncation, tamper, cancellation and policy cases (12), and the owner's reference reader,
   pinned as `pvm-sealed`, agrees on every case (`docs/security/pvm-sealed-streaming-review.md`, Results).
   The device traces (owner's fbd87038, thirteen exchanges with a malicious relay) are fixtures on this branch
   and open or refuse exactly as the page reported, with the owner's reader agreeing on every one (strict
   integration 46/46, zero skips). Still open: the HPKE request side (encapsulation, the frame) is not on this
   branch; the browser page's code delivery is addressed in the lab by an installed client with a signed policy
   and a reproducible artifact (`docs/security/pvm-client-bootstrap-review.md`: the owner built it at 4e55879b
   with all nine requested changes, this session reproduced both artifacts byte for byte, the reproduction is
   part of the strict command, and the owner's device run of that client passed 30/30 with the seven real signed
   lab policies verified independently on this branch to the same outcomes); production keys, provenance and store
   delivery remain unclaimed.
8. Client 0.1.0 has a persistence gap (policy acceptance persisted only after the exchange; no cross-process
   serialisation; a fixed temp name): reproduced here black-box against the built client with deterministic
   barriers (`npm run test:client-persistence`, 7 of 8 cases fail by design; `docs/security/pvm-client-bootstrap-review.md`,
   "Persistence gap"). The owner's 0.2.0 fix (a durable monotonic commit before any request, link-based
   compare-and-swap, Web Locks in the extension, nothing sent on a failed commit) landed as 0.2.0 (6784f671): both
   client pins bumped, the artifact reproduced, and the same suite passes unchanged (11 cases, three added: three
   concurrent writers, a planted truncated newest generation, a stale 0.1.0 file after import); now part of the
   strict command. Closed for the CLI as far as black-box cases reach. Follow-up the same day (owner's commit unchanged): the
   shipped extension zip ran in real Chrome for Testing 151 (`verifier-pvm-client-ext`: stall then SIGKILL of the
   browser, tab close, two tabs in both orders, equivocation; the 0.1.0 zip kept as the failing control, and the
   0.2.0 cases shown to fail against it), the superseded-policy refusal at request release was checked against the
   pinned 0.2.0 SOURCE with only the evidence verifier replaced through a loader hook (`verifier-pvm-client-supersede`,
   a source-level result, not the built artifact), and update staging and key rotation were exercised black-box
   against the built CLI (`verifier-pvm-client-update`, including a storm of concurrent commits). All three are part
   of the strict command. Scope, stated plainly: what is proven is persistence across browser process death and tab
   close, and across CLI process death, on this machine; whole-machine power loss is NOT proven by anything here (no
   test cuts power, and a `chrome.storage.local` write reaching the browser process says nothing about the disk).
   Two findings raised with the pVM owner (receipt acknowledged the same day): a refused stager's verified file stayed
   beside the client under its own version name, and a second manifest for the SAME version with other bytes was
   refused yet replaced the staged file first (`staged` then reported `bytesMatch: false`). The latter is finding F2
   in `verifier/integration/findings.json`: its cases are required with no exemption, so while the pin was 6784f671
   the strict command's verdict was NOT ACCEPTED (exit 3, distinct from FAILED and from a dependency refusal). The
   owner fixed both in 0.2.1 (e7a2badc: content-addressed immutable publish that never replaces a file, the decision
   inside the commit, a sequentially refused stager publishes nothing); the pin moved there, the artifact reproduced
   byte for byte, the cases pass (strict 76 of 76) and the entry is closed; 6784f671 remains pinned as
   `pvm-client-dist-f2` with a regression fixture requiring the defect to reproduce there. Losers of a concurrent
   same-version race that published before the winner committed leave immutable content-addressed files no state
   names; the owner keeps them deliberately (a shared install directory, no safe deletion without a lock), recorded as
   an observation, not a failure.
9. Activation of a staged update (the launcher gap): nothing on 0.2.1 runs what `update` staged, and a launcher that
   checked by path and then ran `node <path>` would read the file twice. Independent design review in
   `docs/security/pvm-client-activation-review.md` (2026-09-24): twelve requirements, the design agreed with the owner
   before coding (the installed artifact is the launcher and root of code trust; `activate` commits a monotonic
   `active` record after a start check on bytes read once; `run` hands the active bytes over stdin with a one-hop
   marker and explicit directories, refuses with no fallback, relays the child's exit; scrubbed start check; named
   refusals), the failure and concurrency table, and the limits kept explicit (initial installation and the root of
   trust out of band, production key distribution, whole-machine power loss, the extension cannot activate, no
   unattended activation). The acceptance suite `verifier-pvm-client-activation` is written from the agreed interface
   with canary artifacts. The owner shipped 0.3.0 (0f4c79fd) to the agreed design the same day: the hashes were
   recomputed from the git objects, the client pins and the artifact record moved there, both artifacts reproduced, and
   all 10 activation cases pass (two harness defects fixed, none in the owner's code; results per case in the review);
   strict command 86 of 86. The one order a canary cannot reach, a policy commit after activation, is closed with the
   REAL client as the activated version: reproducible next builds from the pinned source (`next-build.mjs`,
   `next-builds.json`) and the owner's derived device artifact reproduced byte for byte and tied to the source rebuild;
   7 more cases (rotations and one hop by the delegated real client) pass, strict 93 of 93. Host evidence only: the
   delegated real client reaches "policy committed, evidence requested, refused: no evidence"; the real attestation and
   sealed streams are the owner's device run: reviewed independently in review section 11 (owner's a7d624c2, results
   copied as a fixture, 9 checks with this session's code in the strict command: artifact identity against this
   branch's reproduction, manifest signatures, the generation log, every snapshot, the six policies replayed, running
   identity with the checker's miscount confirmed from the raw files, refusals and repairs, the VM capture decoded and
   matched one to one by nonce). Device evidence is the activated client's own verified summaries plus the VM's
   served count; the raw envelopes were not saved, so no chain was re-verified offline there. The repeat run with raw
   evidence capture (owner's ae209496, review section 12, fixture pinned) closed that gap: all ten exchanges re-verify
   offline through the exact pinned adapter under the policy committed before each, correlated by label, nonce, time
   and the client's primary state data; one capture defect (the carrier-side state copies null, a run-script fault
   disclosed by the owner) was recorded as finding F3 with the strict verdict NOT ACCEPTED (exit 3). A third bounded
   run, directed by Codex under Steven's standing validation scope with no fresh approval message (owner's 75718b4b,
   review section 13, fixture pinned, tooling committed before the run), has every snapshot present and equal, all ten
   chains re-verified offline again, its checker and preflight passing: F3 is closed by that rule's first path. Run 2
   stays a recorded failed run, never accepted: an F2-style regression case asserts its precise null-copy defect
   inside the run-2 review, and a separately invoked negative runner verifies the original assertion fails on it with
   its recorded reason; the strict acceptance command itself has zero failed, skipped or todo cases (130 of 130).
10. Runner defect, found by Codex's source audit (coordinating under Steven's standing project scope, not a direct
   instruction from Steven) and fixed: the strict command dropped every not-ok entry whose name
   looked like a test file before classifying, and never checked the child's exit status or the numeric counts, so a
   file-level timeout with `fail 1` could reach PASS once findings were closed. The verdict is now a pure function
   (`verifier/integration/verdict.mjs`) tested on real TAP (`test/verifier-integration-verdict.test.mjs`): every not-ok
   entry at any level counts; cancelled, skipped and todo entries fail and are named; the report must carry a plan and
   every count, the counts must add up and match the entries; the exit status must agree with the report and a
   signal death fails; only an open finding recorded against the exact pinned revision can account for an exact
   case-level `testCodeFailure` it names, never a file or path, giving NOT ACCEPTED (exit 3); a clean, complete,
   consistent run with exit 0 is the only PASS. Nothing disappears by name. Independently verified: Codex reviewed the classifier
   and its negative checks and completed the strict command at 7ae1ab36 with exit 0, 140 of 140, zero cancelled,
   skipped or todo, every pin, next build and device fixture reproduced or matched (review section 14). The lab
   review rests at that boundary; failed runs and evidence limits are preserved as recorded.

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
2. **Shadow in the enclave self-check** (BUILT 2026-09-25, section 10.4): `runSelfCheck` runs both verifiers and publishes
   the second result beside the first as `verification.selfCheck.enclave` with `agreement`; still a diagnostic. Flag:
   `SELF_CHECK_VERIFIERS=both|tinfoil|enclave` (default both; tinfoil = the previous object).
3. **Shadow in the CLI** (BUILT 2026-09-25): `enclave attest --verifier both` prints both verdicts; the exit code follows the
   Tinfoil verdict until stage 7. Flag on the command line only (default tinfoil, unchanged).
4. **Shadow in the browser**: `site/js/core/verify.js` runs the new bundle beside `verifier.js` and renders
   the new verdict as a secondary line; the green state still comes from the Tinfoil result. Same-origin
   bundle built by `build-vendor.mjs` from this repository's code, so no CDN and no new host.
5. **Consumer gate**: clients (CLI, Node consumers, later the browser bundle) release requests only through
   `verifier/admission.mjs`; pVM evidence enters through the owner's `verifyPvmAppEvidence` behind the
   adapter; the gaps in section 8.1 close first.
6. **Relay** (BUILT 2026-09-25, shadow by default): dialed rows are re-verified with the new verifier
   (`RELAY_REVERIFY=shadow|enforce|off`; today `teeCpu` is self-reported and stays the rule until `enforce`);
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
| M1 | strict envelope for every format in the registry (DONE 2026-09-24: per-format shapes), CRL policy modes (done), collateral adapters with a disk cache (DONE 2026-09-24: the authenticated, slot-bound cache), Rekor v2 bundles (BLOCKED: no authentic v2 bundle located; see below), scheduled live differential job (PREPARED 2026-09-24 as a shadow job: `verifier/live-differential.mjs` and `.github/workflows/verifier-live-differential.yml`, dispatch-only and gated by a repository variable that is not set, read-only, tested offline on the fixtures) | 5 |
| M2 | browser build: WebCrypto signatures, X.509 via a reviewed library (PROTOTYPE DONE 2026-09-24: `verifier/web/`, the same `snp.mjs` verdict code behind a crypto provider; see `browser-x509-parser-decision.md`); reproducible packaging with an input manifest and exact notices (DONE 2026-09-24: `verifier/web/dist/`, `reproduce.mjs` under the strict command); an opt-in same-origin shadow adapter that records and never decides (DONE 2026-09-24: `verifier/web/shadow.mjs`, proven in Node and in Chrome 151); same-origin delivery through the site's vendor rule and the site's opt-in shadow line (DONE 2026-09-24 under Steven's website authorization: `site/vendor/enclave-verifier.js` via `scripts/build-vendor.mjs`, `site/js/core/verify-shadow.js` awaited by `verify.js`, record only, viewer opt-in, no primary root or verdict change; `verifier/web/README.md`) | 8 |
| M3 | CLI `--verifier both`, self-check both, relay re-verification of dialed rows (BUILT 2026-09-25, section 10.4: every path behind a flag whose fallback is the previous behaviour; no live hosted enclave existed to show a `verified` end to end) | done, pending live data |
| M4 | signed release index in the release workflow (BUILT 2026-09-25, section 10.5), minimum-release policy (BUILT: `verifier/release-policy.json`, the floor only rises), publication order from the signing run + persisted memory (BUILT, section 10.5), TUF-verified refresh of the pinned root with a weekly PR job (BUILT, section 10.6), the same-origin mirror on the relay and the per-consumer strict rollout criteria (BUILT/WRITTEN, section 10.7), the browser's own release provenance from the mirror (BUILT 2026-09-25, section 10.7: verified in the browser against the pinned root, labelled fallback) | done |
| M5 | independent review, cutover per consumer with fallback flags | 3 + review |
| later | TDX (QVL-grade), NVIDIA GPU evidence, measurement recompute from archived image inputs, AVF ABI/2 relay frame | separate plans |

**Rekor v2 (2026-09-24).** The pinned Sigstore trusted root already knows the v2 log (`log2025-1.rekor.sigstore.dev`,
valid from 2025-09-23), so a v2 entry would verify through the same library once a bundle carries one. No authentic
public bundle with a v2 entry was located to make a fixture of: our own latest release (v0.5.841, the pinned one) and
cosign v3.1.3's release bundle are both on the original log (`rekor.sigstore.dev`, with an inclusion promise), and the
GitHub artifact-attestation API returned no inline bundle for a recent gh release, only a framed binary blob that was
not decoded here. Nothing is fabricated: the v2 path stays untested until a release of ours, or a public bundle with
provenance, carries a v2 entry; the differential job will show it the day our release workflow moves.

**The live differential job (2026-09-24), prepared; ENABLED and scheduled 2026-09-25 (Steven: repeatable live coverage): the repository
variables `VERIFIER_LIVE_DIFFERENTIAL=enabled` and `VERIFIER_LIVE_HOST` are set, the workflow runs daily at 06:17 UTC against that host
(Tinfoil's public host until a hosted enclave of ours is live, which yields agree-refuse on every run and a `disagree` on any drift in
the bytes, the collateral or the reference; a dispatch names its own host).** `verifier/live-differential.mjs` is glue over what
exists: `cli.mjs capture` for the enclave's document, certificate and AMD collateral (bounded fetches), the release's
Sigstore bundle verified by `verifier/provenance.mjs` for the expected measurement (never taken from the enclave or a
proxy; latest and the sibling flavors tried), this branch's verifier on the document, the Tinfoil reference on the same
bytes, and a comparison with four verdicts: agree, agree-refuse, disagree (exit 1), and reference-missing (exit 1: a
differential that cannot compare has not run); provenance or capture failure exits 2 with nothing verified. The
comparison is like with like: the reference checks the bytes and reports a measurement but applies no measurement
policy, so the same provenance-derived policy is applied to its measurement, and the report says separately whether the
two agree on the bytes and whether the measurement is one of ours. On the Genoa fixture, captured from Tinfoil's own
public host, the honest outcome is agree-refuse: both accept the bytes, and the measurement is nobody's release of
ours, which the offline test asserts as such. The workflow runs only on a manual dispatch with the host a REQUIRED
input (a host that does not run one of this repository's releases yields a shared policy refusal, never a
disagreement) AND only when the repository variable `VERIFIER_LIVE_DIFFERENTIAL` is set to `enabled` (it is not), with
read-only permissions, no secret, pinned actions and the report as its only output.
Enabling it is a recorded act in the repository's variables, not a merge. The offline test runs the same orchestrator
on the fixtures with the installed reference.

## 10.1 The Linux per-app SNP tier (2026-09-24, Steven's direction: verify the tier, defects to the owner directly)

The isolation owner's first production canary (hello-world:1.0.4 on metal-iso0, `https://4e62e60d.app.enclave.host`,
deployment `0x4e62e60d…`) serves the domain format exactly as registered here (`sev-snp-guest-domain-v1`, ABI/2, nine
keys). Its capture is pinned at `test/fixtures/verifier/linux-canary-2026-09-24` (fixtures.json, owner's commit aeddcfa1)
and the owner's runtime contract is pinned as `linux-domain-contract` (pins.json: `isolation/contract/runtime.mjs` for
RuntimeID and Bind2, `catalog/DERIVE.md` and `derive_reference.py` for the AppID), imported and never restated.
`test/verifier-linux-canary.test.mjs` (4, strict) verifies the capture offline through the domain path: the served
certificate's key is the bound key, Turin v5 VMPL0, Bind2 over the served key, the nonce and RuntimeID, the chain through
the captured VCEK with the CRL, the TCB floor, the AppID; every single-field forgery refused; the browser build equal.
`verifier/live-domain-check.mjs` is the read-only live check (one TLS session, the peer certificate of that handshake, a
fresh nonce, the pinned contract, explicit expectations): on 2026-09-24T19:33Z the live guest VERIFIED with its rotated
transport key (the owner's F6: a node restart reaped and relaunched the guest), the VCEK fetched from AMD KDS and a fresh
CRL. Limits, stated: the expected measurement is the reviewed capture's (the release bytes are unpublished, so it is
continuity, not provenance); the expected AppID IS reproduced: the component (72,989 bytes) fetched by CID from the
platform's gateway `ipfs.enclave.host` (public gateways do not hold it) and derived with the owner's pinned
`derive_reference.py` gives `9c3d10f1…`, the value the live report and the capture name. Defects sent to the owner:
served-cert.pem missing from 26c3cc86 (fixed at aeddcfa1); the README abbreviates the expected measurement; DERIVE.md
should name the gateway a verifier fetches the component from; KDS does serve this chip's VCEK although the README says
otherwise. Finding: the
canary runs on the same Turin part as the M4a lab capture (the lab VCEK verifies the production report).
**F11, measured 2026-09-24T19:53Z.** A second live instance of the same app (E, `395bed3e.app.enclave.host`, guest
gd6ee1b5cd) and A were checked under one set of expectations: both VERIFIED, and every claim in the two verdicts is
identical (measurement, AppID, chip, TCB, runtime binding, roots); only the served key, the report id and report_data
differ. The domain evidence names no deployment, so a misroute between two instances of one version is undetectable from
the document alone; a client detects it only with a key pinned earlier (TOFU) or a deployment-bound field in the
attested bytes, which the pVM tier is now adding as instance binding. The node's SNI and splice checks are host-side
hygiene a client cannot verify. The owner records this as F11.

## 10.2 pVM instance binding (v3), the verifier's side (2026-09-24)

Bytes and trust source agreed with the pVM owner (INSTANCE-BINDING.md at 3be2ce0c; implemented at 193cf823): a v3
closed envelope (v2 plus `instanceKey`, the instance key's Ed25519 SPKI, and `instanceSig`), the challenge
`Bind3(spki, nonce, RuntimeID, InstanceID) || AppID` with `InstanceID = SHA-256(instanceKey)` never carried as a field,
`appKeySig` under a v3 domain covering the InstanceID, a per-instance identity derived by AVF from the instance secret
(stable across restart, new on re-provision; the transport key stays boot-fresh and is inside Bind3), and the signed
policy as the trust source: type `enclave-pvm-client-policy/2`, entries `{ id, app, instances }`, 1..8 unique
InstanceIDs, each bound to at most one deployment, v3 required in `formats`, rotation by re-sign under the existing
serial rules; a type-1 policy carrying instances is refused by name and clients before 0.5.0 refuse type 2.

Here: `verifier/pvm-evidence.mjs` accepts v3 through the owner's pinned module (pins.json `pvm-app-attest` at 193cf823;
v1 and v2 re-verify unchanged), passes `expect.instanceIds`, refuses v1/v2 as a downgrade for a bound deployment before
any certificate, cross-checks the returned InstanceID against SHA-256 of the envelope's key and against the bound list,
and exposes `claims.instanceId`; `verifier/pvm-policy.mjs` verifies type 2 and its instance rules, `selectDeployment`
returns the bound instances, and `expectationsForSelection` carries them as `instanceIds` with `formats` narrowed to v3,
so a bound entry can never be run without the expectation; `verifier/admission.mjs` releases, with `expect.instanceIds`,
only a v3 verdict naming a listed instance, native and browser alike, and holds a malformed expectation; the vectors
(`verifier/admission-vectors.json`, 49 cases) carry the rule for the owner's gate mirror. `test/verifier-pvm-v3.test.mjs`
replays the owner's 23 static cases (pins.json `pvm-v3-fixtures`) through the adapter, the policy verifier and the gate,
with the owner's 0.5.0 `trust.js` (pins.json `pvm-client-src-v3`) as the differential reference on every policy outcome
and every per-deployment instance list. Where this verifier's consumer pre-checks refuse before the owner's module (the
echoed nonce, the echoed app, an empty instance list, a relabelled envelope), the reason is this verifier's own and the
test says which. **The device campaign, reviewed (owner's 7e88dc76, pinned as `pvm-instance-device`, 63 files;
`test/verifier-pvm-instance-device.test.mjs`, 5).** Re-derived from the raw files through this verifier's adapter over the
owner's module under Google's roots: the enrolled InstanceID is SHA-256 of the instance key the VM presented over the
enrollment's own nonce; the type-2 policy binds the deployment to exactly it; the five EVIDENCE3 answers (first boot, a
restart, a same-key APK update with a code change) verify as v3 proving that InstanceID with ONE instance key and new
transport keys per boot; the same genuine VM is refused for a deployment bound to another instance after its app, Bind3
and instance-signature checks passed, and verifies for the deployment bound to it (app identity and instance identity are
two facts); the unbound deployment answered over v2 with no instance, and that v2 answer is a downgrade for a bound one;
the gate releases only the bound turns; no answer was cut. The owner's replay of the gate vectors found one decision
difference (an unbound v3 verdict lacking its InstanceID, which their gate released and this gate holds) and a missing
1..8 cap, both aligned to the stricter rule; 46 of 46 in-scope decisions equal. Found on the way by the owner: a v3 payload
bug that cut the answer's final newline to a NUL on some attestations, which the client refused as unparseable (fail
closed) and which the v1/v2 path shared. Not measured, stated: re-provisioning (a new instance.img). Not done: the HPKE
info (unchanged by agreement) and the client 0.5.0 artifact pin for the extension suites (the dist is now 251dd8fa…).

**The lease proof key (owner's PROOF-KEY.md, agreed 2026-09-24; implemented and device-checked at 047f7739).** A pVM
runner's `EnclaveProofOfTime` checkpoints are signed by a secp256k1 key minted inside the VM; the attested Ed25519
transport key vouches for that key's address in an "enclave-proof-key/v1" statement over a 271-byte message (header,
nonce, AppID, a typed instance, a typed signature algorithm, the proof key, the chain id, the two contract addresses, the
deployment, the runner id and the operator), and the checkpoint is exactly the contract's EIP-712 digest. The pin moved
to 047f7739: the module gained `verifyPvmProofKey` and `proofKeyMessage` as a pure append (the v1/v2/v3 evidence paths are
the same bytes), plus `relay/pvm-checkpoint.mjs` and the Pixel 10 device fixtures (a real v3 envelope under Google's roots,
25 statement negatives with exact reasons, 2 device-signed checkpoints accepted on a local chain, 5 negatives) with the
owner's replay test, which passes against the pinned tree here (34/34). `verifier/pvm-proof-key.mjs` is the consumer's
gate over both: it re-verifies the statement's evidence through this branch's consumer checks (v3 only), rebuilds the
271-byte message from the spec and checks the Ed25519 signature under the transport SPKI that re-verification returned
(the two readings of the spec give identical bytes), holds the statement to the CONSUMER'S PINS before any cryptography
(chain id, proofOfTime and registry from the address book, deployment from the selected policy entry, operator and
runner from the ledger row when known: the owner's verifier compares only the deployment, so Base's 8453 against the
device's local 31337, another contract, operator or runner are refused here and only here), and recomputes a
checkpoint's digest from `EnclaveProofOfTime.sol`'s own type strings by hand (domain separator and struct hash as the
contract encodes them), recovers the signer and requires the owner's checker to agree on outcome and digest. A proof-key
verdict admits nothing (`admissionSafe` is always false): it names the key a checkpoint must be signed by and the lease it
may sign for. `test/verifier-pvm-proof-key.test.mjs` replays every fixture through the gate (outcomes equal the owner's
record, claims equal theirs, digests equal the device's), holds the contract source to the hashed strings, and adds the
pin and checkpoint negatives beyond the owner's list. Not built, by anyone: the owner-side posting agent; nothing is
registered on a public chain. What a checkpoint means is the VM's own account of running and serving, not reachability.

## 10.3 Deployment binding for the Linux tier (F11 fix, verifier side, 2026-09-24)

Agreed shape with the isolation owner: guestd launches each per-app guest with SNP `HOST_DATA` = the 32-byte
deployment id (PSP-signed into every report, outside the launch measurement). `verifier/snp.mjs` gained
`context.expectedHostData` (exactly 32 bytes): the report's HOST_DATA must equal it, all-zero is refused when an
expectation is given and never read as unbound, and the check is absent when no expectation is given; the browser build
shares it; `verifier/live-domain-check.mjs --deployment 0x…` passes it. The owner deployed it at bc07f899 (guestd
restart 20:05:55Z, guests gd73150289 for A and gddbce9f8d for E relaunched 20:06:08Z with new keys 9848352b… and
3cd10bfc…). **Measured from the public side at 20:07Z:** A under A VERIFIED with the host-data check true, E under E
VERIFIED, E under A REJECTED at the host-data check naming E's id, measurement and AppID unchanged on all three; the
owner's trusted-mode runs through the relay agree. The capture is at the owner's 2db69f32 (`host-data/` beside the
first capture) and the canary suite carries the pre-change capture as the zero-HOST_DATA refusal. What it cannot close,
stated: a host launching another genuine instance under the same id (the owner's A3).
**F2, WebPKI certificates for the guests' own keys (owner's 6757d139, capture at 4531d1e3 in `webpki/`).** Each guest now
serves, over SNI, a ZeroSSL-issued leaf for `<label>.app.enclave.host` on the SAME in-guest key the report binds; by
address (host side only, the public edge refuses a hello without SNI) the self-signed carrier on that key. Measured live
at 20:40Z with the new release 6f14ce75… and its measurement c068f423…: A and E VERIFIED with host data, the leaf's SPKI
equal to the document's transportKey. The verifier's rule is unchanged and the suite asserts it: the verdict is a
function of the handshake's SPKI; the carrier chain is no trust input, and a publicly chaining certificate proves
nothing about key custody. Recorded from the owner: the node's issuance gate applies no TCB floor and holds the
measurement to guestd's word; a still-valid certificate for the same key and name can be re-posted by anyone (200),
another key or name is refused (422).
**F7, guestd restarts adopt guests (owner's 48ef955b).** The first F7 deploy did not adopt: the old binary's SIGTERM
handler stopped both guests at 20:43:45Z and they relaunched with new keys (295ce2e0… for A, d590dd84… for E) and new
ZeroSSL certificates; the owner reported it as a failure of that deploy. The fixed guestd, restarted by SIGKILL so the old
handler could not run, adopted both at 20:46:03Z. Measured from the public side at 20:46:44Z and 20:47:20Z: both VERIFIED
with host data and the F2 measurement, keys unchanged across the transition. From here a guestd restart keeps guests and
keys; a guest relaunch (a guest image or front change) still gives new keys.
**F3, the attested tunnel's registry id (owner's 99b0e3c0).** The relay-terminated `/x/<id>/` for A or E had been answered
by another node's 503 through a fan-out, because the metal agent's only hello arrived before the hub bound the attested
tunnel and the node's row stayed synthetic. The owner restarted the node at 20:51:41Z with guestd untouched; A and E were
adopted at 20:52:56Z. Measured from the public side at 21:06:08Z and 21:06:14Z: both VERIFIED with host data, the
F2 measurement and the same keys (295ce2e0…, d590dd84…) as before the restart (the certificates carrying them were
RE-ISSUED by that restart, which this check could not see: it recorded the leaf's day-granular window and not its serial;
see the correction under F10), and `GET https://api.enclave.host/x/0x<deployment id>/` answers 421 from the lease holder, naming the guest's own origin (the
bare-hex form is not an id there and is 404 "not_found"). So a node restart that leaves guestd alone keeps the guests'
keys; only the F7 case above (guestd itself) and a guest relaunch were measured to change them.
**F10, a wasi:cli command in its guest, and a TCB floor for issuance (owner's cf8b22bd; reviewed at that commit and
measured live at 21:24Z, below).** The bundle manifest gains `world: wasi:cli` with one `http` port (1..49999); `wasi:http` (or no
world) names no port and any other world is refused. The derivation `enclave-catalog-bundle/2` is v1 with that world
and port, and the record gains `http`. Checked here rather than taken from the commit message: the pinned reference
regenerates the committed vectors byte for byte, every v1 vector's bundle and AppID are identical under the 2db69f32
and cf8b22bd scripts, and the owner's Go tests (the rule against the reference, the world/port table) pass at cf8b22bd.
`isolation/contract/runtime.mjs` (Bind2, RuntimeID) is the same blob, so the verdict path is unchanged; the pin moved
to cf8b22bd for the reference and its vectors, and `test/verifier-linux-derivation.test.mjs` replays the vectors
through the pinned script and adds the record shapes a supervisor could send over JSON (a string, float, boolean, null
or negative port; a v1 record carrying `http`), each refused. In run mode the guest's init passes wasmtime
`-S tcp,udp,inherit-network`; the guest has no NIC and its only channel is vsock, so that reaches its own loopback and
nothing else, and the front still proxies 127.0.0.1:N behind the attested TLS key. New guests built from this initrd
have a new launch measurement; the owner sends it with the domain release. The TCB floor is a file measured into the
node image (`/opt/metal/isolation-min-tcb.json`, the same Turin values as the canary's `min-tcb.json`), passed to the
owner's judge as `minTcb`: with it only an "attested" verdict issues, a malformed floor is refused by `checkMinTcb`
(so nothing issues), and a node image without the file still issues on "no-tcb-policy" (chain verified, TCB unjudged),
which the supervisor logs. The expected guest measurement remains guestd's word. DERIVE.md describes v2 since the
owner's 0181bce3 (the pin picks it up on its next move).
**Measured (21:24Z), the owner's guestd restart and node restart (image dist-iso-c02a2c2e, relay allowlist af8a5d51…)
and the first v2 deployment:** A and E VERIFIED with the same keys (295ce2e0…, d590dd84…) through both restarts (adopted by guestd at
21:17:59Z and by the new node at 21:19:36Z). **Correction from the owner (their finding, not this check's):** the node
restart re-issued both certificates (A's serial 6fbaaa4a… became 9acd5518…, E's 3a77db7e… became 2c36b3a9…) although
each guest still served a valid leaf for the same key; the supervisor's certificate loop kept no memory across restarts,
so every node restart spent one CA issuance per tier app from the shared quota, and the F3 and F7 restarts most likely
did the same. This check reported "certificate windows unchanged", which was true and covered nothing: a re-issued leaf
for the same key and name has the same window at day granularity. `verifier/live-domain-check.mjs` now records the
served leaf's serial, issuer and sha256 beside the window. The owner's fix is 8ed6231f (before judging or issuing, the
relay handshakes under the name and issues nothing while a WebPKI-valid leaf for exactly the route's key is before 2/3 of
its life); baseline serials at 21:31Z, before the next node restart: A 9acd5518…, E 2c36b3a9…, hookbin 3636639a….
**Measured (21:38Z), the owner's node-only restart at 21:32:32Z on the image with 8ed6231f (F12 fixed):** A, E and hookbin
VERIFIED with the same serials, the same leaf fingerprints and the same keys as the 21:31Z baseline, so that restart
issued nothing where the 21:18 one re-issued both. The owner's evidence for the round is at ffcd572a (`f10-hookbin/`),
with two more findings recorded there: F13 open (the app sees `x-forwarded-for: 2`, the host's vsock CID; the fix is
in the front, so it changes new guests' measurement and ships with a release) and F14 (a transient operatorSig
rejection at attach, 2 of 7 boots, clearing in 3 s). The owner's next piece is an independently pinned expected
measurement for issuance (a measurement kit measured into the node image, the supervisor content-checking the guest's
initrd against the pinned release manifest); what this side will hold it to is that the number comes from bytes the
supervisor checked and that an absent kit or manifest refuses rather than falling back to guestd's word.
**The hookbin capture as a fixture (`test/fixtures/verifier/linux-hookbin-2026-09-24`, `test/verifier-linux-hookbin.test.mjs`):**
the verifier session's own public-side capture (`verifier/live-domain-check.mjs --save`: the document as served, the nonce,
the peer certificate of that handshake) after the 8ed6231f restart, the component by CID (CID-checked, 201,013 bytes)
and the chain's v2 record, with the owner's evidence files copied verbatim. Offline, through the pinned contract: the
served leaf carries the bound key (serial 3636639a…, the one the node logged as already valid); the AppID is DERIVED
from the component bytes and the v2 record by the pinned reference and the report names it, while the same record
read as v1 derives 9add8960… and is refused at the app-id check; HOST_DATA is the deployment; the measurement
be6b8644… is accepted as the owner's word and the suite says so; another deployment's HOST_DATA, the canary's
measurement, another nonce, ABI/1 and a zero HOST_DATA expectation are refused by name; the browser build agrees on the
capture and on the forgery. It is the first v2 case in the strict command.
 hookbin 0.1.4 (deployment 0x0ddbd824…,
`0ddbd824.app.enclave.host`) VERIFIED from the public side: the AppID was DERIVED here under v2 (`--derive`: the component
fetched by CID from the platform gateway, 201,013 bytes, its sha256 equal to the CID's multihash digest, then the pinned
reference on the chain's record with `http: 8000`) as d2c4dfc0…, the report names it, HOST_DATA equals the deployment id,
the served SPKI b071a9c9… is the document's transport key, TCB at the floor, and the measurement be6b8644… was accepted
as the command-line expectation (the owner's pinned-release reconstruction; not reproduced here until the release bytes
are). The negative: the same record read as v1 (no port) derives 9add8960… and the report is REFUSED at the app-id
check, so the port is in the identity, not beside it.

## 10.4 M3: the production consumers (2026-09-25, Steven's direction: the next unfinished consumer integrations)

One module carries the three consumers: `verifier/consumer.mjs`. It composes what existed and adds no verdict rule: one
capture over the caller's OWN TLS connection (`captureHosted`: the document and the certificate of that handshake, from
one `https.request`, WebPKI on by default), the expected measurements from VERIFIED release provenance only
(`releaseExpectations`: the latest tag from GitHub's index or explicit tags, each flavor's `tinfoil.hash` and attestation
bundle, `verifier/provenance.mjs` against the Sigstore root pinned at `verifier/roots/sigstore-trusted-root.json`, which the
module imports so it travels inside every bundle), the verdict of `verifier/snp.mjs` through the envelope registry (TDX,
GPU, VBS, Hyper-V and unknown formats are `unsupported`, never green), the Tinfoil reference on the same bytes when asked
(`referenceVerify`), and the comparison in the live differential's words (`compareVerdicts`: agree, agree-limited,
agree-refuse, disagree, reference-missing) plus a descriptive `dualAgreement` for two legs that fetched for themselves.
A TCB floor is a stated policy input (`minTcb`); without one the best verdict is `limited` (tcb-floor-unjudged), which
every consumer prints as such and never as a pass.

The Node bundle. `verifier/node/build.mjs` packages the module reproducibly (esbuild, platform node, `@tinfoilsh/verifier`
external so the reference stays a run-time import that reports `installed:false` where absent) into
`verifier/dist/enclave-verifier-node.mjs` with a MANIFEST naming every input's sha256 and regenerated notices, and copies
it byte for byte to `relay/vendor/` (the relay's deploy ships `relay/**` only). `verifier/node/reproduce.mjs` rebuilds
and compares; the strict command runs it before any suite (`test/verifier-node-bundle.test.mjs`: same verdict through the
bundle as through the sources).

Stage 3, the CLI (`cli/enclave.mjs`): `enclave attest [id] --verifier tinfoil|enclave|both` (default tinfoil, byte for
byte the previous behaviour, including a thrown Tinfoil verification ending the command). `both` runs both and prints
both verdicts with `agreement`; the exit code follows Tinfoil's; a Tinfoil leg that throws is recorded, not fatal.
`enclave` lets this verifier decide. `--min-tcb JSON` states the floor; `--release-bundle F[,F] --release-digest HEX[,HEX]`
takes provenance offline; `--collateral-dir DIR` takes AMD collateral from disk. `test/cli-attest-verifier.test.mjs` runs
the real CLI process against a local API and a local TLS enclave serving the Genoa document (the run's own CA through
NODE_EXTRA_CA_CERTS): rejected on the measurement under our releases' provenance, `unavailable` for a dead enclave, the
other-repo refusal unchanged, an unknown mode refused. Measured limit: `@tinfoilsh/verifier` builds its URL from the
hostname alone, so its leg cannot reach an enclave on another port.

Stage 2, the self-check (`supervisor.js`): `SELF_CHECK_VERIFIERS=both` (default) runs Tinfoil's leg as before AND
`selfCheckHosted` from the bundle the Dockerfile now copies into the image (`verifier/dist/enclave-verifier-node.mjs`):
the capture over loopback to the shim with SNI for the public name (the trusted in-CVM source the existing self-check
uses), the release index through the github-proxy the enclave already reaches (`SELF_CHECK_RELEASE_INDEX=direct` for
GitHub), AMD collateral through Tinfoil's KDS proxy (`SELF_CHECK_KDS=amd` for AMD), `SELF_CHECK_MIN_TCB` for the floor.
`verification.selfCheck` keeps `result`/`steps`/`release`/`measurement` as Tinfoil's and adds `verifiers`, `enclave` (the
own leg's status, matched release, measurement, failed checks, omissions, a four-line tail of reasons) and `agreement`.
`=tinfoil` is the fallback (the previous object, unchanged); `=enclave` makes the own leg decide `result` (stage 7 for
this consumer). The glue in `supervisor.js` is not unit-testable (the module runs at import); `selfCheckHosted` is
(`test/verifier-consumer.test.mjs`: a local shim, a local release index with the three routes, the Genoa document
rejected on the measurement, a loopback that does not answer is `unavailable`).

Stage 6, the relay (`relay/reverify.mjs`, wired in `relay/api-relay.js`): `RELAY_REVERIFY=shadow` (default) re-verifies
every DIALED row on its own cadence (`RELAY_REVERIFY_SEC`, 900), one row at a time, never inside the availability poll:
capture over the relay's TLS connection to the row's endpoint, provenance from GitHub (cached an hour; a failed refresh
keeps the last good set and says so on the row), AMD collateral through the authenticated disk cache
(`RELAY_REVERIFY_CACHE_DIR`), the floor from `METAL_MIN_TCB` (the attach gate's). Rows carry `reverify` in the fleet
view and the aggregate carries the run statistics; eligibility is unchanged in shadow. `=enforce` makes a dialed row
eligible only on a `verified` re-verification (`ineligibleReason` says why not: rejected with the failed checks,
unsupported, limited, unavailable, pending); tunnel rows are untouched (their evidence is the attach gate's). `=off` is
the fallback: nothing runs, no annotation, `computeEligible` exactly as before. `test/relay-reverify.test.mjs`: the real
capture path against a local enclave (rejected on the measurement, annotated, eligibility untouched in shadow), the
three modes' effect on eligibility with verdicts of the real shape, no verified provenance never verifying, the vendored
bundle loading with the exports the module uses.

What no test could show today: a `verified` outcome end to end on a hosted enclave of ours. The fleet was empty
(`no_serving_enclave`) throughout, and no capture of an enclave running one of our releases exists as a fixture; the
mechanism is shown on the Genoa capture under a policy naming its own measurement and floor (verified, no omission), and
every consumer's positive path is exercised with verdicts of the real shape. The first live hosted enclave will produce
the first `agree` or the first disagreement, in the self-check's `enclave` field, the relay's `reverify` annotation and
`enclave attest --verifier both`.

## 10.5 M4: the signed release index and the release floor (2026-09-25)

Until now a consumer learned which release is current from GitHub's unauthenticated `/releases/latest` and verified that
release's provenance: every release it was pointed at was genuine, the pointer was not, and only the built-in floor
(`DEFAULT_RELEASE_POLICY.minimumRelease`) stood between a verifier and an older genuine release. `verifier/release-index.mjs`
closes that. The publish workflow gained its own `release-index` job after the measure step: it builds
`release-index.json` from the published releases (this tag included; the latest tag and digest per flavor; the floor and
the revocation list from `verifier/release-policy.json` at the tag, currently v0.5.841 and none), attests it keylessly
under the SAME identity as the release (`actions/attest`, pinned; subject = the file's sha256; predicate
`https://enclave.host/predicate/release-index/v1` carrying the index's digest and pointers), and attaches it to the
release. Its failure leaves the release published and shows red on its own.

Consumers (`releaseExpectations`) fetch the latest release's index and its attestation by the file's digest, verify it
through the provenance module's shared statement check (`verifyStatementBundle`: Fulcio chain to the pinned root, SCT,
Rekor, DSSE, the identity policy, exactly one subject that IS the digest, the index predicate), then apply `checkIndex`
(schema, repository, the predicate's digest and pointers equal the index's, a floor that is at or ABOVE the built-in one,
well-formed `latest` per flavor, nothing revoked or below the floor pointed at). Verified, the index names the tags to
verify and raises the floor and the revocation list for that run; a revoked tag contributes no measurement whatever its
provenance says. Absent or refused, the unsigned pointer is the recorded fallback (`index.status`: unavailable, refused);
`requireIndex` fails closed and is the switch for a later cutover. Raising the floor is a reviewed commit to the policy
file; the next release signs it.

**Authenticity and freshness, separated (2026-09-25, after Codex's audit of the first index).** The first index's
`sequence` was the length of a page of releases (100), which is not an order: later releases could carry the same number.
The order now comes from what the signature already authenticates, the signing certificate's run invocation (GitHub's
`.../actions/runs/<run_id>/attempts/<attempt>`, assigned by GitHub, increasing with every run created on the platform,
chosen by no builder). The index file carries the same pair (`sequence` = the run id, `attempt`; schema v2, from the next
release) and the verifier requires them to equal the certificate's; the v1 index is ordered by its certificate alone and
marked `sequenceAuthenticated: false`. Freshness is then a consumer's MEMORY (`verifier/index-memory.mjs`: the highest
publication verified, the digest that carried it, the highest floor), which refuses an older publication (replay), the
same publication with other bytes (equivocation, remembered as such until a later publication supersedes it) and a floor
below the remembered one; a re-run is the same run's next attempt and a re-dispatch a new run, both newer. Concurrent
CPU and GPU publications are two runs: the later-created one wins and lists what existed when it was built, so a sibling
published in between is a transient gap, never a downgrade. The remembered floor applies to EVERY path, the unsigned
fallback included. Every consumer states which case a run was (`index.freshness`: first-seen, newest-seen, same,
not-remembered, or the refusal), and each has a strict switch that fails closed without a verified, fresh index: the
relay `RELAY_REQUIRE_INDEX=1` (memory at `RELAY_REVERIFY_CACHE_DIR/index-memory.json`), the self-check
`SELF_CHECK_REQUIRE_INDEX=1` (memory under `SELF_CHECK_STATE_DIR`, the instance's life unless a volume is named), the
CLI `--require-index` (memory beside its key). All three switches are OFF: until a memory has history, refusing on
freshness would refuse the first index. What is still not closed, stated: a consumer with no memory (or a fresh one)
cannot tell a replayed genuine index from the newest, and the unsigned fallback with no remembered floor is bounded only
by the built-in floor; both are "not-remembered" in the result, never silence. A TUF-style timestamp role remains the
complete answer, with the TUF refresh of the pinned Sigstore root and the mirror at `enclave.host`. Regression evidence:
`test/verifier-index-memory.test.mjs` (successive publications past a hundred releases, replay, equivocation with both
values refused and the refusal surviving a reload, retry and re-dispatch, floor regression, persistence with an
unwritable location reported as not durable) and the memory cases in `test/verifier-release-index.test.mjs` (the real
index first-seen, then a replay under a memory that saw a newer one, with the fallback under the remembered floor). The
first two schema-v2 indexes are real: the release cut by 7c694c41 published one per flavor (v0.5.848, run 36089632273;
v0.5.848-cpu, run 36089622272), both pinned under `test/fixtures/verifier/release-index/`; each verifies with its
`sequence` equal to its signing run (`sequenceAuthenticated: true`), the memory takes the later and refuses the earlier
as a replay, and the live index-first path against GitHub with a fresh persisted memory reported signed, first-seen,
then same from a second process. Tests
(`test/verifier-release-index.test.mjs`): the build under a policy, every `checkIndex` refusal by name, the authentic
v0.5.841 release bundle refused as an index attestation, the consumers' index-first path with its fallback and the strict
switch through a local release index, revocations, the workflow job's pins and predicate. The first signed index exists:
v0.5.847 (dispatched 2026-09-25 02:31Z to exercise the job; the first attempt, v0.5.846, failed on a missing
install step, fixed at dc86269c), attestation 50058862, sequence 100, floor v0.5.841, latest v0.5.847 and v0.5.845-cpu,
twenty releases listed; pinned at `test/fixtures/verifier/release-index/v0.5.847/` and verified positively (the claims name
the publish workflow at refs/tags/v0.5.847), and the consumers' live index-first path against GitHub reported
`index.status: verified` with both flavors' provenance verified from the index's pointers.

## 10.6 M4: the TUF-verified refresh of the pinned Sigstore root (2026-09-25)

The consumers verify release provenance against `verifier/roots/sigstore-trusted-root.json`. Until now that copy had
been reached by following hashes through Sigstore's TUF metadata without verifying the metadata's signatures (its
SOURCES entry said so). `verifier/tuf-refresh.mjs` now refreshes it as TUF prescribes, from pinned trust, through
`@freedomofpress/tuf-browser` (MIT; already a dependency of the Sigstore library the site ships), reviewed here: root
rotations exactly N+1, each signed to the threshold of both the old and the new root and not expired; timestamp,
snapshot and targets signed to threshold, versions never lower than the cached ones, expiry against the clock, lengths
and hashes from the role above; the target by hash and length. Two gaps found in the client and closed around it:
its update returns early when the served timestamp equals the cached one, so after an update that stopped half-way
(timestamp cached, snapshot or targets not) the cached chain would stay stale until the timestamp rolled; the wrapper
checks the cached chain's consistency and re-runs the update once, re-verifying the same signatures. And the ECDSA
signature check reads r and s out of the DER and ignores the framing, so a test that corrupts only the outer tag still
verifies (the test helper corrupts the value). The starting root is `verifier/roots/sigstore-tuf-root.json`: root v15,
reached on 2026-09-25 by walking v1 to v15 live (14 rotations, timestamp v790, snapshot v165, targets v14, the target
byte-identical to the pinned copy). The anchor, root v1, is byte-identical from two independent sources (the CDN and
`sigstore/root-signing` `metadata/root_history/1.root.json`, sha256 cd7549b1...). Every role is cached per file as it
verifies; the pinned files are replaced only from a fully verified refresh, atomically, and only with `--write`; a
refused refresh writes nothing. The weekly workflow (`verifier-tuf-refresh.yml`, dispatch too) refreshes from the pinned
root and, when the verified target or the highest root differs, opens a PULL REQUEST with the files and the versions;
it never writes to main; a verification failure fails the job. A CDN or mirror can only refuse to serve: nothing it
serves verifies unless the chain from the pinned root signs it.

Tests (`test/verifier-tuf-refresh.test.mjs`, through the real client against a repository minted per run with real
keys): the happy path with a rotation, idempotence and a new target; a corrupted signature on each role, with the cached
roles unchanged; a rotation signed below the old threshold; expired timestamp, snapshot, targets and root (the freeze
refusals); a timestamp rolled back and a timestamp whose snapshot pointer went backwards; an update cut at the snapshot
and its recovery with the last trusted target standing; a target whose bytes changed under its name; the pinned files
written only from a verified refresh; a different repository served at the same URLs refused by the pinned root's keys.
And Sigstore's real chain offline (fixture `sigstore-2026-09-25`: roots 1..15, timestamp v790, snapshot v165, targets v14
and the target), verified while its timestamp is unexpired and asserted as the freeze refusal after 2026-09-29, which is
the correct outcome for stale metadata.

**What the publication order does and does not say (release index, section 10.5).** GitHub allocates a workflow run's
id when the run is CREATED; observed ids on this repository increase with creation time across all workflows, and
GitHub documents run ids as unique but publishes no ordering guarantee. So a higher run id says "created later", and
nothing else: not "completed later" (a run created later can publish its index first; the two flavor publications of
one push are exactly that), not "lists everything published before it" (a transient gap, section 10.5), and not
"newer than what a consumer saw elsewhere" unless that consumer's own memory says so. The attempt number orders re-runs
of one run. The index's `generatedAt` is the builder's clock, signed but self-asserted. Freshness in this design is
therefore "the highest creation-ordered publication this consumer has verified", which refuses replays of anything it
has seen and bounds the rest by the floor; it is not a proof that no newer index exists, and a consumer on its first
use, or falling back to the unsigned pointer, has only the built-in floor. Those two cases are said in every result
(`index.freshness`), and the TUF timestamp role above is the shape of the complete answer.

## 10.7 The same-origin mirror, and the per-consumer strict rollout criteria (2026-09-25)

**The mirror.** `GET /v1/release-index` on the api relay serves what the relay's re-verification last VERIFIED: the
signed index bytes, their attestation bundle, and the release attestation bundles of the flavors the index names,
together with the relay's own freshness state (`status`, `authenticity`, `freshness`, `publication`). It is bytes and
signatures, never a verdict: a client verifies the bundles against ITS pinned Sigstore root and orders the index with
ITS memory, exactly as it would from GitHub, so the mirror cannot become an authority; the relay's own memory keeps a
replayed or equivocating index out of it, and a refused or unavailable index is served as that status with no bytes.
`test/relay-reverify.test.mjs`: what the mirror serves verifies client-side (index and both release bundles), altered
bytes and a bundle served for another release's digest are refused by the client, a relay memory that saw a newer
publication serves no bytes.

**The browser verifies release provenance itself (2026-09-25).** `verifier/web/provenance.mjs`
`releaseExpectationsFromMirror({ mirrorUrl })` fetches the mirror (bounded: 8 s, 1 MiB, no redirect, no credentials)
and then decides everything locally: the index's digest is computed in the browser, its Sigstore bundle is verified
against the trusted root PINNED INTO THE BUNDLE (`verifier/roots/sigstore-trusted-root.json`, the same pin the Node
consumers carry), the signing identity and run invocation are read from the certificate, the content checks of
`verifier/release-index-core.mjs` run, freshness is the browser's own `verifier/index-memory.mjs` over `localStorage`
(`enclave.verifierIndexMemory`), and each release the SIGNED index names is verified from its bundle against the
index's digest for that tag, under the index's floor and the union of the index's and the caller's revocations. The
mirror's `status`, `freshness`, `publication`, `indexSha256`, per-release `digest` and `index` fields are recorded
under `mirror.said` and never read for a decision. The modules this needed are now free of Node imports:
`verifier/provenance.mjs` (WebCrypto digest), `verifier/release-index-core.mjs` (the pure half of
`release-index.mjs`, which keeps the builder, the policy file and the command) and `verifier/index-memory.mjs` (a
store adapter: `fileStore` in `verifier/index-memory-file.mjs` for Node, `webStorageStore` for a page, `memoryStore`);
the Node consumers' `createIndexMemory({ file })` is unchanged.

The site shadow (`site/js/core/verify-shadow.js`) now takes its expected measurements from this path first and records
`independent: true` with `expectedFrom` naming the index and its freshness; the primary's `codeMeasurement` is
cross-checked against the verified index (`provenance.primaryMeasurementAttested`). When the mirror is unavailable or
the index is refused, the shadow falls back to the primary's `codeMeasurement` and records `independent: false` with
`expectedFrom` starting `FALLBACK, not independent:` and the provenance status, so a fallback can never be read as an
independent result; with neither, nothing is allowed. Stage 4 of section 9 is therefore independent of the primary's
provenance whenever the mirror answers; the record says which case applied.

Evidence: `test/verifier-web-provenance.test.mjs` (7) on the REAL production mirror answer captured on 2026-09-25
(`test/fixtures/verifier/release-index/mirror-2026-09-25.json`, run 36089632273, v0.5.848 and v0.5.848-cpu): a mirror
that lies about its own run changes nothing; first-seen, then `same` after a reload over the same storage, `replay`
when the storage remembers a newer publication, `equivocation` locked across reloads, a storage that cannot write
reported as `memoryNotPersisted`; the index bundle of v0.5.847 over v0.5.848's bytes refused (unverified), one digit of
a digest changed refused, the mirror's own `index` object ignored; the cpu bundle under the gpu tag refused on the
index's digest while the other release verifies, a lying per-release digest ignored, a tag the mirror does not carry
`unavailable`, a tag the index does not name not a candidate; HTTP 503, non-JSON, over the cap, a redirect, "verified"
without bytes, a bad URL: `unavailable`, fail closed; a caller floor above the index refuses it, a remembered higher
floor is a floor regression, a caller revocation survives the index. `test/site-verifier-shadow.test.mjs` (5) runs the
REAL vendored bundle through the glue: `independent: true` from the mirror, `primaryMeasurementAttested: false` for
Tinfoil's inference host (not an Enclave release, so the shadow's verdict is `rejected` and the comparison `disagree`,
recorded, deciding nothing), the memory in the page's storage and `same` on reload, HTTP 503 giving the labelled
fallback, and the older origin-only case now labelled fallback. `test/verifier-web-browser.test.mjs` (3) still passes
in Chrome for Testing 151 with the enlarged bundle (243 KB minified; the Sigstore verifier and the pinned root are in
it). The bundle's provenance is `verifier/web/dist/MANIFEST.json`, reproduced by `verifier/web/reproduce.mjs`.

Limits, unchanged in kind: the mirror is the browser's only source (a down mirror means the labelled fallback, not an
independent expectation); a browser profile's memory starts empty, so its first index is `first-seen` (authenticity,
not freshness) and a genuine old index replayed to a fresh profile is not detectable until a newer one has been
remembered; the built-in floor on the unavailable and refused paths is `verifier/release-policy.json`'s (v0.5.841,
section 10.8; until 2026-09-25 it was a separate library constant, v0.5.0); private windows and blocked storage give a per-page memory that the record reports as not persisted. The
browser's own verdict remains a shadow: `acceptance: false`, no primary root or verdict changed.

**Strict rollout criteria, per consumer.** Each strict switch stays OFF until every gate below has passed with
recorded evidence; flipping one is a reviewed commit that names the evidence. Status on 2026-09-25 in brackets.

| consumer | switch | gates | status |
|---|---|---|---|
| all | (precondition) | a hosted enclave running one of our releases verified end to end by this verifier (`verified`, no omission) at least once, from the CLI, the self-check and the relay | NOT MET: the fleet has had no hosted enclave since before this work; every positive path is shown on the Genoa capture under a stated policy |
| all | (precondition) | the live differential daily job green for 14 consecutive days with zero `disagree`, its three jobs included (section 10.9: the differential, the positive control, the provenance parity); the TUF refresh job green for two cycles | NOT MET: enabled 2026-09-25 (one dispatched run, agree-refuse against Tinfoil's host); the control and parity jobs first run on the 2026-09-25 06:17Z schedule; the TUF job has not yet run on schedule |
| CLI | `--require-index` default | the user's memory has history (`persisted: true`, one index seen) is unknowable per user: the default stays opt-in; documented in `--help` | opt-in, by design |
| self-check | `SELF_CHECK_REQUIRE_INDEX=1` | 14 days of `verification.selfCheck.enclave.index.status = verified` and `agreement` in {agree, agree-limited} on every hosted enclave, with `memoryNotPersisted` absent | NOT MET: no hosted enclave |
| self-check | `SELF_CHECK_VERIFIERS=enclave` (own verdict decides `result`) | the above, plus the independent review of `verifier/` (M5) | NOT MET |
| relay | `RELAY_REQUIRE_INDEX=1` | the relay's memory has history (`aggregate.reverify.indexMemory.remembered` set, persisted) and 14 days of `expectations.index.status = verified` | NOT MET: shadow live since 2026-09-25 01:52Z, no dialed rows to judge |
| relay | `RELAY_REVERIFY=enforce` | the above, plus every dialed row `verified` for 14 days with zero unexplained `rejected`/`unavailable` | NOT MET |
| browser | own verdict primary | provenance verified in the browser from the mirror (DONE 2026-09-25, above), then 14 days of `agree` with `independent: true` in the site shadow with the primary on hosted enclaves | NOT MET: no hosted enclave; the shadow is opt-in and records only |

Until then Tinfoil is the primary everywhere, and every own verdict is published beside it.

## 10.8 One source for the release floor and revocations (2026-09-25, after Codex's audit)

**The mismatch.** `verifier/release-policy.json` (reviewed, signed into every release index since v0.5.847) set the floor
at v0.5.841, while the library's built-in `DEFAULT_RELEASE_POLICY.minimumRelease` was a separate constant, `[0, 5, 0]`,
841 patch releases lower. Every path without a verified index inherited the constant: a fresh browser profile or a fresh
Node memory whose index was unavailable or refused, the unsigned `/releases/latest` fallback, and `requireIndex` refusals
all reported and applied v0.5.0. Section 10.5 already said the built-in floor is what bounds such a consumer; the
constant made that bound meaningless. The intended product floor is the reviewed file's: v0.5.841 was the latest release
when the index was designed (the plan's pinned release, section 8), and no host in service runs a tagged release below
it (the relay's `/enclaves` on 2026-09-25: the traffic-only relay row, the Linux SNP tier box, whose measurements come
from the isolation branch and are judged by the deployment-binding path, not release provenance, and the NucBox VBS
row, unsupported). No compatibility exception is justified, so none is made.

**The fix.** `verifier/release-policy.mjs` imports the JSON file and is the only definition of the built-in policy:
`DEFAULT_RELEASE_POLICY.minimumRelease` and `.revoked` are the file's, and the Node bundle, its relay copy and the
browser bundle carry the file as a bundled input whose sha256 their manifests pin (so the floor a shipped bundle
applies is reproducible from the tree it was built from, and the reproduce checks refuse a bundle built from another
policy). A malformed file fails the import: nothing loads without a floor. The rules every consumer applies, in one
place (`floorOf`, `revokedOf`) and used by the Node consumer and the browser alike: the floor applied is the highest of
the built-in one, the consumer's remembered floor and a verified index's floor; an index whose floor is below the
built-in one is refused (`checkIndex`, unchanged); a mirror's own fields are never read; revocations are the UNION of
the built-in list, a caller's and a verified index's, so no index or caller can un-revoke a tag. A caller may still pass
an explicit floor (the offline CLI's `--min-release`, the tests), and the result then says `floorSource: "caller"` and
`callerBelowBuiltin: true` beside `builtinFloor`: an explicitly lower floor is possible and never silent. Every result
of `releaseExpectations` and `releaseExpectationsFromMirror` carries `floorApplied`, `floorSource` (built-in,
remembered, signed index, caller) and `builtinFloor`.

**Raising the floor.** A raise is a reviewed commit to the JSON file that rebuilds the bundles in the same commit. The
consumers built from it refuse any index signed before it (its floor is below theirs) until a release built from that
commit publishes an index carrying the new floor. In that window they take their recorded fallback: Node the unsigned
pointer under the RAISED floor, the browser shadow its labelled fallback to the primary's measurement. The policy file
alone cuts no release (deploy.yml releases on image inputs), so a raise that must take effect in the index at once
should land with, or be followed by, a release; nothing is ever accepted below the new floor in the meantime.

**Evidence.** `test/verifier-release-floor.test.mjs` (6): the file, the compiled-in module, the provenance default and
all four shipped artifacts (Node bundle, relay copy, browser bundle, site vendor copy) carry the same floor and
revocations, each manifest pinning the file's sha256; the genuine release v0.5.840 (pinned for this, published five
minutes before v0.5.841) verifies under an explicit lower floor and is refused by default, while v0.5.841 verifies; the
Node consumer and the browser on the same cases (verified index with and without a fresh memory, index unavailable,
index refused, strict, a remembered higher floor, a caller revocation) give EQUAL floor fields, and Node's fallback
refuses v0.5.840 under the built-in floor; a mirror that claims a lower floor, and a mirror with no bytes that says
"verified" and v0.5.0, change nothing; the compiled bundles give the same results as the source on four cases; and a
copy of the tree with the floor raised to v0.5.848 and v0.5.848-cpu revoked refuses the real signed index as below its
floor, falls back under the raised floor, and keeps the revocation against a caller's empty list and a caller's lower
floor, while a malformed file fails the import. Four deliberate regressions (the old constant restored, the built-in
list dropped from the union, the built-in revocation check removed, the remembered floor ignored) each fail the suite.
`test/site-verifier-shadow.test.mjs` asserts the fallback record's floor through the real vendored bundle, for a
profile with history (remembered) and a fresh one (built-in).

## 10.9 Cutover evidence that needs no Enclave host (2026-09-25)

Three gaps in the evidence the gates of section 10.7 rest on could be closed without a host running one of our releases.

**The differential measured a path no consumer uses.** `verifier/live-differential.mjs` took its expected measurements
from GitHub's unsigned `/releases/latest` pointer and checked them against a TEST-FIXTURE Sigstore root. Its provenance
leg is now the consumers' own: `releaseExpectations` (the signed index first, the pinned root in `verifier/roots/`, the
built-in floor, the unsigned pointer only as the recorded fallback) or `releaseExpectationsFrom` for explicit files, and
the report records the source, the index record and the floor applied.

**The differential could not score a positive case.** Its comparison had no `agree-limited` outcome, so a host running a
matching release with no TCB floor stated (the workflow states none) fell through to `disagree`: the first day a host ran
one of our releases the job would have gone red for that reason alone (shown by mutation: without the new rule the case
exits 1). It now reports `agree-limited` when the only omission is `tcb-floor-unjudged` and the reference accepts the same
measurement.

**No live positive case existed.** Against Tinfoil's host the differential can only ever say `agree-refuse` (their image is
not ours). A CONTROL now runs the accepting path daily on production hardware: `verifier/differential/tinfoil-model-router.json`
names Tinfoil's host, Tinfoil's release repository (`tinfoilsh/confidential-model-router`), a floor for their version line
and the Genoa TCB floor measured on that host; our identity rules are otherwise unchanged (same workflow name, trigger and
visibility, which Tinfoil's releases share), and the floor is recorded as the caller's, below ours. Offline on real bytes
(`test/fixtures/verifier/tinfoil-router/`, pinned with their sources): the 2026-09-24 capture against Tinfoil's v0.0.154,
whose attested measurement is that capture's, is `agree` with our verdict `verified` and no omission; without the TCB
floor `agree-limited`; the newer v0.0.155 against the old capture `agree-refuse`; Tinfoil's bundle under OUR policy
`provenance-failed` (identity); a floor above the release `provenance-failed`. Live on 2026-09-25 (local run, read-only):
`agree`, ours `verified` with every check true, the reference accepting the report and the certificate binding, the same
measurement, matched v0.0.155. This is evidence about the verifier's accepting path on live AMD hardware, never about an
Enclave host, and it does not satisfy the precondition that a host running OUR release verify end to end.

**The provenance paths were not compared.** `verifier/provenance-parity.mjs` runs daily as its own job: the Node consumer
against GitHub's signed index, the browser module from source and this commit's bundle against the relay mirror, the
bundle the SITE SERVES (its sha256 must be an artifact this repository built, a `MANIFEST.json` in its history, or it is
not executed) and that deployed bundle in the runner's Chrome on the live page. Each verifies for itself; the legs must
agree on the publication, the index digest, the releases and measurements and the floor; a mirror still serving an older
publication is `mirror-behind` within an hour of GitHub's and `mirror-stale` after. Offline tests
(`test/verifier-provenance-parity.test.mjs`, 4): agree; a one-byte-changed served bundle is `unknown-artifact` and not run;
a refused or down mirror `not-verified`; the CPU run's older index on the mirror `mirror-behind` then `mirror-stale`. Live
on 2026-09-25 (local run, Chromium): all five legs verified run 36089632273 with digest 9ef3346a..., floor v0.5.841 from
the signed index, v0.5.848 and v0.5.848-cpu allowed; the served bundle is this commit's.

What stays open, unchanged: a host running one of our releases verified end to end by the CLI, the self-check and the
relay; the 14-day windows; the TUF job's scheduled cycles; the independent review (M5). Tinfoil stays primary and every
strict switch stays off.

## 11. Open risks

- **Measurement semantics** stay Tinfoil-defined for the hosted fleet (section 2.3). Without archived image
  inputs a "verified" hosted enclave means "runs the image Tinfoil measured for our config".
- **Hosted binding format** is the shim's certificate format; if Tinfoil changes the SAN encoding the hosted
  rule breaks loudly (rejected, not green).
- **Sigstore root and Fulcio identity** depend on GitHub's OIDC and Sigstore's public-good instance;
  workflow-path identity is only as strong as tag/branch protection on the repository.
- **KDS rate limiting** (429 after a few requests) makes a cache or the auxblob mandatory for anything
  interactive.
- **Browser X.509**: decided and prototyped 2026-09-24 (`browser-x509-parser-decision.md`). The browser build is stricter than
  Node in three measured places (non-canonical DER, the PSS profile, the host rule), each a refusal; it judges SNP only.
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

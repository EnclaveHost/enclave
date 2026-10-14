# An Enclave-owned verifier: trust map, gap analysis, recommendation, rollout

Status: investigation, bounded proof of concept and production consumers, `verifier/` on main.
Written 2026-09-24 against main at fcb980c0 plus the feature branches named in section 2.6; brought in line with the code on
main at 949a2f4cd on 2026-10-14. Dated entries (sections 8.1 and 10.x) record what was measured on that date.

> **Status 2026-10-14.** What the verifier is and does today:
> - It is the only verifier on every client path. The CLI (`enclave attest`: `cli/enclave.mjs` -> `verifier/consumer.mjs`
>   `verifyMetalBox`) and the site's live verify (`site/js/core/verify.js` -> the same-origin bundle `/vendor/enclave-verifier.js`,
>   `verifier/web` `verifyMetalBoxWeb`) run this repository's code; no third-party verifier library, proxy or release format
>   is on either path.
> - `verifier/metal-box.mjs` verifies an attached metal SEV-SNP box through the relay (section 2.2): a fresh document over the
>   caller's own 32-byte nonce (`GET <api>/v1/enclaves/<name>/attestation?nonce=`), `report_data[0:32]` = sha256(transport
>   SPKI || nonce), the AMD chain to the pinned ARK, the CRL, the published TCB floors (Genoa, Turin), the guest policy (no
>   DEBUG, no MIGRATE_MA) and VMPL 0.
> - The launch measurement is held to a caller pin (`--expect`; the outcome can be `verified`) or to the relay operator's
>   allowlist (`METAL_ALLOWED_MEASUREMENTS`), which carries the omission `expected-measurement-operator-stated` and is never
>   better than `limited`.
> - The site takes AMD collateral through the relay's KDS mirror (`GET <api>/v1/amd-kds/...`): bytes only, each piece judged
>   in the browser against the pinned roots. The CLI takes it from AMD KDS, or from disk with `--collateral-dir`.
> - Unchanged beside it: the domain, pVM, Linux-tier, Hyper-V and NucBox paths, the admission gate, the sealed stream, the
>   envelope registry, the collateral adapters and their cache, the Node bundle (vendored for the relay at `relay/vendor/`)
>   and the web bundle.
> - REMOVED from the code on 2026-10-14, and their sections from this document: a third-party hosted provider's document
>   format (its predicates are now unknown formats, i.e. `unsupported`) and verifier library, the certificate-window
>   freshness rule in admission, release provenance, the signed release index and its memory, the TUF refresh of the
>   Sigstore root, the same-origin release mirror, the live and provenance differentials, the web shadow adapter, relay
>   re-verification of dialed rows, and the supervisor self-check (`verification.selfCheck` reads `not-run`). Releases are
>   `vX.Y.Z-cpu` tags cut by `.github/workflows/release-cpu.yml`, which builds the supervisor image and then creates the tag
>   and the GitHub Release, with no measurement step (section 2.3).

## 0. Summary

"Verified" on a client path today means: this repository's verifier, run by the client (CLI or browser), challenged an
attached SEV-SNP box with the client's own nonce through the relay, and the box's report is AMD-signed to a pinned root,
unrevoked, at or above the published TCB floor, refuses DEBUG and migration at VMPL 0, binds the box's transport key together
with that nonce, and carries a launch measurement the client pinned. The same report matched only against the relay
operator's allowlist is `limited`, never `verified`. The relay, metal and isolation paths verify SEV-SNP first-party as
before (`relay/snp-verify.mjs` at attach, the vendored bundle for per-app guests' release documents).

Recommendation, written on 2026-09-24 and built since: **option B, own the orchestration and formats, keep audited
primitives**, seeded from the existing first-party code. Concretely: one evidence envelope with a closed format registry,
one verdict model with `verified | limited | rejected | unsupported`, an explicit policy object (pinned roots, product lines,
TCB floors, VMPL, policy bits, binding rule per format, collateral freshness), and collateral that is verifiable from any
source because everything chains to a pin. Cryptography and X.509 parsing come from Node's crypto, WebCrypto and a reviewed
library (`@freedomofpress/sigstore-browser`'s `X509Certificate` in the browser). No cryptographic primitive is invented, and
no new mandatory service is introduced: the verifier runs in the client (browser, CLI) and in the relay for the relay's own
decisions, and the relay's KDS mirror is an optional cache of AMD-signed data.

The proof of concept (section 8) verifies authentic Genoa and Turin evidence offline and exercises adversarial mutations of
every input independently; the browser build is held to the Node build verdict for verdict.

## 1. Scope and terms

- **Evidence**: bytes a client obtains from the party being verified (report, certificate, document).
- **Collateral**: vendor-published data needed to judge evidence (AMD ARK/ASK/VCEK/CRL, Google attestation
  roots, Intel PCS data, NVIDIA RIMs). Public, signed, cacheable.
- **Policy**: what the verifier's operator or user decided to accept. Never learned from the server.
- **Verdict**: `verified` (admission-safe: every security check passed and the policy omitted nothing),
  `limited` (every cryptographic check passed but the policy explicitly skipped a security check, or the
  report version's semantics are unimplemented; the omissions are listed; never admission-safe), `rejected`
  (a check failed), `unsupported` (the evidence class or version is not implemented; never green). Each
  carries reasons, per-check results (`true`, `false`, or `null` for not judged) and the authenticated claims.
  A research policy (no TCB floor, `crl: none`, no nonce, an unjudged report version) can therefore be run
  and inspected, but its best outcome is `limited`, and `status === "verified"` is the only outcome a consumer
  may treat as acceptance.
- Dependency classes, kept separate throughout: **library** (code we run), **network service** (a host we
  fetch from at verification time), **release format and build toolchain** (who defines what a
  "measurement of our release" is), **hardware root** (whose signing key ends the chain), **deployment
  operator** (who runs the machine and the ingress).

## 2. Current trust and dependency map

### 2.1 Consumers of verification and what each trusts

| consumer | code | library | network services on the verification path | measurement expectation | hardware root | operator |
|---|---|---|---|---|---|---|
| Browser live verify | `site/js/core/verify.js` -> `/vendor/enclave-verifier.js` (`verifier/web` `verifyMetalBoxWeb`, built by `scripts/build-vendor.mjs`, sha256 in `verifier/web/dist/MANIFEST.json`) | this repository's verifier; `@freedomofpress/sigstore-browser` 0.1.14 `X509Certificate` over `@freedomofpress/crypto-browser` 0.1.7 (Apache-2.0) for X.509 structure; WebCrypto for every signature | the relay (`api.enclave.host`): the fresh document (`/v1/enclaves/<name>/attestation?nonce=`) and AMD collateral through its KDS mirror (`/v1/amd-kds/...`) | the relay operator's allowlist, labelled: `limited` at best | Milan/Genoa/Turin ARKs pinned by sha256 in the bundle | the box's seller; the relay forwards |
| CLI `enclave attest` | `cli/enclave.mjs` -> `verifier/consumer.mjs` `verifyMetalBox` | this repository's verifier (node:crypto) | the relay for the fresh document; `kdsintf.amd.com` directly, or `--collateral-dir` | `--expect HEX[,HEX]` (a caller pin; `verified` possible) or the operator's allowlist (`limited`) | same pins | same |
| Supervisor `verification` block | `supervisor.js` `getMeasurements` | none | n/a | n/a | n/a | publishes no verdict: `verification.selfCheck.result` is `not-run`, beside pointers to the client paths |
| MCP / docs | `relay/mcp.js`, `site/components/attest-chain` | text pointers only | n/a | n/a | n/a | n/a |
| Relay attach gate (permissionless sellers) | `relay/tunnel.js` -> `relay/snp-verify.mjs` | none (node:crypto) | `kdsintf.amd.com` directly (or the report's own cert table) | `METAL_ALLOWED_MEASUREMENTS` env allowlist, `METAL_MIN_TCB` env | Milan/Genoa/Turin ARKs pinned by sha256, corroborated against go-sev-guest | the seller |
| Relay release judgement (per-app SNP guests) | `relay/secrets-release.mjs` -> `relay/vendor/enclave-verifier-node.mjs` `verifyGuestDomainEvidence` | the vendored Node bundle | AMD KDS through the bundle's authenticated disk cache (`RELAY_VERIFIER_CACHE_DIR`) | an admitted domain release's runtime and measurement pairs; binding, AppID and HOST_DATA = the deployment | same pins | the lease holder |
| Metal buyer tool | `metal/verify.mjs` | none | `kdsintf.amd.com` | local `metal/dist/manifest.json` from `sev-snp-measure` | same pins | the seller |
| Isolation judge (M2..M4) | `isolation/m2/judge.mjs` | none | KDS or `--no-kds` | `--measurement` on the command line | same pins | the lab |
| Android pVM attach | `relay/avf-verify.mjs`, branch `relay/pvm-app-attest.mjs` | none | none at verify time | APK code hash + signer hash policy from env | Google attestation roots pinned (2 fingerprints) | the phone owner |
| Windows VBS attach | `relay/vbs-verify.mjs` | none | none at verify time | enclave identity policy from env | AMD fTPM EK root pinned | the node owner |
| Windows partition (T0-hv) | launcher-only: `windows/vbslike/verify/judge-hv.mjs`; with the guest VBS report (since 2026-09-29): `relay/shield-app-policy.mjs` -> `relay/vbs-app-verify.mjs`, also called by `verifier/hyperv.mjs` | none | none | launcher-only: launcher key; VBS report: image/runtime pairs and EK/PCR0 platform pairs in the Shield app policy | launcher-only: none (no hardware root); VBS report: AMD fTPM EK root pinned, the boot's VSM IDKS key from the quoted log; `hostExcluded=false` either way | the node owner |
| GPU (NVIDIA CC) | `supervisor.js getMeasurements` publishes the NVML report and a pointer to NRAS/nvtrust on a GPU build only (the GPU flavors were removed on 2026-10-14) | none | n/a | n/a | not verified first-party anywhere | n/a |
| Intel TDX | `supervisor.js parseTdxQuote` | parse only | n/a | n/a | not verified anywhere | n/a |

Where to read each: `verifier/metal-box.mjs` (the client flow), `verifier/consumer.mjs` (the Node entry points),
`verifier/web/index.mjs` (`verifyMetalBoxWeb`, `KDS_MIRROR_PATH`), `site/js/core/verify.js` (`LV_VERIFIER_URL`),
`cli/enclave.mjs` (`attest`), `relay/api-relay.js` (`METAL_ALLOWED_MEASUREMENTS`, `METAL_MIN_TCB`, the `/v1/amd-kds/` route,
`guestVerifier`, `computeEligible`: dialed rows trust their own `availability.teeCpu`), `relay/tunnel.js` (formats
`sev-snp-guest*`, `android-avf-pvm/v1`, pad v2, `windows-vbs-enclave/v1`).

### 2.2 The metal box flow (`verifier/metal-box.mjs`, the CLI and the site)

One environment-free function, `verifyMetalBoxWith`, carries the rules; `verifyMetalBox` (Node) and `verifyMetalBoxWeb`
(browser) supply fetch, randomness, the SNP verdict and the collateral.

1. **Freshness.** The client draws 32 random bytes and asks the relay for the box's document
   (`GET <api>/v1/enclaves/<name>/attestation?nonce=<hex>`); the relay forwards the nonce over the box's tunnel and returns
   the box's `sev-snp-guest-metal-v1` document verbatim. An answer for another nonce, a non-metal document, an HTTP error or
   more than 512 KiB is `unavailable`, never a verdict. `report_data[0:32]` must equal sha256(the document's transport SPKI ||
   the client's nonce).
2. **Genuineness.** The report is judged by `verifier/snp.mjs`: VCEK from the box's own certificate table (`certs`) or AMD
   KDS (the site: the relay's KDS mirror), chained to the pinned ARK, ASK serial against the ARK-signed CRL, DEBUG and
   MIGRATE_MA refused, VMPL 0, and the reported and committed TCB at or above `TCB_FLOORS` (Genoa: bootloader 10, tee 0, snp
   23, microcode 84; Turin, metal0's reported TCB on 2026-10-14: fmc 1, bootloader 3, tee 2, snp 5, microcode 117). A
   product line with no floor stays `limited`; `--min-tcb` overrides the floor in the CLI.
3. **What runs.** The launch measurement must be one the client expects. A caller pin (`expected.measurements`, the CLI's
   `--expect`) is the policy and a clean verdict is `verified`. Without one the relay's admitted list
   (`METAL_ALLOWED_MEASUREMENTS`, returned beside the document) is used and the result carries the omission
   `expected-measurement-operator-stated`, so it is `limited`: an operator vouching for its own box is not an independent
   expectation.

The relay is trusted for neither 1 nor 2: it can withhold or delay a document, not forge one. The request's TLS ends at the
relay; the key the report binds is the box's transport key, which the result names (`transportKeySha256`) for an
end-to-end channel. The CLI exits 0 for `verified`, 3 for `limited`, 1 otherwise; with no id it challenges every attested
SEV-SNP box the relay holds, with a deployment id it resolves the box from the deployment's attestation pointer, and a
deployment on an Enclave Shield host is `unsupported` (its evidence is host-attested, not an SNP report).

### 2.3 What the release actually is

`.github/workflows/release-cpu.yml` (dispatched by `deploy.yml` with the next `vX.Y.Z-cpu` version, or by hand) builds
`ghcr.io/enclavehost/enclave-supervisor:<tag>`, then creates the git tag on the commit the image was built from and a GitHub
Release named by it; `enclaves/cpu/config.yml` at the tag carries the supervisor environment and the wasm-manager pin. No
release asset is read by anything, and no measurement is computed or signed in CI: `metal/update.mjs` on each box takes
the newest `-cpu` tag and runs `metal/build-image.mjs` at it on the host, which pulls that image and, where
`sev-snp-measure` is installed, records the launch measurement in `metal/dist/manifest.json` (the input `metal/verify.mjs`
uses).

So a client has no signed release measurement to compare with: the measurement's meaning rests on the box's own build, and
the expectation is either one the client reproduced or trusts (`--expect`) or the operator's allowlist, labelled. An
independent expectation needs a client-side reproduction of the image from the tag's inputs; it is not built.

### 2.4 Network services, and what each actually is

| host | operated by | content | replaceable by | consequence if it lies or is down |
|---|---|---|---|---|
| `api.enclave.host` (the relay) | Enclave | the fresh document: the client's nonce forwarded over the box's tunnel, the box's answer returned verbatim with the operator's allowlist beside it; the KDS mirror `/v1/amd-kds/vcek/v1/{Milan,Genoa,Turin}/{cert_chain,crl,<hwID>}` (cached, rate-limited per client IP) | for the document, none: the relay holds the box's tunnel; for collateral, KDS directly, the box's own certificate table, a disk cache | lie: cannot forge a report (the client's nonce, the pinned ARK) or collateral (everything chains to the pin); can withhold or delay, and states the allowlist, which is labelled `limited`; down: no fresh document |
| `kdsintf.amd.com` | AMD | VCEK, cert_chain, CRL | the relay's mirror, the report's certificate table, `verifier/collateral-cache.mjs`, `--collateral-dir` | lie: cannot forge; down or 429: no chain unless cached |
| the box | its seller (metal agent) / domain front | the document | none: this is the evidence | n/a |

### 2.5 Evidence classes and the binding rule each uses

| format string | technology | `report_data[0:32]` | `[32:64]` | freshness | first-party verifier today |
|---|---|---|---|---|---|
| `sev-snp-guest-metal-v1` | SNP, metal | sha256(SPKI || nonce) with a nonce; sha256(SPKI) without one (`freshness-unbound`, `limited`) | zero | the client's nonce on the fresh document; the relay's nonce per attach | `verifier/metal-box.mjs` over `verifier/snp.mjs`; `relay/snp-verify.mjs` (attach), `metal/verify.mjs` |
| `sev-snp-guest-domain-v1` | SNP, isolation | ABI/1 sha256(SPKI || nonce); ABI/2 `Bind2` = sha256("enclave-bind-v2\n" || SPKI || nonce || RuntimeID) | AppID from the monitor | verifier nonce (a release document binds the relay's ticket instead) | `verifier/snp.mjs` (+ HOST_DATA, section 10.3), the relay's release judgement, `isolation/m2/judge.mjs` |
| `hyperv-partition-domain/v1` | Hyper-V partition (T0-hv, host not excluded) | same as domain; with `vbsVmReport`, the paravisor's VBS report carries `Bind2 || AppID` as its 64 bytes of guest input | AppID | verifier nonce, plus the caller's own host TPM session (nonce + minted credential) | launcher-only: `windows/vbslike/verify/judge-hv.mjs` (launcher signature, no hardware); with `vbsVmReport`: `relay/shield-app-policy.mjs`, called by `verifier/hyperv.mjs` |
| `android-avf-pvm/v1`, pad v2, ABI/2 app | AVF | sha256(transcript) as the AVF challenge; ABI/2: `Bind2 || AppID` (64 bytes) | n/a | relay nonce | `relay/avf-verify.mjs`, `relay/pvm-app-attest.mjs` (branch) |
| `windows-vbs-enclave/v1` | VBS enclave + TPM | `EnclaveData` = sha256(bound transcript) | n/a | relay nonce + TPM quote nonce | `relay/vbs-verify.mjs` |
| `tdx-guest-metal-v1` | TDX | as metal | zero | as metal | **none** (parse only) |
| `dev-unattested-metal-v1` | none | n/a | n/a | n/a | must be refused (`metal/verify.mjs` exits 1) |
| NVIDIA CC report | GPU | NVML nonce | n/a | owner nonce | **none** |
| anything else | | | | | `unsupported`, never green |

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

Judged against the required properties, for `relay/snp-verify.mjs` (R), `metal/verify.mjs` (M) and `isolation/m2/judge.mjs`
(J) as they stood on 2026-09-24, with what `verifier/` does today in the last column.

| property | R | M | J | `verifier/` today |
|---|---|---|---|---|
| signature chain to pinned roots | yes: sha256 pins for three lines, chain from KDS or auxblob | yes (same pins) | via R | the same pins, plus certificate validity windows, ASK subject/CN checks, and VLEK refused explicitly |
| platform and TCB policy | caller `minTcb` on reported TCB, per-product layouts; no floor built in | `--min-tcb` | `--min-tcb` | a policy object with floors for reported **and** committed TCB, a product allowlist, firmware floors as an option; published floors for the metal box flow (section 2.2) |
| debug / VMPL / configuration | DEBUG, MIGRATE_MA refused; VMPL pinned (default 0) | same | same + boundary tuple above VMPL0 | SMT, single-socket, CXL, RAPL, ciphertext hiding exported as claims; the policy chooses which are required |
| nonce and replay / freshness | challenge bound into `report_data` | key-only or challenge | nonce | a per-format freshness rule stated in the verdict; no nonce is the omission `freshness-unbound` (`limited`) |
| measured workload / app / runtime identity, ABI/2 | measurement allowlist from env; ABI/2 only on the branch | manifest measurement | measurement + AppID + ABI/2 (branch) | the allowlist is a caller input (a pin, or the operator's allowlist labelled as such); app id, Bind2 and HOST_DATA as explicit inputs |
| TLS / transport key binding | SPKI from the handshake | served key | handshake SPKI | the SPKI of the verifier's own handshake, or, through the relay, the document's transport key bound together with the verifier's nonce |
| release / build provenance against a trusted policy | none | none | none | none: CPU releases carry no signed measurement (section 2.3) |
| reject malformed / truncated / replayed / substituted / unknown / missing | bounded KDS fetch, length check `>= 0x330`, unknown format -> deny | exits on unknown format | reject | strict envelope (exact report length, base64 strictness, no gzip, size caps), explicit `unsupported` verdict class |
| separation of evidence classes | tunnel dispatches by format string | SNP only | SNP | one registry; TDX, GPU, unknown -> `unsupported`; dev formats -> `rejected` |
| key rotation / revocation / collateral expiry | VCEK cached per URL; no CRL; ARK pins only | no CRL | no CRL | CRL parsed and ARK-signed, ASK serial checked, `nextUpdate` as the collateral clock, VCEK cached by public key not bytes (KDS re-signs: fixture shows two valid certs for one key) |
| rollback | none (env allowlist) | none | none | bounded by the expectation only: a caller pin, or whatever the operator's allowlist still admits |
| offline verification | `kds:false` + `seedCertChain` | no | `--no-kds` | an offline collateral store is the default in tests; network sources are adapters |
| browser | no (node:crypto) | no | no | WebCrypto + a browser X.509 parser (section 4): `verifier/web` |
| relay-side re-verification of dialed rows | no (`teeCpu` self-reported) | n/a | n/a | not done: dialed rows' `teeCpu` stays self-reported |
| self-check as diagnostic | n/a | n/a | n/a | the supervisor runs none: `verification.selfCheck` is `not-run` |

Smaller findings recorded while reading: the comment in `relay/snp-verify.mjs:76-79` names
`verify/trust/ask_ark_*.pem` which does not exist on main (the chains are `test/fixtures/amd/*-cert_chain.pem`);
`metal/verify.mjs` builds its own `parseReport` beside the imported one; `parseSnpReport` accepts any length
`>= 0x330` while the ABI fixes the report at 0x4a0.

## 4. Options

| | A. extend the existing verifier | B. own orchestration and formats, keep audited primitives | C. from scratch |
|---|---|---|---|
| what it is | grow `relay/snp-verify.mjs` + `metal/verify.mjs` + `judge.mjs` in place, add a browser build | a `verifier/` package: envelope, policy, verdict, per-format binding, collateral adapters; primitives from node:crypto / WebCrypto / a reviewed X.509 library; R's checked functions imported, not copied | new parsers for X.509, DER, PKCS |
| crypto risk | low (node:crypto) but browser needs a rewrite anyway | low: reviewed libraries for everything with a spec | high: exactly what "do not invent primitives" forbids |
| browser | not without restructuring (node-only APIs throughout) | designed for it: pure functions over bytes, crypto injected | yes |
| effort to a first working build | 3-4 weeks | 2-3 weeks (prototype exists) | 8+ weeks |
| reviewability | mixed concerns (relay attach, CLI printing) | one package with one verdict type and fixtures | large surface |
| chosen | as the seed | **yes** | no |

Libraries kept (versions verified in `node_modules` on 2026-09-24): `@freedomofpress/sigstore-browser` 0.1.14 (LICENSE file
Apache-2.0, package.json says MIT), used for its `X509Certificate` only, over `@freedomofpress/crypto-browser` 0.1.7;
`@noble/hashes`/`@noble/curves` (MIT, already dependencies) only if WebCrypto lacks an algorithm. For X.509 in the browser:
DECIDED 2026-09-24 (`browser-x509-parser-decision.md`): `@freedomofpress/sigstore-browser`'s `X509Certificate` for
structured access, `verifier/der.mjs` for the compared and signed bytes, WebCrypto for every signature, with AMD's PSS
profile checked from the certificate's own AlgorithmIdentifier bytes; `@peculiar/x509` and `pkijs` measured and declined.
AMD report parsing stays ours: fixed offsets from the ABI specification, cross-checked against go-sev-guest's layout,
tested on authentic v3 and v5 reports.

## 5. External roots and collateral: what remains necessary, what can be mirrored, what offline means

| root or collateral | necessary? | mirror / cache | freshness rule | offline |
|---|---|---|---|---|
| AMD ARK + ASK (Milan, Genoa, Turin) | yes, the hardware root | pinned by sha256 in code and shipped as PEM; refreshed only by a reviewed repository change; corroborated against go-sev-guest (re-done 2026-09-24, all three match) | ASK rotation shows up in the CRL (Genoa revoked serial 020001 on 2022-10-31) and as a new `cert_chain`; an unpinned root fails closed | yes |
| VCEK | yes, per chip and TCB | cache by (product, chip id, TCB) -> public key; any source is acceptable because the chain and the extension match decide (the relay's KDS mirror, a disk cache); the report's own certificate table (metal, domains) needs no network at all | no expiry semantics of its own (KDS re-signs on request; two valid certificates for the same key are in the fixtures) | yes with a cache or the auxblob |
| AMD CRL | yes for ASK revocation (VCEK serials are all 00) | fetch per product (KDS or the relay's mirror), ARK-signed, ~6-week `nextUpdate` | policy `crl: required` refuses past `nextUpdate`; `crl: stale-ok <days>` verifies with a stated warning; `none` says so in the verdict | yes within `nextUpdate` |
| Google attestation roots | yes for AVF | pinned (2 fingerprints), source `android.googleapis.com/attestation/root` | rotation by reviewed change | yes |
| AMD fTPM EK root | yes for VBS | pinned | same | yes |
| Intel SGX Root CA + PCS (TDX) | when TDX is supported | PCS data is signed and cacheable (`tcbinfo`, `qeidentity`, PCK CRLs) | TCB info has `nextUpdate` | yes within `nextUpdate` |
| NVIDIA device CA + RIMs (GPU) | when GPU evidence is verified | RIM bundles are signed and cacheable; NRAS is optional | RIM validity | yes with cached RIMs |

**Guarantees this buys.** With a warm cache (chains, CRLs within `nextUpdate`, VCEKs), a client verifies with **zero**
network calls beyond the box's document, and the verdict states which collateral was stale.

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
the isolation front, the relay's AVF and VBS handling, the Hyper-V judge). The metal and domain documents are open because
they carry unsigned informational fields that evolve, but are bounded and every declared field is validated when present;
AVF v2 requires the pad key its transcript binds. `parseEnvelope` enforces this before any cryptography and the verdict for
a malformed shape is rejected. The relay's KDS mirror changes no trust: it serves AMD's bytes, and a client accepts them only
through the chain to its own pinned ARK, so a client that wants to trust nothing but the silicon vendor can.

## 6. Required properties, and how the design meets each

1. **Signed quote and certificate chain against pinned roots.** Root fingerprint pinned per product line;
   ARK self-signature, ASK by ARK, VCEK by ASK (RSA-PSS SHA-384), validity windows at the verifier's
   clock, ASK serial not on the ARK-signed CRL, product line from the report's CPUID (v3+) must equal the
   chain that verified, VCEK extensions must equal the report's chip id and reported TCB.
2. **Platform and TCB policy.** Explicit floors per product for reported and committed TCB; optional firmware
   build/version floors; DEBUG and MIGRATE_MA always refused; SMT, single-socket, CXL, RAPL, ciphertext
   hiding exported as claims and required only when the policy says so; VMPL equal to the expected level.
3. **Nonce, replay and freshness.** Formats with a nonce bind it in `report_data[0:32]`; the verifier only
   ever compares against a nonce **it** chose. A document without one proves key possession at attest time only: the
   verdict carries the omission `freshness-unbound` and is `limited` at best. A verifier keeps no server-side replay
   state because the nonce makes replay impossible by construction.
4. **Measured workload, app, runtime identity, ABI/2.** The measurement allowlist is a client input: a measurement the
   client pinned, or the relay operator's allowlist under the omission `expected-measurement-operator-stated` (never
   `verified`); the app id is an expected input compared to `report_data[32:64]`; ABI/2 bindings are computed by the
   contract's own `runtime.mjs` and passed in as bytes (identical to the branch's `expectedBinding`); a document that
   states ABI/1 when ABI/2 was expected is rejected (no silent downgrade).
5. **TLS / transport-key binding.** The SPKI comes from the verifier's own handshake, never from a third party's
   restatement; through the relay, the box's document names its transport key and the report binds it together with the
   verifier's nonce: metal sha256(SPKI || nonce), domain sha256(SPKI || nonce) or Bind2.
6. **Release provenance.** Not judged: CPU releases carry no signed measurement (section 2.3), so the measurement's
   meaning rests on the expectation of item 4.
7. **Reject malformed, truncated, replayed, substituted, unknown, missing.** Envelope: exact lengths, strict
   base64, no gzip body, size caps, closed format registry; parser: MBZ ranges that are
   reserved in every ABI version, signer type, signature algorithm; unknown format -> `unsupported`; dev
   formats -> `rejected`; missing context (no SPKI, no nonce where required) -> `rejected`. A report version
   whose fields the verifier has not implemented (version 6, ABI Rev 1.59, ETCB fields at 0x220..0x280) is
   `unsupported` by default, before any collateral or signature work; the judged range is versions 2..5.
   Structurally parsed but unjudged semantics never count as verified (independent review, 2026-09-24).
8. **Separate evidence classes.** One dispatcher: SNP (metal and domain), TDX (`unsupported` until a QVL-grade
   implementation is chosen), AVF (delegates to `relay/avf-verify.mjs` and the pVM ABI/2 module), VBS +
   Enclave Shield (delegates; tier `vbs-dev` never reads as verified; a CPU verdict never implies GPU
   protection), GPU (`unsupported` until NVIDIA evidence is verified first-party), Hyper-V T0-hv (launcher
   signature, `hostExcluded=false` always).
9. **Key rotation, revocation, rollback, offline.** Section 5. Additionally: every client verification is a fresh document
   over a fresh nonce, so a rotated transport key is simply the key the next document binds (the supervisor still
   reports `observedTlsKeyFingerprint` beside the attested one); rollback to an older genuine measurement is bounded only
   by the expectation (section 3).
10. **Box and gateway statements are diagnostics.** The supervisor publishes no verdict (`verification.selfCheck.result` is
    `not-run`); a relay's statements (its allowlist, its attach verdict) are displayed and labelled, never used as the
    client's verdict.

## 7. What must never happen (anti-goals, checked in tests)

- A green verdict for an evidence class the verifier does not implement.
- A measurement accepted because the server said which repo or which release to compare against.
- A measurement matched only by the relay operator's allowlist reading as `verified`.
- A chain accepted because it is self-consistent (any root that is not the pin fails).
- A binding skipped because context was missing.
- A `vbs-dev` or dev-unattested document reading as attested.
- A GPU claim derived from a CPU verdict.

## 8. Proof of concept (deliverable 2)

Location: `verifier/` and `test/verifier-*.test.mjs`; fixtures `test/fixtures/verifier/` (sources, capture times and hashes
in `SOURCES.json`). First built at 6db627e4 (fixtures 7d70de94) on `research/independent-verifier`, touching nothing outside
`verifier/`, `test/` and `docs/security/`; the production consumers came later (section 10.4). Not in scope: TDX, GPU.

| module | what it owns | primitives it reuses |
|---|---|---|
| `verifier/envelope.mjs` | the closed format registry (section 2.5), strict base64, no gzip body, size caps, per-format shapes, `unsupported` vs `rejected` | none |
| `verifier/snp.mjs` | strict 0x4a0-byte parser with the ABI's must-be-zero ranges (version-aware: MIT vectors from v4, ETCB in v6), VCEK-only signer, P-384 r/s range, chain VCEK -> ASK -> pinned ARK with subject CNs and validity windows, ARK-signed CRL (ASK serial, `nextUpdate` policy), floors on reported and committed TCB, firmware floors, guest-policy bits, VMPL, measurement allowlist, binding rule per format, HOST_DATA, one verdict | `relay/snp-verify.mjs` (`AMD_ARK_SHA256`, `decodeTcb`, `TCB_FIELDS`, `snpProductHint`, `kdsVcekUrl`, `vcekMatchesReport`, `checkMinTcb`), node:crypto |
| `verifier/der.mjs` | a bounded DER reader for the CRL and a certificate's subject Name | none |
| `verifier/tls-binding.mjs` | the SPKI a verifier binds, and its hash | node:crypto X509Certificate |
| `verifier/collateral.mjs`, `verifier/collateral-cache.mjs` | file, memory, HTTP (AMD KDS or any mirror) and layered adapters with the same shape, source and fetch time reported; the authenticated disk cache (section 5) | fetch |
| `verifier/index.mjs` | dispatch by technology; the verdict shape (`status`, `admissionSafe`, `omissions`, per-check `true/false/null`); AVF delegates to `relay/avf-verify.mjs` and requires the attested key's signature; the pVM ABI/2 module is imported when present; TDX, VBS, Hyper-V, GPU are `unsupported` with the pointer to their verifier | |
| `verifier/metal-box.mjs`, `verifier/consumer.mjs` | the metal box flow (section 2.2) and the Node entry points (section 10.4) | |
| `verifier/web/` | the browser build: the same `snp.mjs` behind a WebCrypto provider, `verifyMetalBoxWeb`, collateral through the relay's KDS mirror | WebCrypto, `@freedomofpress/sigstore-browser` `X509Certificate` |
| `verifier/cli.mjs` | `verify`: a saved document judged offline against explicit expectations and collateral; `--admit` runs the consumer gate | |

What each suite proves (all offline, all on authentic bytes unless the case is a mutation of them):

| suite | passing means |
|---|---|
| `verifier-fail-closed` (9) | the status is derived from the omission list (any omission -> `limited`); report version 6 is `unsupported` before any collateral work and, under the research policy, `limited` at best even when signature, chain, CRL and binding all pass (shown on a synthetic version-6 report); the authentic v3 and v5 paths still verify with nothing omitted; each policy relaxation (no TCB floor, `crl: none`) is an omission that caps the verdict; on a synthetic AMD-shaped chain (own ARK/ASK/VCEK/CRL, pinned by the test and refused by the real pin) the metal format verifies with a nonce, is `limited` without one, refuses a replay, and the domain ABI/1 branch binds the nonce and app id |
| `verifier-snp-genoa` (16) | the genuine Genoa capture (`test/helpers/genoa-capture.mjs`), presented as an ABI/2 domain document whose caller-supplied binding and app id are the report's own `report_data`, verifies to AMD's pinned root with a TCB floor (without the floor the verdict is `limited`, not `verified`); a KDS re-issue of the same VCEK verifies identically (collateral source is irrelevant); with a floor the reported and committed TCB are judged; each of signature (r, s, signed region, out-of-range r), root (Milan or Turin chain under the Genoa name, no pin), VCEK (other chip, none), TCB edit, measurement (other, none), report_data (another binding, another app, no key, an edited field), DEBUG, MIGRATE_MA, VMPL, SMT policy, shape (truncated, padded, zero, version 1, VLEK signer, reserved bytes, signature tail), CRL (stale under each mode, missing, foreign issuer, tampered), revocation (an ASK with the Genoa CRL's revoked serial) and certificate windows is refused on its own |
| `verifier-snp-turin` (7) | the M4a v5 document verifies with the Turin TCB layout, ABI/2 binding and app id; another runtime identity, nonce, key or app changes the binding; ABI/2 to ABI/1 downgrade in either direction is refused; FMC floors are judged; Genoa's chain or VCEK do not verify it; a fresh nonce refuses the replayed report; any flipped byte refuses |
| `verifier-metal-box` (5) | with a recording stand-in for the verdict: the client's nonce reaches the relay and the verdict's binding, the transport key and the box's VCEK table come from the document; a measurement matched only by the operator's allowlist is `limited` with the named omission; a caller pin with a clean verdict is `verified`; a refusal stays a refusal with its failed checks; another nonce, a non-metal document, an HTTP error or a bad name is `unavailable` |
| `verifier-web-differential` (3) | the browser build equals the Node build verdict for verdict (status, omissions, checks, claims, reasons) over the mutation matrix of the SNP suites and envelope-level cases |
| `verifier-abi2-contract`, `verifier-pvm-abi2` | skip on main; on the feature branches they check the ABI/2 test vector against `isolation/contract/runtime.mjs` and judge the real Pixel captures through `relay/pvm-app-attest.mjs` |

Review correction (2026-09-24): the first cut let a version-6 report reach `verified` with a note, and let
policy relaxations reach `verified` with warnings. Both are closed: `verified` is now derived from an empty
omission list, every relaxation is an omission, and an unjudged report version is `unsupported` by default
(`limited` at most under an explicit research flag). The CLI exits 0 only for `verified`, 4 for `limited`.

### 8.1 Consumer admission gate and the pVM evidence adapter (bounded consumer integration, 2026-09-24)

`verifier/admission.mjs` is the one function that may release a client request. It releases only when the
verdict is `verified`, `admissionSafe`, has an empty omission list and every check `true`; when every
expectation was supplied by the client and matches the claims (SNP: allowed measurements the client holds, a
TCB floor, the root pin for the product the chain proved, the app id for a domain document; AVF/pVM: runtime
ids, APK code and authority hashes, root pins, app id); when freshness is the client's own single-use
32-byte challenge; and when the transport
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
| `verifier-admission` (7) | on the authentic Genoa verdict a native client releases only when its own peer key is the bound key, a browser client holds without an application-layer key and releases on one with TLS pinning explicitly not claimed; a `limited` verdict (no floor, no CRL) never releases; missing or mismatched client expectations (measurements, floor, root pins, wrong product pin) hold; on the authentic Turin ABI/2 verdict the nonce, app id and peer key are each required; the same nonce holds the second time; every non-verified or inconsistent verdict shape holds |
| `verifier-pvm-device` (11, skips without the owner's module) | on the two real Pixel 10 envelopes with client-held pins: both boots verify and release a native client on that boot's key only; a browser client holds on v1; replay of launch 1 against launch 2, a pasted nonce, a swapped key, a foreign chain, a fresh nonce over a genuine chain, wrong app/runtime/code hash/authority/root pins, empty pins, an expired or not-yet-valid leaf, stripped/extra fields, non-canonical base64 and another format each refuse |
| `verifier-sealed-stream` (12; the differential case runs under the strict command) | on the owner's sealed-stream fixture: the stream opens complete to the known plaintext however it is split, the ABORT variant is an authentic prefix; sequencing, replay, truncation, tamper, framing, trailing and cancellation attacks are refused with nothing released beyond the last authenticated chunk; the policy layer reads nothing unless the gate released a browser client with the pinned app key inside the window; the owner's reader agrees on accept/refuse and prefix for every case |
| `verifier-envelope` (11) | the registry refuses what it does not know or cannot judge (unknown, development, T0, TDX, VBS and Hyper-V formats never verified), malformed envelopes before any cryptography, and, since 2026-09-24, the per-format SHAPE: the body field's exact name with no alias (the domain and Hyper-V documents say `report`, the metal agent says `body`); the metal, domain and AVF documents open but bounded (at most 32 top-level fields and 1 MB) with every field the verifier reads declared and validated when present (transport keys strict base64 with caps, fingerprints, nonces and pad keys 64 lowercase hex, `abi` one of the two known values, `runtime` and `manifest` objects, strings capped), AVF v2 requiring its pad key; a malformed shape is rejected, never unsupported and never verified; the real domain document and an agent-shaped metal document parse |
| `verifier-pvm-policy-deployments` (4; the differential runs under the strict command) | the optional deployment table on 24 lab-signed vectors (absent; one, three and 64 entries; the table in another position; empty; 65; non-array; non-object entries; extra or missing keys; uppercase, unprefixed, short and long ids; an unadmitted or non-hex app; duplicate ids) accepted or refusing the whole policy as the contract says; selection by id, by id plus app, unknown, tableless (also with an app given), non-canonical, mismatched, empty and app-only; a lower serial remapping a deployment is a rollback, the same serial with another table equivocation, a stranger's table and a bare catalog object refused; the owner's pinned `trust.js` agrees on every vector and selection |
| `verifier-collateral-cache` (11) | the authenticated collateral cache: cold, warm and offline with the verdict naming each piece's source; a poisoned cached chain or VCEK and a tampered or sidecar-less CRL quarantined and refetched, and fail-closed when the upstream is down; a poisoned or garbage upstream answer refused and not cached; KDS 429 through the real http adapter (cold fails closed, warm never asks); an unwritable cache reported and never a false hit, a leftover temp file ignored; a stale cached CRL refreshed from the upstream; a stale CRL with no upstream served flagged so only the policy can accept it (required rejects, stale-ok limited within its bound, beyond it rejects); an authentic revoking CRL served and never hidden |
| `verifier-pvm-client-persistence` (8, black-box, own runner) | against the BUILT client with a fake carrier and a held evidence request as the barrier: an accepted serial is committed before the client acts and survives a kill, a rollback is then refused without a request; concurrent old/new serials in both orders never lose the newer one; equal serial with other bytes is refused (same bytes idempotent); a read-only store means nothing is sent; a corrupt state is fatal; an attacker policy plus a stall leaves no trace. Failed 7 of 8 on 0.1.0 (the reproduction); passes 11 of 11 on 0.2.0 |
| `verifier-pvm-client-ext` (5, real Chromium, strict command) | the SHIPPED 0.2.0 extension zip (pinned and reproduced), unzipped and loaded unpacked in Chrome for Testing 151 over the DevTools protocol, with the lab relay holding `/evidence` as the barrier: a stall then SIGKILL of the whole browser leaves the committed serial for the relaunch, which refuses a rollback without a request; the same with only the tab closed; two tabs holding old and new serials in both orders never lose the newer one; equal serial with other bytes is refused as equivocation and the same bytes again are acted on; the commit event precedes the evidence request; every outcome carries Chrome 151's user agent under the computed unpacked-extension id. The 0.1.0 zip runs the first case as the preserved old-client failure (old serial remains, the rollback is acted on). Negative control: the four 0.2.0 cases run against the 0.1.0 zip fail on `1 !== 2`, `1 !== 3`, `the old tab must be refused, not act` and `equivocation must be refused without acting on it`. Proves persistence across browser process death and tab close on this machine; whole-machine power loss is not proven by anything here |
| `verifier-pvm-client-supersede` (4, pinned 0.2.0 SOURCE, strict command) | the superseded-policy refusal at request release needs evidence that verifies, so the owner's `cli.mjs` runs from the pinned sources with ONE import replaced through a Node loader hook (`verifyPvmAppEvidence` as imported by `web/pvm-client.js`; the store, flow, gate and sealing are the owner's code): client A commits serial 5 and waits on evidence, client B commits 6, A's evidence is released and verifies, A refuses at the gate (`serial 5 was superseded by serial 6`) and sends no sealed request; the same under a key rotation; a control reaches the sealed request; the stub refuses an envelope for another nonce. A source-level result, not one against the built artifact |
| `verifier-pvm-client-update` (10, built CLI, strict command) | update manifests signed by the lab release key and countersigned by the lab policy key, artifact downloads held as barriers: a valid update stages its exact bytes and the state records it, tampered staged bytes are reported; a wrong countersignature, a stranger's release key and a non-newer version are refused with nothing on disk; two stagers of different versions in both completion orders (the older never replaces the newer); a policy-key rotation by signed `nextPolicyKey` after which the retired key's policies and a rollback under it are refused; a release-key rotation and a policy commit in both orders, neither losing the other's fields, then the successor signs and the retired key and a stranger do not; a storm of six concurrent updates and six policy commits ends at the highest version and serial with every loser refused by the monotonic rule and one generation per commit. Finding F2 (`verifier/integration/findings.json`, closed): the sequential and concurrent same-version re-stage cases require that a refused stager leaves the staged bytes untouched and that the state's digest and the file on disk never disagree; they failed on 6784f671 (strict verdict NOT ACCEPTED, exit 3) and pass on the owner's 0.2.1 fix e7a2badc, now the pin; the same artifact again is idempotent there (no generation, file untouched) and other bytes under another source commit are refused; the pre-fix build stays pinned as `pvm-client-dist-f2` with a regression fixture that requires the defect to reproduce there |
| `verifier-pvm-policy` (7) | on the seven real signed lab policies of the installed-client device run, from the run's anchor and rollback memory: genuine policies accepted in order, the attacker's refused (and genuine only under the attacker's own anchor), rollback, equivocation and the install floor refused, root narrowing that excludes the device's root accepted as a policy, the kill switch disables the old client, a non-admitting policy yields no expectations, a genuine policy's expectations are what the gate takes, and every forgery of bytes, signature, shape or window refuses; each outcome equals the device's |
| `verifier-admission-vectors` (3) | `verifier/admission-vectors.json` is the gate's rule as data: 49 deterministic cases (metal, domain ABI/2, pVM v1, v2 and v3 verdicts; native and browser clients; every expectation, omission, verdict-shape and nonce-reuse hold) replay through the gate with the same decision and reason, the file has not drifted from the generator, and exactly eight cases release; another implementation of the client's release decision is held to this file |
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
MIT vectors at 0x1f8 that a "reserved must be zero" parser written against version 3 would refuse.

## 9. Rollout

The staged plan of 2026-09-24 (shadow runs beside the previous hosted platform's verifier in CI, the self-check, the CLI and
the browser, then a per-consumer cutover after four weeks without unexplained divergence) ended on 2026-10-14, when that
platform and its verifier were dropped: this verifier became the only one on every client path at once, with no fallback
flag. What stands:

1. **CLI** (`enclave attest`): this verifier decides; exit 0 `verified`, 3 `limited`, 1 otherwise.
2. **Browser**: the site's live verify runs the same-origin bundle and shows its verdict, `limited` at best while its
   expectation is the operator's allowlist.
3. **Consumer gate**: clients release requests only through `verifier/admission.mjs`; pVM evidence enters through the
   owner's `verifyPvmAppEvidence` behind the adapter; the gaps in section 8.1 are the remaining work.
4. **Relay**: permissionless attach keeps `relay/snp-verify.mjs` until the new module has replaced it behind the same
   tests, then `expectedBinding` and the pVM ABI/2 frame land with the isolation and pVM owners; per-app guests' release
   documents are judged by the vendored bundle (section 10.4); dialed rows keep their self-reported `teeCpu`.
5. **Rollback**: a reviewed revert and a rebuild of the bundles (`verifier/node/build.mjs`, `verifier/web/build.mjs`,
   `scripts/build-vendor.mjs`); there is no second verifier to fall back to.

## 10. Effort and milestones (engineering days, one engineer, excluding review)

| milestone | content | days |
|---|---|---|
| M0 (done) | map, fixtures, SNP harness, CLI | done |
| M1 | strict envelope for every format in the registry (DONE 2026-09-24: per-format shapes), CRL policy modes (done), collateral adapters with a disk cache (DONE 2026-09-24: the authenticated, slot-bound cache) | done |
| M2 | browser build: WebCrypto signatures, X.509 via a reviewed library (DONE 2026-09-24: `verifier/web/`, the same `snp.mjs` verdict code behind a crypto provider; see `browser-x509-parser-decision.md`); reproducible packaging with an input manifest and exact notices (DONE 2026-09-24: `verifier/web/dist/`, `reproduce.mjs` under the strict command); same-origin delivery through the site's vendor rule (DONE: `site/vendor/enclave-verifier.js` via `scripts/build-vendor.mjs`; `verifier/web/README.md`); the site's live verify on it (DONE: `verifyMetalBoxWeb`, section 2.2) | done |
| M3 | the production consumers: the CLI, the site and the relay's release judgement on this verifier (section 10.4) | done |
| M4 | release provenance and its supporting machinery (built 2026-09-25, removed 2026-10-14 with the release format it served) | removed |
| M5 | independent review of `verifier/` | review |
| later | TDX (QVL-grade), NVIDIA GPU evidence, an independent measurement expectation (section 2.3), AVF ABI/2 relay frame | separate plans |

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
owner's replay test, which passes against the pinned tree here (34/34). **Re-pinned to 20054bab on 2026-09-25:** the
owner's `verifyPvmProofKey` claims gained `codeHash`, the attested build (bare lowercase 64-hex; an 8-line change; the
evidence paths, `relay/pvm-checkpoint.mjs` and the device fixtures byte-identical), which the runner lifecycle agent now
registers as its measurement. The gate derives the same value itself from the re-verified evidence, requires it to be one
of the CONSUMER'S allowedCodeHashes, and still requires the owner's claims to equal its own reading field for field: a
module reporting another code hash, or none (the 047f7739 module, checked), is refused. `verifier/pvm-proof-key.mjs` is the consumer's
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

## 10.4 M3: the production consumers (2026-09-25; the live entry points as of 2026-10-14)

One module carries the Node consumers: `verifier/consumer.mjs`. It composes what exists and adds no verdict rule:
`verifyMetalBox` (the flow of section 2.2 with node:crypto, node randomness and AMD collateral from KDS or a caller's
adapter), `verifyGuestDomainEvidence` (the SNP branch of `verifier/index.mjs` `verifyEvidence`: anything but
`sev-snp-guest-domain-v1` is `unsupported`, a malformed envelope `rejected`) and `prewarmSnpCollateral` (the collateral that
judgement will need, fetched before a ticket is consumed), with the collateral adapters re-exported. Everything
network-bound is bounded. A TCB floor is a stated policy input; without one the best verdict is `limited`
(`tcb-floor-unjudged`), which every consumer prints as such and never as a pass.

The Node bundle. `verifier/node/build.mjs` packages `verifier/consumer.mjs` with everything it imports reproducibly
(esbuild, platform node, nothing external but Node built-ins) into `verifier/dist/enclave-verifier-node.mjs` with a MANIFEST
naming every input's sha256 and regenerated notices, and copies it byte for byte to `relay/vendor/` (the relay's deploy
ships `relay/**` only). `verifier/node/reproduce.mjs` rebuilds and compares; the strict command runs it before any suite
(`test/verifier-node-bundle.test.mjs`: the reproduction, exactly the consumer's live exports, the source's verdict on the
same bytes, no third-party verifier inside).

The CLI (`cli/enclave.mjs`): `enclave attest [<id>] [--expect HEX[,HEX]] [--min-tcb JSON] [--collateral-dir DIR]`, the
behaviour of section 2.2. `test/cli-attest-verifier.test.mjs` runs the real CLI process against a stand-in relay whose box
signs with the synthetic chain: every box is challenged with the CLI's own nonce, a chain to a root that is not AMD's pin is
`rejected` (exit 1), `--expect` pins the measurement and a malformed pin is refused, the plain output never says PASS for a
refused box, a deployment resolves to its box, a Shield host is `unsupported` and a vanished box `unavailable`, both
non-zero.

The site: `site/js/core/verify.js` imports `/vendor/enclave-verifier.js` (the web bundle `verifier/web/dist/`, sha256 in its
MANIFEST, reproduced by `verifier/web/reproduce.mjs`) and calls `verifyMetalBoxWeb`, with AMD collateral through the relay's
KDS mirror. `test/verifier-web-browser.test.mjs` runs the bundle in Chrome for Testing 151 over the DevTools protocol: its
verdicts equal the Node build's on the shared fixtures, and `verifyMetalBoxWeb` runs against a stand-in relay on the same origin.

The relay: per-app guests' release documents (`relay/secrets-release.mjs`) are judged by the vendored bundle's
`verifyGuestDomainEvidence` against an admitted domain release's runtime and measurement pairs, the release binding, the
AppID and HOST_DATA = the deployment, with AMD collateral through the authenticated disk cache (`RELAY_VERIFIER_CACHE_DIR`;
a cached VCEK is re-verified to the pinned ARK on read).

What the consumers can show today: the site's verdict on a live box is `limited` by construction (its expectation is the
operator's allowlist); `verified` on a live box needs a caller pin (`enclave attest --expect`).

## 10.5 NucBox: the custom type-1 path only (2026-09-25, Steven via enclave-d1)

The custom type-1 partition with our measured paravisor is the ONLY NucBox target; the ee-engine VBS-enclave backend is
retired and no legacy enclave report may stand in for a custom-VM report. This lane owns the verifier contract and the
consumer integration for it: `docs/security/nucbox-custom-vm-verifier.md` states, check by check, what the verifier will
require of the node's attach evidence (enclave-5d's proposed `windows-hv-node/v1`, a host-attested boot state with no TEE
claim) and of the paravisor's VM report, each NOT ESTABLISHED until real bytes exist. Done now: the legacy format's verdict
says the backend is retired; `windows-hv-node/v1` is registered as unsupported here (judged by the relay, host not
excluded); `test/verifier-nucbox-legacy-refused.test.mjs` shows on the real boot-64 enclave evidence that no Windows or
candidate custom-VM format name can be verified, and fails if any Windows format becomes supported. The relay's attach
path waits for the real boot-68 frame from enclave-5d.

## 11. Open risks

- **Measurement semantics.** CPU releases carry no signed measurement and metal images are built on the host (section
  2.3), so the expectation is a caller pin or the operator's allowlist; the site's verdict stays `limited` until an
  independent expectation exists.
- **Operator allowlist and rollback.** An allowlist can keep an old genuine measurement admitted; nothing but a caller pin
  bounds a rollback.
- **The relay on the document path.** It can withhold or delay a fresh document, never forge one; the request's TLS ends at
  the relay, so an end-to-end channel must use the transport key the report binds.
- **TCB floors** are hand-set no-downgrade floors (`verifier/metal-box.mjs` `TCB_FLOORS`); they rise only by a reviewed
  change after an AMD security bulletin, and a product line without one stays `limited`.
- **KDS rate limiting** (429 after a few requests) makes a cache, the relay's mirror or the auxblob mandatory for anything
  interactive.
- **Browser X.509**: decided and prototyped 2026-09-24 (`browser-x509-parser-decision.md`). The browser build is stricter than
  Node in three measured places (non-canonical DER, the PSS profile, the host rule), each a refusal; it judges SNP only.
- **Clock**: certificate windows and CRL `nextUpdate` need a trustworthy clock in the browser; a wrong clock
  can only reject, never accept, if `notBefore` and `nextUpdate` are both enforced.
- **TDX and GPU** are `unsupported` in the verifier; the site must not imply otherwise.
- **Relay dialed rows** trust self-reported `teeCpu`; nothing re-verifies them.
- **pVM ABI/2** relay frame undecided; the payload printed a 72-byte zero-padded ECDSA signature once (pVM
  owner, 2026-09-24): the verifier must require canonical DER and refuse padding.
- **Isolation IGVM path**: `runtime.json` inside the guest image is outside the launch measurement there
  (`isolation/m3/PLAN.md` section 16), so the runtime identity is "the domain's word" until the SVSM carries
  it (M4b).
- **Supply chain of the verifier itself**: pinned versions, reproducible bundles with input manifests,
  `THIRD-PARTY-NOTICES.md` regenerated, served same-origin.

## 12. Specification and implementation references

The companion file `independent-verifier-references.md` holds the authoritative specifications (AMD 56860 Rev 1.59
and 57230 Rev 1.05, Intel DCAP API Rev 0.91 and PCS v4, NVIDIA nvtrust and NVAT, Android AVF remote attestation,
Sigstore bundle and Fulcio OIDs, kept for reference), the current reference verifiers with versions and licenses, and the
licensing table. Two points from it shape this plan: go-sev-guest v0.15.0 parses report versions 2..5 while ABI Rev 1.59
introduces version 6 (our parser accepts 6 structurally and says its new fields are unjudged); and the Turin fmcSPL query
and 8-byte hardware id are confirmed in practice by KDS answering the URL `relay/snp-verify.mjs` builds.

## 13. Licensing

`@freedomofpress/sigstore-browser` 0.1.14 Apache-2.0 by its LICENSE file (package.json says MIT; ship the Apache notice);
`@freedomofpress/crypto-browser` 0.1.7 Apache-2.0; `@freedomofpress/tuf-browser` 0.1.11 MIT (bundled as a dependency of the
former); `@noble/*` MIT. Apache-2.0 requires the NOTICE and license text to ship with the bundle (`build-notices.mjs`
already does this); MIT requires the copyright notice. No copyleft obligation is introduced by option B.

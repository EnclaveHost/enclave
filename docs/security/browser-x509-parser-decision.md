# Browser X.509 for the independent verifier: the parser decision (2026-09-24)

Branch `research/independent-verifier`. Codex directed this slice under Steven's standing scope. Everything here is
branch-only: no production activation, no trust-root distribution change, no site change. The prototype is
`verifier/web/` and its three suites; nothing is bundled into the site.

## 1. The question

The Node verifier (`verifier/snp.mjs`) reads certificates with `node:crypto`'s `X509Certificate`, which does not exist in
a browser. A browser build needs an X.509 reader and a signature engine. The requirement is no silent reduction of
validation relative to Node: every check the Node build makes, the browser build makes on the same inputs with the same
outcome, and a verdict the Node build refuses, the browser build refuses on the same check.

## 2. What the Node build actually validates (the parity target)

Read from `verifier/snp.mjs`, `verifier/der.mjs`, `verifier/tls-binding.mjs` and `relay/snp-verify.mjs`, and measured
where the library's behaviour, not the source, decides:

| responsibility | Node build | where |
|---|---|---|
| certificate parse | OpenSSL `d2i` through `X509Certificate`. MEASURED: accepts a non-minimal length, an indefinite length and trailing bytes on the genuine Genoa ARK, and verifies each | test 3 of `test/verifier-web-x509.test.mjs` |
| signature | `cert.verify(issuerKey)` = `X509_verify`: over the original TBS bytes, the two AlgorithmIdentifiers must be equal, the PSS parameters (hash, MGF, salt, trailer) taken from the certificate. MEASURED: verifies a certificate honestly stating salt 32 | test 4 |
| issued-by | `checkIssued` = `X509_check_issued`: names, AKID against SKID when both present, issuer key usage keyCertSign when present, key type against the algorithm | `snp.mjs` parseAmdChain, checkChain |
| root | sha256 of the DER against the pinned ARK (`relay/snp-verify.mjs` AMD_ARK_SHA256) | `snp.mjs` |
| names | subject and issuer CN strings; ARK-\<product\>, SEV-\<product\>, SEV-VCEK | `snp.mjs` |
| validity | `validFrom`/`validTo` (OpenSSL's `ASN1_TIME_print` form), inclusive window | `snp.mjs` |
| key | RSA-4096 for ARK and ASK (`asymmetricKeyDetails.modulusLength`), EC P-384 for the VCEK | `snp.mjs` |
| VCEK identity | AMD extensions (1.3.6.1.4.1.3704.1.*) against the report's chip id and TCB, by the shared `vcekMatchesReport` with its own bounded DER reader | `relay/snp-verify.mjs` |
| CRL | own reader (`verifier/der.mjs`, strict: minimal lengths, no indefinite), RSASSA-PSS OID required, issuer Name bytes equal to the ARK subject, signature verified with FIXED parameters (SHA-384, salt 48) regardless of what the CRL states, `thisUpdate` not in the future; then `judgeCrl` (staleness, the ASK serial) | `snp.mjs` |
| report signature | ECDSA P-384 over bytes 0..0x2a0, r and s range-checked against the group order first | `snp.mjs` |
| served certificate (hosted format) | parse, window, `checkHost` (OpenSSL host rules: SAN DNS names, CN fallback when no SAN, partial wildcards allowed), hpke and hatt SAN decoding, SPKI hash | `tls-binding.mjs` |

## 3. Candidates, from source

Installed into a scratch directory with scripts disabled and read; sizes measured with esbuild 0.28.1 (`--bundle
--minify --platform=browser --format=esm`, gzip -9).

| candidate | version, license | DER strictness (measured on the ARK) | PSS parameters | signature over | minified / gzipped | notes |
|---|---|---|---|---|---|---|
| `@freedomofpress/sigstore-browser` `X509Certificate` (+ `crypto-browser` ASN.1) | 0.1.14, Apache-2.0 by LICENSE (package.json says MIT); already a dependency of this repository and what the site ships for Sigstore | refuses indefinite length and long-form tags; ACCEPTS non-minimal lengths and trailing bytes | hash read from the parameters; salt DERIVED from the hash length (32/48/64), MGF and trailer ignored (`crypto-browser/dist/crypto.js` verifySignature). MEASURED: refuses the honest salt-32 certificate (returns false), refuses the patched ARK | re-encoded TBS (`toDER()`), identical to the input for canonical DER | 49,850 / 18,053 for the X.509 slice; 127,902 / 42,039 for the package | names as raw bytes, DN map, AKID/SKID/keyUsage/basicConstraints decoders, `isCA`; ECDSA through `@noble/curves`; RSA keys with the id-RSASSA-PSS SPKI OID refused (AMD's are rsaEncryption) |
| `@peculiar/x509` (+ `@peculiar/asn1-*`, `asn1js`, `tsyringe`) | 2.1.0, MIT | accepts all three non-canonical encodings (asn1js is a BER reader) | hash and saltLength READ from the parameters (`toWebAlgorithm`), MGF and trailer ignored. MEASURED: verifies the honest salt-32 certificate; refuses the patched ARK | `this.tbs` | 211,119 / 52,655; requires a global Reflect polyfill at import (`reflect-metadata` 0.2.2, Apache-2.0): 225,111 / 56,732 with it | full-featured (chain builder, CRL class, date check inside `verify()`), a dependency-injection container in the trust path, twelve packages |
| `pkijs` (+ `asn1js`) | 3.4.1, BSD-3-Clause | accepts all three | hash and saltLength read (default 20 when absent, RFC 4055), MGF ignored. MEASURED: verifies salt-32; refuses the patched ARK | original TBS view | 390,837 / 81,825 | largest; global engine pattern; chain-validation engine is WebPKI-shaped and not what this verifier needs |
| own reader on `verifier/der.mjs` | ours | strict (minimal lengths, no indefinite, exact length, bounded children) | whatever we write | original TBS slice | 5.5 KB of source | the plan's rule is "do not invent primitives"; DER structure walking is not a primitive, but DN and extension decoders deserve a reviewed source |
| Node-only readers (`@sigstore/core` X.509, `node-forge`) | | | | | | excluded: `node:crypto` throughout, or no EC at all |

Two facts decided the shape more than any library did. WebCrypto (Node 22's and Chrome 151's) verifies every real AMD
signature with the parameters the certificates state (RSA-PSS SHA-384 salt 48; ECDSA P-384 for the report) and refuses
salt 32 on the same bytes, so the signature engine is WebCrypto and no library's engine. And no candidate takes ALL of
the PSS parameters from the certificate the way OpenSSL does: one derives the salt, all ignore the MGF hash and the
trailer field. Parity with Node therefore cannot come from a library's `verify()`; it has to come from a check of the
AlgorithmIdentifier bytes we write ourselves and apply before any signature is asked.

## 4. Decision

`@freedomofpress/sigstore-browser`'s `X509Certificate` for structured access (distinguished names, key identifiers, key
usage, basic constraints), `verifier/der.mjs` for the bytes that are compared or signed (the whole TBSCertificate, both
AlgorithmIdentifiers, the Names, the SubjectPublicKeyInfo, the signature BIT STRING, the extensions), and WebCrypto for
every signature. The two readers are cross-checked on the Names. `verifier/web/x509.mjs` is the layer; it is 170 lines
and the review burden is there.

Why not `@peculiar/x509`: four times the bytes, a BER reader, a DI container and a required global polyfill in the trust
path, for a salt-reading behaviour we cannot rely on anyway (it still ignores the MGF hash and the trailer). Why not
`pkijs`: eight times the bytes for the same reason. Why not a fully own reader: the DN and extension decoders are the
fiddly part, the reviewed class already ships same-origin for provenance, and adding a second X.509 stack to review is
worse than reusing the one already in the site's bundle. No licensing, product or security tradeoff was left for a
decision: both packages in the path are Apache-2.0 (with the notice obligation the site already meets), and the
resulting bundle is smaller than any alternative.

## 5. What the browser build validates, against the target

| responsibility | browser build | relative to Node |
|---|---|---|
| certificate parse | strict: exactly one SEQUENCE consuming the buffer, minimal lengths, no indefinite form, BIT STRING unused bits zero, every TBS child walked once | STRICTER (measured both sides in test 3: Node accepts the three encodings, the browser refuses them). Refusals only |
| signature | WebCrypto RSA-PSS SHA-384 salt 48 over the ORIGINAL TBS slice, after: the two AlgorithmIdentifiers byte-equal, and the RSASSA-PSS parameters parsed and required to be SHA-384, MGF1 with SHA-384, salt 48, trailer absent (DER default, OpenSSL's encoding) or explicitly 1 (AMD's encoding) | STRICTER on the profile: Node verifies a certificate honestly stating another salt; the browser refuses it (test 4). Equal on every real AMD certificate and on the synthetic chains |
| issued-by | names byte-equal, AKID keyIdentifier against SKID when both present, issuer keyUsage keyCertSign when present, issuer key RSA | equal for these certificates. LIMIT: an AKID carrying authorityCertSerialNumber or authorityCertIssuer is not compared (AMD's carry the key identifier only) |
| root, names, validity, key | same pins (the same `AMD_ARK_SHA256` Map, imported), CN from the reviewed DN map, inclusive window, `BN_num_bits` modulus length, curve OID | equal; the window reasons carry OpenSSL's time form so the wording is identical (`opensslTime`) |
| VCEK identity | the SAME `vcekMatchesReport` (imported, running on the Buffer stand-in) | identical code |
| CRL | the same `parseCrl`; issuer bytes against the ARK subject; the CRL's two AlgorithmIdentifiers must be equal and AMD's profile; WebCrypto with salt 48; then the same `judgeCrl` | STRICTER on the stated parameters (Node ignores what the CRL states); equal on every real and synthetic CRL |
| report signature | WebCrypto ECDSA P-384, same range check, same words | equal |
| served certificate | DNS SANs read from the extension; host rule: exact, or one leftmost `*` label with at least two labels after it; no CN fallback, no partial wildcards; the same `decodeLabelledSans` (imported) | STRICTER (no CN fallback, no partial wildcards). Equal on the fixture host and its mismatch |
| serial formatting | OpenSSL `BN_bn2hex` form for a non-zero serial (`020002`); a zero serial prints `00` where Node prints `0` (only the VCEK's serial is zero, and no reason prints it) | equal where it is printed |

Every "stricter" entry is a refusal the Node build would not give, never an acceptance. On every measured case (the
suites below) and on every code path the table names, the browser build accepts nothing the Node build refuses. That is
the claim's scope: measured documents and named paths, not a proof of universal equivalence.

## 6. How the verdict code is shared (no second verifier)

`verifier/snp.mjs` gained a provider (`context.crypto`): the certificate, CRL, report-signature, hash and served-
certificate questions go through it, with `NODE_CRYPTO` (the existing functions, unchanged) as the default and
`verifier/web/provider.mjs` (`WEB_CRYPTO`) for the browser. Policy, order and wording stay in `snp.mjs`. The CRL
judgement was extracted as `judgeCrl` so both providers end in the same function. `verifier/der.mjs` lost its Buffer
dependence (behaviour-preserving; a Node Buffer is a Uint8Array). `verifier/envelope.mjs` gained `validateEnvelope`
(every rule that needs no byte decoding) so the browser entry decodes with `atob` and `DecompressionStream` under the
same caps. `relay/snp-verify.mjs` is untouched: the browser bundle imports its pure functions and aliases `node:crypto`
to a shim that throws if called. The `buffer` package (6.0.3, MIT, a devDependency) stands in for Node's Buffer inside
the bundle.

## 7. Acceptance (all under the strict command, `verifier/integration/run.mjs`)

| suite | cases | what it proves |
|---|---|---|
| `test/verifier-web-x509.test.mjs` | 6 | field-by-field agreement with `X509Certificate` on all three real chains and both real VCEKs; WebCrypto verifies every real AMD signature; the three DER encodings and the honest salt-32 certificate asserted on BOTH sides (Node accepts, browser refuses); the three real CRLs; the served certificate against `tls-binding.mjs` |
| `test/verifier-web-differential.test.mjs` | 3 (93 documents) | the whole verdict (status, admissionSafe, omissions, checks, claims, reasons) equal between the builds over the Genoa, Turin and synthetic mutation matrices plus envelope cases: oversized and over-wide documents, over-long bodies, all-zero and malformed reports, gzip over the cap, collateral adapters that throw, wrong and missing root pins, a wrong key type in the VCEK slot; every check name fails in at least one case; every status class appears; the browser build answers "unsupported" for every non-SNP technology |
| `test/verifier-web-package.test.mjs` | 4 | the COMMITTED artifact reproduces byte for byte from the tree with the pinned esbuild; its manifest names every input with its hash and the build options; the notices are generated from those exact inputs with each LICENSE text; a changed artifact byte, an edited input record, other build options, a stale or missing notice and a package without a LICENSE file each fail closed |
| `test/verifier-web-shadow.test.mjs` | 4 | the opt-in shadow adapter: disabled fetches nothing; enabled fetches exactly the five same-origin paths; the record never carries acceptance and states the transport binding is not claimed; every primary outcome is recorded; a hanging origin, an oversized answer, a refused or missing collateral piece, a bad certificate answer, a malformed document, a wrong or missing root pin each refuse with the reason |
| `test/verifier-web-browser.test.mjs` | 3 | the COMMITTED artifact (hash checked against the manifest, no `node:` import surviving, bound 512 KiB) in Chrome for Testing 151 over the DevTools protocol: a 12-case pack from the same fixtures with no global Buffer on the page and every verdict equal to the Node build's; the shadow adapter run in the page against the same local origin with the same record as Node's; strict integration requires the browser |

Strict command after the packaging and shadow slices: see the plan's M2 row for the measured count. Nothing is skipped, and no case is TODO.

## 8. Limits, stated

- The browser build judges AMD SEV-SNP only. AVF, VBS, Hyper-V and the pVM evidence formats are "unsupported" in it
  (the Node build delegates those to relay modules that need Node). Never green.
- The real-browser suite proves the runtime (WebCrypto, DecompressionStream, the Buffer stand-in) on twelve documents;
  breadth comes from the Node-side differential, which runs on Node's WebCrypto. The two together are the claim.
- The bundle is committed under `verifier/web/dist/` with its manifest and notices and reproduces from the tree under
  the strict command (`verifier/web/README.md`), and is delivered to the site as `site/vendor/enclave-verifier.js` under
  the vendor rule, loaded only by the opt-in shadow glue (`site/js/core/verify-shadow.js`), which records and never
  decides. Nothing is rendered; the primary verdict and its roots are unchanged.
- The differential normalises two strings: the reader's own message after "unparseable:" and the decoder's message
  inside the gunzip parentheses. Everything else is compared verbatim.
- The clock is the caller's in both builds; a browser without a trustworthy clock can only refuse more (windows and
  `nextUpdate` are both enforced), never accept more.
- Trust roots: unchanged. The browser bundle carries the same three ARK pins by importing the same Map; a policy may
  pass its own `roots`, as in Node.

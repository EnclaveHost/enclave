# verifier/web: the browser build of the independent verifier

Branch `research/independent-verifier`. Codex-directed M2 slices under Steven's standing scope. Nothing here is served by
the site, referenced by a page, or activated anywhere: it is a build, its provenance, and its acceptance.

## What it is

The same verdict code as the Node verifier (`verifier/snp.mjs`, `verifier/envelope.mjs`, `relay/snp-verify.mjs`), run
in a browser with WebCrypto and a reviewed X.509 reader behind a crypto provider (`provider.mjs`, `x509.mjs`). The parser
decision and its measurements: `docs/security/browser-x509-parser-decision.md`. It judges AMD SEV-SNP evidence only;
every other technology answers `unsupported`, never green.

## Packaging: reproducible, provenance explicit

`node verifier/web/build.mjs` writes `dist/`:

| file | what it is |
|---|---|
| `enclave-verifier-web.js` | the bundle (esbuild, pinned version, options in the manifest); `node:crypto` and `node:zlib` aliased to shims that throw if called; `buffer` injected as the Buffer stand-in |
| `MANIFEST.json` | the artifact's sha256 and size; the build tool, version and every option; EVERY input esbuild bundled with its path (repository-relative) and sha256 |
| `THIRD-PARTY-NOTICES.md` | generated from those exact inputs: every package that contributes bytes (transitive ones and nested copies included), its version, its LICENSE file's text, the files bundled from it |

`node verifier/web/reproduce.mjs` rebuilds from the tree into a temporary directory and refuses, by name, any difference
in the artifact, an input's hash, the build options, or the notices (a fresh generation must equal the committed file).
The strict integration command runs it before any suite. `test/verifier-web-package.test.mjs` asserts each refusal.

Two facts about the bundle's contents, from the manifest, worth knowing: the Sigstore package's index re-exports its
TUF client, and its exports map forbids a deeper import, so `@freedomofpress/tuf-browser` is bundled although nothing on
the verification path calls it; and the bundle carries `@noble/curves` 1.9.1 (the repository's copy, reached through
`crypto-browser`, which requires `^1.6.0`) and not the Sigstore package's own nested 2.2.0, because none of the Sigstore
files that made it into the bundle import noble directly. Neither is on the SNP path (no ECDSA goes through noble here:
WebCrypto verifies the report), and both are recorded rather than hidden.

## Licenses

Every package in the bundle ships a LICENSE file; the notices reproduce each. `@freedomofpress/sigstore-browser` declares
MIT in package.json while its LICENSE file is the Apache License 2.0 text; the notices state this and reproduce the file,
which governs. The Buffer stand-in is `buffer` 6.0.3 (MIT) with `base64-js` (MIT) and `ieee754` (BSD-3-Clause). esbuild
builds the artifact and is not in it. A package without a LICENSE file cannot be noticed, and the generator throws, so
such a bundle is never packaged.

## Acceptance

| suite | what it proves |
|---|---|
| `test/verifier-web-package.test.mjs` | reproducibility, the manifest, the notices, and that each fails closed when tampered with |
| `test/verifier-web-x509.test.mjs` | the reader against Node's own certificate object on the real AMD collateral; both sides of every strictness divergence |
| `test/verifier-web-differential.test.mjs` | whole verdicts equal between the builds on the measured documents (93), incl. oversized and over-wide documents, adapter failures, wrong and missing pins |
| `test/verifier-web-browser.test.mjs` | the COMMITTED artifact in Chrome for Testing 151: verdicts equal to Node's on a 12-document pack |

The differential claim is scoped to the measured documents and the code paths the suites name; it is not a proof of
universal equivalence. Where the browser build differs from Node it refuses more (non-canonical DER, the AMD PSS profile,
the host rule) and, on every measured case, never accepts what Node refuses.

## The shadow adapter: opt-in, same-origin, never a decision

`shadow.mjs` (`createShadow({ enabled, origin, collateralBase, roots?, fetchImpl?, timeoutMs?, maxBytes? }).run({ host,
expected, primary? })`) runs this verifier beside whatever a page's primary verifier decided and returns a RECORD. Rules,
each asserted by `test/verifier-web-shadow.test.mjs` and, in Chrome, by the browser suite:

- **Opt-in.** `enabled` defaults to false; disabled, `run()` fetches nothing and says so. Nothing in the site calls it.
- **Never acceptance.** The record carries `acceptance: false` and `transportBindingClaimed: false` (a page cannot read
  its own TLS peer certificate; the served certificate comes from the well-known endpoint). There is no hook into the
  primary and no field a caller could read as a release; the consumer gate is `verifier/admission.mjs`, not this.
- **No arbitrary fetch.** Only the two well-known paths under the explicit `origin` and the three KDS-shaped paths under
  the explicit `collateralBase` (a same-origin mirror; KDS sends no CORS headers), each bounded in time and bytes, no
  redirects, no credentials. Never code.
- **Explicit roots.** The AMD ARK pins are the repository's Map or the caller's; the record names which (`rootsSource`),
  and every collateral source is recorded as the adapter reports it (`sources`, from the verdict's `claims.collateral`).
- **Comparison, recorded.** As the live differential: `agree`, `agree-refuse`, `disagree`, `primary-missing`, plus whether
  the primary's measurement is the report's. A disagreement is a finding to read, not a switch that flips.

## Delivered to the site (opt-in shadow, 2026-09-24)

- `scripts/build-vendor.mjs` copies `dist/enclave-verifier-web.js` to `site/vendor/enclave-verifier.js` under the site's
  same-origin vendor rule, refusing unless the bytes are the manifest's, and checks the exports the glue uses. It never
  rebuilds the artifact: reproducibility stays with `reproduce.mjs`.
- `site/js/core/verify-shadow.js` is the glue: OFF unless a viewer opts in (`?verifier-shadow=1`, or localStorage
  `enclave.verifierShadow` = `1`); `site/js/core/verify.js` awaits it after the primary verdict and attaches the record as
  `res.shadow` (and `globalThis.__enclaveVerifierShadow`), never touching `res.ok`, `res.doc` or `res.error`. The allowed
  measurement is the primary's Sigstore-derived `codeMeasurement` (release provenance), never the enclave's reported one;
  the TCB floor is a diagnostic constant; the roots are the verifier's pins; collateral comes from Tinfoil's KDS proxy
  (CORS-allowed) and the document and certificate from the enclave's well-known paths, every source recorded.
- `test/site-verifier-shadow.test.mjs` holds the vendored bytes to the manifest, the glue OFF by default and never
  throwing, and the end-to-end record with the real vendored module against a local origin.
- Rollback: revert the caller in `verify.js` (or the whole commit); no other file depends on it. No trust root of the
  primary changes; the shadow cannot grant acceptance.
- Notices: every package the bundle carries was already listed in `THIRD-PARTY-NOTICES.md` through the site's other vendor
  bundles; `scripts/build-notices.mjs` now also walks this bundle's manifest so that stays true. Observed while checking:
  the site's `scripts/.vendor-build/` tree has no lockfile, so a fresh vendor build resolves newer transitive versions
  (crypto-browser 0.1.8, viem 2.56.8, ox 0.14.45) than the committed primary bundles embed; the committed bundles and
  notices were left as they are. A lockfile for that tree would make the primary bundles reproducible too.

## Not done

The site renders nothing from the record (design preserved; console and the result field only). Any activation beyond
the viewer's own opt-in. See the parser decision document for the rest of M2.

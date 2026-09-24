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
the verification path calls it; and the bundle carries `@noble/curves` 1.9.1 (the repository's copy) because the Sigstore
package's `^2.0.1` range resolved to no nested copy in this lockfile. Neither is on the SNP path (no ECDSA goes through
noble here: WebCrypto verifies the report), and both are recorded rather than hidden.

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
| `test/verifier-web-differential.test.mjs` | whole verdicts equal between the builds on the measured documents (81) |
| `test/verifier-web-browser.test.mjs` | the COMMITTED artifact in Chrome for Testing 151: verdicts equal to Node's on a 12-document pack |

The differential claim is scoped to the measured documents and the code paths the suites name; it is not a proof of
universal equivalence. Where the browser build differs from Node it refuses more (non-canonical DER, the AMD PSS profile,
the host rule) and, on every measured case, never accepts what Node refuses.

## Not done

Same-origin delivery through the site's vendor rule, the site's shadow line, and any activation. See the parser decision
document for the rest of M2.

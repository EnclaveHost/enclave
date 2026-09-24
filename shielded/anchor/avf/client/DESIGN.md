# The installed pVM client: trusted code delivery and bootstrap (LAB)

**Status.** LAB, not production. Agreed with the Enclave verifier session before it was built (research/independent-
verifier: its reply of 2026-09-24 accepting the design with nine fail-closed refinements, all adopted below). It uses test
keys only: no production policy or release key, no Sigstore identity, no store listing, no deployment.

## The problem

A client that verifies the pVM must itself be trusted, and **a web page cannot authenticate its own malicious
replacement**. Whoever serves the page (the relay, the site, a CDN) can serve one that skips the verification, and any
integrity check inside the page is theirs to replace too. The lab page (web/lab.html) proves the protocol works in a
browser, but it cannot be the trust path. The verifier must be **installed before first contact**, must never execute
code it fetches, and must take its expectations from somewhere the relay cannot write.

## What the client trusts, and nothing else

| anchor | where it comes from | what it decides |
|---|---|---|
| the artifact's bytes | a reproducible build of a named commit (build.sh). The Enclave verifier session rebuilds it independently and must report the same sha256: two parties agreeing on the hash is the lab stand-in for a transparency log | all code that runs |
| the policy key fingerprint + a serial floor | given to the user **out of band at install** (`pvm-client install`, or the extension's options page); never from a carrier | which policies are genuine, and how old a policy may be |
| the release key fingerprint | also given out of band at install; distinct from the policy key | which code updates are genuine (with a policy countersignature) |
| Google's attestation roots | built into the artifact | the only roots; a policy may narrow them, never widen or empty them |

Everything else is data from carriers the client does not trust: the policy file, update manifests and bytes, evidence,
sealed answers. It is verified, or refused.

## The policy (`src/trust.js verifyPolicy`)

The policy travels as `{ policy: base64(exact JSON bytes), sig }`.
- **Signature.** Ed25519 over `"enclave-pvm-client-policy-v1\n" || the exact bytes`. There is no canonicalisation on
  either side, and the bytes must be strict JSON: they round-trip through parse and serialise unchanged, which rules out
  duplicate keys and padding.
- **Key.** The policy carries its own public key, whose SHA-256 must be the anchored fingerprint, or the next key a
  previously accepted policy named.
- **Closed shape.** The fields are `type, key, serial, notBefore, notAfter, codeHashes, authorityHashes, runtimeIds,
  appIds, googleRootPins, formats, sealedModes, sealedWindow {seconds, maxRequests}, minClientVersion, nextPolicyKey`.
  - Every list is non-empty; an empty list is never read as "all".
  - Root pins must be a subset of the built-in Google roots.
  - Formats and modes must be ones this client knows.
- **Time.** Policies are short-lived. notBefore and notAfter are enforced on the client's clock: expired or not yet
  valid means no operation, never a stale fallback.
- **Serial.** The client remembers `{ serial, digest }` of the newest policy it accepted, starting at the install floor.
  A lower serial is a rollback; the same serial with different bytes is equivocation. Both are refused.
- **Rotation.** A key changes only by a signed `nextPolicyKey`. The old key is retired once the next one has signed.
  Losing the key means reinstalling.
- **Kill switch.** `minClientVersion` disables a known-bad installed version.

A policy binds the gate's rules as well as the pins: the formats (v2 only for browsers), the sealed modes, and the
sealed window the VM must state.

## The release rule (`src/gate.js admit`)

The client runs ONE verifier at runtime: web/pvm-verify.js, with node parity asserted in test/pvm-web-verify.test.mjs.
The Enclave verifier session's own verifier stays the offline differential.

What is shared is the **gate**, the verifier session's admission rule, held here by test/pvm-client-gate.test.mjs to its
40 vectors (`test/fixtures/verifier-admission/`, from d760725b). The client releases a request only when:
- the verdict is verified and admission-safe, with nothing omitted and every check true;
- every expectation came from the signed policy;
- the freshness is the client's own single-use nonce;
- for a browser, a v2 app key and its sealed window are present, and TLS pinning is never claimed.

This pVM-only client holds the vectors' three AMD SEV-SNP releases (out of scope, fail closed) and matches all 37 other
decisions. After the gate, the client also requires the policy's format and sealed window, then seals, sends, and spends
the nonce.

## Delivery forms (`build.sh`)

- **CLI** `dist/pvm-client.mjs`: one file.
  - Its first line is `/*! enclave-pvm-client <version> ...`. The running version is a constant inside the bytes, so it
    cannot be claimed without changing the hash.
  - It needs Node with WebCrypto (Ed25519, X25519).
  - The one `import(...)` in it is @hpke/common's fixed fallback to the Node `crypto` builtin. It is unreachable where
    `globalThis.crypto` exists, and there is no import of a URL, eval or `new Function`.
- **Browser extension** `dist/pvm-client-ext.zip` (MV3): the same core.
  - Its CSP is `script-src 'self'`, so no remote code.
  - It has no `web_accessible_resources`, so no site can open or script its pages, and no `externally_connectable`.
  - The anchor is set once on its options page and never replaced in place.
  - This is the browser's answer to the problem above. The extension store and its auto-update become a delivery party
    the user trusts for the bytes; the policy's `minClientVersion` limits what a bad store update can do.
- **Reproducible.** There are no timestamps and no absolute paths. The zip is STORED, with fixed dates, sorted entries
  and fixed permissions. `BUILD.json` lists every input's sha256 and every output's sha256 and size.
  `build.sh --check` rebuilds and compares byte for byte.

## Updates (`src/trust.js verifyUpdate`; CLI `update`)

The manifest travels as `{ manifest: base64(exact bytes), releaseSig, policySig }` with the fields
`type, artifact, version, artifactSha256, size, sourceCommit, notAfter, releaseKey, policyKey, nextReleaseKey`.
- **Both keys.** The release key signs (`"enclave-pvm-client-update-v1\n"`), and the anchored policy key countersigns
  (`"...update-countersign-v1\n"`), so no single key ships code.
- **Bytes.** The delivered bytes must hash to the manifest and have its size, and their own first line must carry the
  manifest's version, so a manifest cannot rename an artifact.
- **Order.** The version must be strictly newer: a downgrade or a replay is refused. The manifest also expires.
- **Staging.** The CLI writes the verified bytes **beside itself** as `pvm-client-<version>.mjs`, for the next start,
  and records them in its state (see State). The running process never imports what it fetched.
- **Rotation.** The release key rotates only by a signed `nextReleaseKey`.
- **Production.** Toward production, the manifest becomes a **Sigstore bundle** under the release workflow's GitHub
  identity, which the verifier session's provenance module already verifies against a repo/workflow/tag policy. This
  Ed25519 manifest is the lab stand-in.

## State (`src/store-file.js`, `src/store-ext.js`; since 0.2.0)

The state is the client's rollback memory: the anchors, the newest accepted policy's serial and digest and the key it
accepted, the release key, and the staged update. It changes in one way only. A policy or update is verified against the
**newest committed** state and committed as its successor, **before** the client fetches evidence or sends anything.
0.1.0 saved the state after the whole exchange, so a stalled carrier plus a kill, or an overlapping older run, brought
the floor back (reproduced on its shipped bytes by the tests below).
- **Order.** `connect` commits the policy before its first evidence request. After that point, a stalled carrier, a
  killed process or a closed tab cannot bring the floor back.
  - If the commit fails, nothing is sent and the result is `step: "commit"`. Failures include a read-only or full disk,
    an unreadable newest generation, and storage that throws or does not keep the write.
  - Just before a request is sealed, the client reads the committed state again. If another process or tab committed
    a newer policy meanwhile, the request is refused (`step: "gate"`, superseded), never sent under the older policy.
- **CLI** (`--state DIR`, default `$XDG_CONFIG_HOME/enclave-pvm-client/state.d`). A generation log: `<n>.json` holds
  `{gen, state}`, and the newest generation is the state.
  - A commit writes a uniquely named temp file, fsyncs it, and `link()`s it to `<n+1>.json`, then fsyncs the directory.
  - The link fails if that generation already exists, so two processes that read the same generation cannot both
    commit. It is a compare-and-swap with no lock to go stale.
  - The process that loses re-reads the newest state and decides again. A refusal counts only when it was made on the
    newest generation. An older policy that lost to a newer one therefore becomes a rollback refusal, and an update that
    lost to a policy commit keeps both changes. After 64 lost races it gives up (exit 2, nothing sent).
  - An unreadable or inconsistent newest generation is fatal (exit 2): falling back to an older one would itself be a
    rollback. The last 16 generations are kept.
  - A 0.1.0 state FILE given as `--state` is imported once into `<file>.d`, with its floor.
  - `pvm-client state` prints `{state, gen, dir}`. Users and black-box tests read the state through it, not the layout.
- **Extension.** `chrome.storage.local` key `stateDoc` holds `{gen, state}`.
  - Every read-verify-write runs inside one Web Locks exclusive lock (`enclave-pvm-client-state`). The lock is
    browser-wide for the extension's origin, so two tabs serialize.
  - Each write is read back before it counts, compared independently of key order (Chrome's storage does not keep it).
  - A 0.1.0 install's `state` key is imported by the first commit.
  - Pages post a `policy-committed` event to the lab result sink when they commit, so tests can observe the order.
- **Updates.** The CLI writes verified bytes to `pvm-client-<version>.mjs` (unique temp file, fsync, rename).
  - It then commits `staged = {version, sha256, file, sourceCommit}`, only if the version is newer than anything staged
    or running. An older concurrent update cannot replace a newer staged one.
  - `pvm-client staged` reports the staged update and whether its bytes still match.

## Tests

- test/pvm-client-trust.test.mjs. Every case below is refused, with nothing adopted:
  - policy signatures: an unanchored key; the right key's policy given to a client anchored elsewhere; a signature by
    another key; a flipped byte;
  - policy encoding and shape: padding, duplicate keys, non-canonical base64, extra and missing fields, empty lists,
    widened roots, unknown formats and modes;
  - policy time and order: expired and future policies; below the floor; rollback; equivocation; a too-low client
    version;
  - rotation only by a signed next key;
  - a policy that narrows the roots to one the Pixel does not chain to is accepted as a policy, and the Pixel's real
    evidence is then refused at verify;
  - updates: tampered, truncated and foreign bytes; an attacker's release key; a missing or foreign countersignature; a
    wrong-domain signature; a downgrade; a replay; the right bytes under the wrong version; expiry; another artifact
    name; release-key rotation.
- test/pvm-client-gate.test.mjs: the admission vectors, and the client's own verdicts through the same rule.
- test/pvm-client-artifact.test.mjs:
  - the build reproduces; the version sits in the bytes; no dynamic code; the extension's CSP and exposure;
  - the BUILT CLI in child processes: its anchors install once; foreign, unsigned, rolled-back (across runs, from its
    state file), equivocating and expired policies are refused; a VM chaining to a non-Google root is refused before
    anything is sent; updates are staged only when valid and never run;
  - in process, the Pixel's real v2 evidence passes policy, verification and gate, and the request is sealed and sent
    once; a replay is held; a relay's app key is refused; a run whose policy was superseded while its evidence was held
    is refused at the gate, although that evidence verifies, and nothing is sent.
- test/pvm-client-durability.test.mjs: the State rules under deterministic barriers, never timing. The barriers are a
  carrier that holds requests, and a driver process that pauses between reading the state and committing
  (fixtures/pvm-client-store-driver.mjs).
  - The shipped 0.1.0 CLI (4e55879b) reproduces the finding; 0.2.0 keeps the floor and refuses both rollbacks.
  - Processes: an older and a newer policy in both commit orders; the same serial with different bytes
    (equivocation); key rotation racing its successor, then a policy under the retired key; two updates staged
    concurrently; a policy commit racing a release-key rotation.
  - Failed persistence: a read-only state, a corrupt newest generation and a throwing store. Nothing reaches the
    carrier.
  - The 0.1.0 state import, and the extension store under a fake storage (lock, throwing and dropped writes).
- test/pvm-client-ext-durability.test.mjs: the same in Chrome for Testing, with tabs opened through DevTools and a
  policy server that holds each tab's policy.
  - The shipped 0.1.0 extension, killed while stalled at the carrier, accepts the older policy afterwards.
  - 0.2.0 commits before the evidence request and refuses it.
  - Two tabs with an older and a newer policy, in both orders: the floor ends at the newer, including after a kill.
  - Two tabs with the same serial but different bytes: equivocation. The identical policy in two tabs is one commit.
- Device: results/pvm-cpu-client-artifact (the CLI and the extension on the Pixel 10).

## What this does not solve

- **The first install.** The user must get the artifact hash and the anchors out of band, once. Nothing here can
  bootstrap trust from zero.
- **The host.** A compromised machine or browser can subvert any installed client.
- **The extension store.** The store is trusted to deliver the bytes it is given (bounded by `minClientVersion`).
- **Production keys and provenance.** Custody of the production keys and the Sigstore provenance is the owner's.
- **Traffic analysis and denial of service** by the relay, as in SEALED-STREAMING.md.
- **Restoring the state from a backup** (a disk or profile snapshot) restores its older floor. Whoever can do that
  controls the host. The tests kill the client or the browser, not the machine: durability across power loss rests on
  fsync (CLI) and on Chrome's storage backend (extension), and has not been tested.

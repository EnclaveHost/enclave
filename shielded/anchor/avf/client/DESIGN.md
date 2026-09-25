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

## Deployments (`src/trust.js selectDeployment`; CLI `run --deployment`, `deployments`; since 0.4.0)

A user picks one deployment, and the client must know which app to expect there. That expectation comes from the signed
policy, never from a catalog, the ledger's `appRef` or a relay: they are carriers, and a carrier's claim about identity
is exactly what the client exists not to believe.
- **The table.** A policy may carry `deployments: [{ id, app }]`.
  - Each `id` is the platform ledger's deployment id in canonical form, `0x` plus 64 lowercase hex.
  - Each `app` must be one of the policy's `appIds`.
  - A table has 1 to 64 entries, each exactly `{ id, app }`, and every id is unique. A duplicate or an unadmitted app
    refuses the WHOLE policy.
  - It is signed with the rest, so rollback, equivocation, expiry and key rotation apply to it unchanged. Moving a
    deployment to another app is a new serial.
  - A policy without the table is exactly the 15 fields it was before 0.4.0.
- **Selecting.** `run --deployment ID` first verifies and commits the policy, as always. Then it takes the one entry with
  that id, and the app id is that entry's `app`. The policy-wide pins apply unchanged: runtime ids, code and authority
  hashes, roots, formats, the sealed window.
  - The client refuses at step `select`, before any evidence request:
    - an id the table does not name;
    - a policy without a table, even when `--app` is also given (there is no silent fall-back to `--app`);
    - an id that is not canonical (never normalized);
    - `--app` also given and different;
    - `--deployment` or `--app` given twice;
    - a table present, but neither flag given (there is no default and no implicit first entry).
  - The result names `deployment: { id, app }`. `--app` alone, with no `--deployment`, still selects an app the policy
    admits.
  - Under an activated version, the launcher hands `--deployment` to the delegated child unchanged. The child makes the
    selection itself; the launcher never resolves it.
- **Listing.** `pvm-client deployments --policy SRC` prints the table a user selects from.
  - It is an acceptance under the anchor like any run: it verifies and COMMITS the policy, and its output names the
    serial and generation.
  - A policy it refuses prints no table.
- **What it does not prove, for an UNBOUND entry.** v2 evidence carries the app, runtime and code identity; it carries no
  deployment id and no instance.
  - A hostile relay can therefore route deployment D's traffic to ANOTHER genuine instance of the SAME app.
  - For such an entry the client proves "a genuine instance of the app the signed policy expects for D". It does not
    prove "D's instance or its operator".
  - A **bound** entry (policy type 2, since 0.5.0) closes the instance half of this: see "Instance binding" below.
  - `--relay` stays the carrier, untrusted, and the id is not used to route.
  - The extension follows the same rules on its own request page (`client.html`), through the same `connect` and
    `selectDeployment` code:
    - `?deployments=1` verifies and commits the policy, then shows its table as links;
    - `?deployment=ID`, optionally with `&app=A`, selects;
    - the install-time app is used only when neither `?deployment` nor `?app` is given;
    - a repeated parameter is refused before anything runs.
    Its pages are not web-accessible, so no site can open them with a chosen deployment.
- **The signer checks first.** `tools/lab-sign.mjs policy` signs the body, then runs the client's own `verifyPolicy` on
  the result, as a client anchored on that key would, below its serial, now. If the client would refuse it, nothing is
  written and the tool exits 2: a malformed table, an unadmitted app, an expired window.
  - A policy every client refuses is an outage for everyone on that key, so it never leaves the signer.
  - The lab stand-in for the production signer only. Production signing is not built here.
- **Agreed first.** The verifier session agreed this contract before the commit. Its independent policy replay adds the
  optional field under exactly these rules.

## Instance binding (policy type 2, evidence v3; `src/trust.js`, `src/enroll.js`; CLI `instance`; since 0.5.0)

The byte format, its trust source and the release rule were agreed with the verifier session before any code:
../INSTANCE-BINDING.md. In short:

- **Which client reads which policy.**

  | policy `type` | read by | table entries |
  |---|---|---|
  | `enclave-pvm-client-policy` (type 1) | every client since 0.1.0 | exactly `{ id, app }`; an `instances` field refuses the whole policy |
  | `enclave-pvm-client-policy/2` (type 2) | 0.5.0 and later | `{ id, app }` or `{ id, app, instances }` |

  - A client before 0.5.0 refuses type 2 as "not a pVM client policy". It can never run a bound deployment as unbound.
  - Serials are one space across both types: the floor, rollback and equivocation rules are unchanged.
  - The signature domain is unchanged; `type` is inside the signed bytes.
- **An entry's `instances`.** These are the InstanceIDs that may serve the deployment:
  - 1 to 8 of them, unique, each 64 lowercase hex;
  - an InstanceID may appear in only one deployment of the table;
  - `formats` must include `enclave-pvm-app-evidence/v3`.
  Any fault refuses the whole policy.
- **A bound entry is served v3 only.**
  - The client sends `EVIDENCE3`, and v1 or v2 is refused as a downgrade, by name, before any certificate is read.
  - The verifier and the gate both require the attested InstanceID to be one of the entry's.
  - There is no fallback.
  - The result is `deployment: { id, app, instance, bound: true }`.
  - An unbound entry, or an app selection, keeps the 0.4 rule (v2 where the policy allows it). Its result says
    `instance: null, bound: false`.
- **Enrollment.** `pvm-client instance --policy SRC --deployment ID (--relay URL | --relay-base URL) [--out FILE]` is how
  the policy's signer learns an InstanceID. It uses its own nonce and the policy's pins.
  - The expected app is the table entry's, so evidence for another app is refused before any certificate.
  - It seals and sends nothing.
  - The record keeps the nonce, the raw envelope, the whole verification and the policy serial. `--out` writes it to a
    new file and never overwrites one.
  - The relay's hub may publish a tunnel's attested InstanceID. That is a hint where to look, never a source.
- **Rotation is a policy update.**
  - A new instance is refused until a higher serial lists it.
  - An overlap serial may list both instances.
  - A later serial drops the old one; the older policy is then a refused rollback.

## Carriers (`src/carrier.js`; since 0.5.0)

- **`--relay URL`** is a carrier URL, used as given (the lab's).
- **`--relay-base URL`** is a platform relay compiled into the artifact: today only `https://api.enclave.host`, or a
  lab `http://127.0.0.1:<port>`. The carrier is then `<base>/x/<deployment>/pvm`, the relay's pVM deployment route
  (relay/pvm-serving.mjs).
  - The id in that URL is a route only. The app to expect is still the table's.
  - Any other base is refused, and so is giving both flags, or a base with no deployment.
- **The extension** grants exactly those origins in its manifest: `http://127.0.0.1/*` and `https://api.enclave.host/*`.
  - A test holds the manifest and `PLATFORM_RELAYS` equal.
  - A policy, a page or a relay cannot widen where the client sends: the list is in the artifact's bytes.
  - Its options take one of a carrier URL or a platform relay base, never both.

## The release rule (`src/gate.js admit`)

The client runs ONE verifier at runtime: web/pvm-verify.js, with node parity asserted in test/pvm-web-verify.test.mjs.
The Enclave verifier session's own verifier stays the offline differential.

What is shared is the **gate**, the verifier session's admission rule, held here by test/pvm-client-gate.test.mjs to its
40 vectors (`test/fixtures/verifier-admission/`, from d760725b). The client releases a request only when:
- the verdict is verified and admission-safe, with nothing omitted and every check true;
- every expectation came from the signed policy;
- the freshness is the client's own single-use nonce;
- for a browser, a v2 or v3 app key and its sealed window are present, and TLS pinning is never claimed;
- since 0.5.0, for a deployment bound to instances (`expect.instanceIds`): only a v3 verdict whose `instanceId` is
  listed releases, native and browser alike, and anything else HOLDs. This is the rule agreed with the verifier session.
  Its admission vectors are theirs to write, and this file mirrors them when they land.

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
- **Staging.** The CLI publishes the verified bytes **beside itself**, for the next start, and records them in its state
  (see State). The running process never imports what it fetched.
- **Running an update.** Staging never runs anything. A staged update runs only after an explicit `pvm-client activate`
  (see Activation); nothing activates by itself, and a network delivery never does.
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
- **Updates** (`src/update.js`; since 0.2.1). Two steps, in this order.
  - Publish, immutably. The verified bytes go beside the client under a content-addressed name,
    `pvm-client-<version>-<sha256>.mjs`. A uniquely named, read-only temp file is fsynced and `link()`ed to that name,
    which never replaces an existing file; then the directory is fsynced. An existing name must hold exactly the bytes it
    names; anything else there is refused and left untouched.
  - Commit, monotonically, inside the store's compare-and-swap and re-verified on the newest state:
    `staged = {version, sha256, file, sourceCommit}`, only if the version is newer than anything staged or running.
  - The same artifact again succeeds without recording or writing anything, and it re-publishes a staged file that
    went missing. Other bytes under the staged version are refused, and so is an older version.
  - Different bytes always take a different name, so no attempt can change a file a committed state names: not a
    refused one, a crashed one, or one whose commit failed. 0.2.0 renamed over `pvm-client-<version>.mjs` before
    deciding, so a refused re-signed build replaced the staged bytes (found by the verifier session; reproduced on the
    shipped 0.2.0 bytes by the tests below).
  - Leftovers. The same decision is also taken before publishing, as an optimization, so a stale or refused update
    publishes nothing. Only a stager that loses a race after publishing, crashes, or cannot commit leaves a file: an
    immutable one that no state names. The client never deletes published files. The install directory may be shared
    by several state directories, and without a lock no deletion is provably safe against a concurrent stager of the
    same bytes.
  - `pvm-client staged` reports the staged update and whether its bytes still match.

## Activation (`src/activate.js`; CLI only; since 0.3.0)

Agreed with the verifier session before it was built (its five fail-closed rules are marked [v]).
- **Roles.** The installed artifact, given out of band, is the LAUNCHER and the only root of code trust. It runs install,
  state, staged, update, activate and version itself. Only `run` executes a newer active version.
  - The code that verifies code is always the code installed out of band.
  - A broken active file can never lock out repair.
  - The price: the update and activation logic stays the installed version's until an out-of-band reinstall.
- **State.** `active = {version, sha256, size, file, sourceCommit}`, null at install.
  - It only grows, and active <= staged.
  - Every writer spreads the newest state, so no commit drops it.
  - There is no rollback command. Other code means staging and activating something newer, or reinstalling.
- **Exact bytes.** An artifact is read ONCE into memory and held to its record: sha256, size, and its own version line.
  Those very bytes go to `node --input-type=module -` over a pipe only the launcher writes. No path is opened twice, so a
  file swapped after the read cannot change what runs.
- **`activate`**, explicit only:
  - The staged record must be newer than max(active, the launcher). If it is already the active record, the command is
    idempotent.
  - The staged bytes are read once and verified.
  - START CHECK [v]: those bytes, from memory, answer `version` in a scrubbed environment:
    - NODE_OPTIONS removed;
    - HOME, XDG_CONFIG_HOME and the cwd set to a fresh scratch directory, removed afterwards;
    - no --state; a 30 s limit.
    They must exit 0 with exactly one line naming their recorded version.
  - Then the store's compare-and-swap records `active`, only if on the NEWEST state the staged record is still exactly
    the one verified and nothing newer is active. A concurrent policy commit or key rotation survives.
  - A refusal names its step [v]: `nothing newer`, `file` (with expected and found), `start check`,
    `changed while activating` or `commit`. It records nothing: a failed start check is an event, not a floor.
- **`run` under a newer active version.**
  - The active bytes are read once, verified and handed over with the user's args. The launcher replaces --state and
    --install-dir with the resolved ones [v]: a child fed over stdin has no path of its own.
  - The child also gets ENCLAVE_PVM_CLIENT_DELEGATED=<version>:<sha256> with NODE_OPTIONS removed.
  - ONE HOP [v]: a client started over stdin whose marker names its own version runs `run` itself, whatever the state
    says by then. It refuses any other command, and refuses a marker naming another version. A marker on a client
    started from a file is ignored, so an environment variable cannot make the launcher skip delegation.
  - The child's exit code is relayed as it is. A signal death is `{"error": "... ended by signal S"}`, exit 2, with no
    claim about what was sent.
  - The launcher never runs anything after the child ended.
- **Fail closed.** A missing or changed active file means `run` is refused at step `launch`, exit 2, with
  `{expected, found}` [v]. Nothing runs: there is NO fallback to the launcher's own older `run`, because a forced
  downgrade is worse than a denial.
  - `staged` reports both records with `bytesMatch` and exits 1 on a mismatch.
  - Repair: remove a wrong file, then `update` with the same artifact, which is idempotent and re-publishes it.
  - A repair is still an update, verified under the CURRENT keys. After a policy-key rotation, the original manifest's
    countersignature comes from a retired key and is refused. Repairing then needs the same artifact countersigned by
    the successor, which the release process issues again.
- **Crashes.** A crash before the activation commit activates nothing, and a retry works. A crash after it leaves the new
  version active. Nothing moves backward: not the serial, the keys, staged or active.
- **Scope.** The extension stages policies, not code. Its code updates are the browser's, through the store, which is not
  published here.

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
  - Update publication. The shipped 0.2.0 CLI reproduces the refused re-stage replacing the staged bytes; the current
    build keeps them. Also covered:
    - the same version with other bytes, concurrently in both orders; the same artifact twice, concurrently and in
      sequence (idempotent, and repairing a missing file); different versions racing;
    - a planted file under the content-addressed name;
    - write and commit failures, and a kill between publish and commit.
    Each asserts that the staged file's bytes, inode, mtime and mode are what was committed.
- test/pvm-client-ext-durability.test.mjs: the same in Chrome for Testing, with tabs opened through DevTools and a
  policy server that holds each tab's policy.
  - The shipped 0.1.0 extension, killed while stalled at the carrier, accepts the older policy afterwards.
  - 0.2.0 commits before the evidence request and refuses it.
  - Two tabs with an older and a newer policy, in both orders: the floor ends at the newer, including after a kill.
  - Two tabs with the same serial but different bytes: equivocation. The identical policy in two tabs is one commit.
- test/pvm-client-activation.test.mjs: the BUILT CLI in child processes. It uses harmless lab canaries that report each
  execution (token, argv, import.meta.url, cwd, environment, one-hop marker) to a file in the test's own directory, and
  real "next" builds of the client.
  - Activation, its scrubbed start check, idempotence, and `run` executing exactly the active bytes, one hop, with the
    resolved directories.
  - Exit 7 and a SIGKILL relayed, never retried.
  - A swap between verification and execution, by rename-over and in place, cannot change what runs. The naive "hash the
    path, then run the path" launcher, under the same barrier, runs the swap.
  - A swap loop of 24 launches, as evidence rather than proof: each runs the verified bytes or is refused, never the swap.
  - A missing or tampered active file: refused, no fallback, diagnosed, repaired.
  - Activation refusals: nothing staged, a tampered staged file never executed, three failing start checks.
  - Processes: two activators; activation racing a newer staging, both orders; activation racing a policy-key rotation,
    both orders; kills before the commit.
  - The real client activated and run end to end against the fake VM, one hop across a concurrent activation, and
    markers planted and mismatched.
- test/pvm-client-deployments.test.mjs covers deployment selection. The table's rules are checked (optional, closed,
  unique, admitted apps, canonical ids), and the built CLI is run against a fake VM:
  - a good selection reaches the VM's evidence with the table's app;
  - unknown, mismatched, repeated, non-canonical and tableless selections are refused before any evidence request;
  - a forged table, an unsigned "catalog" served as the policy, a rolled-back table and a changed table under the same
    serial are all refused.
  In process, on the Pixel's real v2 evidence, the table's app releases, and a table naming another app for the same
  deployment is refused before anything is sealed.
- test/pvm-client-extension.test.mjs, in Chrome for Testing: the extension's page lists the signed table, and a
  selection reaches the VM's evidence with the table's app. An unknown id, a disagreeing `?app`, and a repeated
  `?deployment` are each refused at `select` with no evidence request. Every page ran exactly once: the test clears
  Chrome's session files before each launch, because a killed Chrome restores its tabs and re-runs them.
- `client/tools/lab-next.mjs` derives a LAB next-version test artifact from a built base. Only two things change: the
  first line, labelled with the base's sha256, and the version constant. The derivation is deterministic, and apart from
  its first line it equals a source rebuild at the new version (the verifier session checked both). The activation test
  and the device run use it.
- Device: results/pvm-cpu-client-artifact (the CLI and the extension on the Pixel 10).

## What this does not solve

- **The first install and the root of code trust.** The user must get the artifact (its hash) and the anchors out of
  band, once. Nothing here can bootstrap trust from zero. The installed artifact is the launcher: its own bytes, and
  the node binary that runs it, are trusted as installed. Changing the launcher, or the update and activation logic,
  means reinstalling out of band.
- **The host.** A compromised machine or browser can subvert any installed client.
- **The extension store.** The store is trusted to deliver the bytes it is given (bounded by `minClientVersion`). The
  extension stages policies but cannot activate code. Nothing is published to a store.
- **Production keys and provenance.** Custody of the production keys and the Sigstore provenance is the owner's.
- **Traffic analysis and denial of service** by the relay, as in SEALED-STREAMING.md.
- **Restoring the state from a backup** (a disk or profile snapshot) restores its older floor. Whoever can do that
  controls the host. The tests kill the client, the launcher or the browser, not the machine: durability across
  whole-machine power loss rests on fsync (CLI) and on Chrome's storage backend (extension), and has not been tested.
- **Production code delivery.** Updates are signed with lab keys. There is no unattended activation, no production
  release key, and no Sigstore provenance.

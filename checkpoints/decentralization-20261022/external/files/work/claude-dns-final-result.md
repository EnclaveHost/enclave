# DNS responder (commit B): final review, fixes and evidence

**Repository:** `wo/work/enclave`, HEAD `a5493f60`. HEAD moved during this task; custody closure A was `ee8beb38`.

**Constraints kept:**
- Nothing committed or staged.
- No production, SSH, VMs, GUI, Wine, contracts or wallet writes.
- Mutations ran only in an isolated on-disk copy, deleted afterwards.

**Interface:** `work/dns-final-interface.txt`, written before the code changes.
**Inventory:** `work/dns-final-source-inventory.json`.

## Files for commit B (exact)

| File | Git state | sha256 |
| --- | --- | --- |
| `relay/dns-relay.js` | modified | `6620ac4eb3177f9ca63912b554b9d0e794741792800c52b1cad525d238cdf5af` |
| `relay/dns-challenge-attested.mjs` | untracked, reviewed, unchanged this round | `6d5ac110f03d47011c483bfa540138a560190f9d582034a392ac690d9050fb6b` |
| `relay/dns-challenge-shield.mjs` | untracked | `ef16dc7f8384f06a1f2c46cf0feb8c20a516614050c9035f1022797caa0edf89` |
| `test/dns-relay-attested.test.mjs` | untracked | `a72428f8abd1fa6c3eec843e98a38bc25e8f819d5e98d1833946479292584b02` |
| `test/shield-dns-challenge.test.mjs` | untracked | `3e7780ac2a334a930ecdb13e63d8f10cce119da15095be76256ca68bb9d82e9d` |
| `docs/network/independent-names.md` | modified; shared with earlier naming work, this task changed only "Running a challenge responder" | `29101a5e8141e19db5be271ab0dd90c8fc9414fae074653360ef775e70afe816` |

**Closure.**
- All 45 files in the relative import closure of these files are committed at HEAD. Examples:
  `relay/shield-host-session.mjs`, `relay/shield-app-policy.mjs`, the `relay/vbs-*` modules, `relay/hvnode-verify.mjs`,
  `windows/node/host-identity.mjs`, `windows/node/shield-verdict.mjs`, `network/authority-profile.mjs`,
  `network/contract-pins.mjs`, `isolation/m2/judge.mjs`, `test/fixtures/vbs-synthetic.mjs`.
- Both data files the tests read are committed: `contracts/deployments/network-profile-base.json` and
  `isolation/m2/front/testdata/attested-push.json`.
- So commit B needs exactly the six files above.
- Read-only imports were not edited. No custody, Windows, frontend, supervisor or contract file was touched.

**Wire formats are unchanged:**
- the guest push fields, `x-attested-sig`, the push nonce, the alias label, and the SNP and Shield documents;
- the host-session challenge and attest bodies.

## Finding 1 — confirmed: older admitted hosts were starved

- **Evidence:** `authorize` scanned `[...live.values()].reverse().slice(0, 32)` while admitting up to 128 sessions. With
  more than 32 live hosts, the guests of the oldest hosts got 403 "Shield attestation refused", although those hosts
  were admitted. Mutation M1 below restores the cut and makes the 128-host regression fail.
- **Fix** (`relay/dns-challenge-shield.mjs`):
  - **Every live session is searched,** newest first, bounded by `maxSessions` (default 128, now validated 1..256).
    The guest's IDKS-signed VBS report is the only authenticator the unchanged wire format carries. I kept that
    rather than adding a session identifier.
  - **Exact, cheap pre-selection.**
    - At attest, each session keeps the IDKS its TPM-authenticated boot log names, read with the same functions
      `vbs-app-verify.mjs` uses.
    - At push time, `verifyVbsVmReport` (the very function and inputs the full check uses) runs against each
      session's IDKS.
    - Every check but the signature is session-independent (the report-check order is fixed in
      `vbs-vm-report-core.mjs`). So a report failing any of those is refused once. A signature failure means "not
      this boot". Only a match runs the full `verifyShieldAppPolicy`.
    - A session whose IDKS could not be read is always fully verified, so nothing is silently skipped.
  - **Measured with 128 live sessions:** an accepted push takes 1.8–10 ms, depending on position; a refused full scan
    takes 4.8–5 ms. The naive full scan would cost 107.5 ms per push (also measured).
  - **No position effect.** A session verifies only reports under its own boot's IDKS, so its position can neither
    make another host's push pass nor block it.
  - **Capacity:** at most `MAX_LIVE_PER_EK` (4) live sessions per TPM endorsement key. Filling 128 slots needs 32
    genuine on-die TPMs, not one TPM registering many permissionless endpoints. A host re-attesting replaces only its
    own session. A full responder refuses a new host with 429 and never evicts.
  - **Registry freshness.**
    - Attest now requires the agreed entry to be **active**. The shared session module checked only endpoint and
      operator; I wrap its `registryEntry` rather than edit it.
    - At push time, the matched host's entry is re-read when older than `registryRecheckMs` (60 s; 5 s..10 min). One
      read is shared by concurrent pushes.
    - An agreed transfer, deactivation or refused registry read ends the session at once (403). It never returns by
      itself.
    - A failed quorum is 503 and keeps the session until its own expiry, because an outage is not a revocation.

## Finding 2 — confirmed: an unknown `/v1/shield-session/*` path hung

- **Evidence:** the real relay process on the pre-fix code answered `POST /v1/shield-session/unknown` with nothing
  ("no answer (TimeoutError) after 3002 ms").
- **Fix** (`relay/dns-relay.js` `attestedPush`):
  - `handle()`'s `false` becomes a JSON 404, and a rejection becomes 500, only if nothing was sent yet.
  - Every attested-mode request is answered exactly once.
- **`/v1/txt` also gained:**
  - 413 for a declared length over 64 KiB (before reading) or a streamed body over it;
  - an `ATTESTED_PUSH_READ_MS` read deadline (default 10 s, validated 1..60 s, then 408);
  - a global bound of 16 concurrent verifications (503 with `retry-after: 1`). The SNP path may fetch AMD KDS, and a
    Shield recheck may read the chain;
  - slot release on end, error and close;
  - no unhandled rejection: storage runs in an awaited function with `.catch`.

## Finding 3 — confirmed: no code, schema or binding check at the read block

- **Evidence:** `shieldAuthFromEnv` validated an address-only pin document and decoded a hardcoded 11-field `get()`.
  - The deployed Base registry is schema **4**: profile `network-profile-base.json`, digest
    `sha256:ee957827…4cb8`, registry `0x868eb7fc…ccac`, code `0x39911d6f…f518`, 5892 bytes, reviewed at block
    52830935.
  - Source HEAD declares schema 5, which appends `caps` and `region`.
  - The 11-field layout matches schema 4, as `host-identity.mjs` and `fleet.mjs` also decode it. But neither the code
    nor the schema was checked at the read block.
- **Fix: reuse the existing reviewed authority-profile mechanism.** No new authority; the operator pins the digest.
  - Required with `ATTESTED_SHIELD_POLICY`: `ATTESTED_SHIELD_PROFILE` and `ATTESTED_SHIELD_PROFILE_DIGEST`, checked by
    `parseProfile`, which refuses non-canonical or other bytes.
  - `ATTESTED_SHIELD_PINS` becomes optional; if set, it must name the profile's registry.
- **`shieldRegistryEntry`:** at one block of the committed `host-identity.mjs` `quorumReader`, two distinct RPCs must
  agree on raw facts: `getCode` hash and length, `registrySchema()` (a revert is a fact), and `get(hostId)`, decoded
  with the layout of the agreed schema. Only then is anything judged:
  - code different from the profile → refused;
  - schema different from the profile → refused, even schema 5, whose layout decodes;
  - one spoofing RPC → no quorum → outage (503), never a decision.
- **Supported layouts:** 4 and 5 (`REGISTRY_GET_LAYOUTS`); `shieldRegistryBinding` refuses a profile with any other
  schema.
- **No fallback:** no address book, fleet, relay or default RPC. `ADDRESS_BOOK_ADDRESS` and `BASE_RPC` now refuse
  startup in attested mode.
- **Trust boundary** (documented in `docs/network/independent-names.md`):
  - the operator's Shield policy pins;
  - the reviewed profile, pinned by its digest;
  - two or more distinct RPC hosts, two of which must agree;
  - the pinned Shield image's own chain checks of owner, lease and package (as on the SNP path).

## Item 4 — the review

- **Auth.** Unchanged and sound:
  - exact fields, method and op agreement;
  - a canonical P-256 SPKI and its signature over a domain-separated body;
  - the attestation nonce is this push;
  - the alias commits to deployment and owner.
- **Each family refuses the other's documents:**
  - an SNP push to a Shield-only responder is 403;
  - Shield evidence never reaches the SNP judge.
- **Replay.**
  - A push is valid for ±300 s and is idempotent: a replayed set rewrites the same value for the guest's own ACME
    account, and a replayed delete removes it.
  - Host-session challenges are single-use and live 60 s; attests are single-use.
- **Body read, concurrency and time:** see Finding 2. The session routes keep their verifier-derived caps, admission
  counts and read deadlines (from the prior round).
- **Lab mode:** SNP-only, explicit, and shown on `/health`. The Shield path has no lab mode.
- **Unchanged:**
  - T0-hv acknowledgement: every Shield verdict is `tier: hv-node`, `hostExcluded: false`;
  - measurement and platform pins;
  - `platforms: "attested"` semantics.
- **Startup:** each fallback, missing pin, bad digest, mismatched pins, duplicate RPC spelling or bad
  `ATTESTED_PUSH_READ_MS` exits 1 (tested).
- **Legacy DNS compatibility:** the fleet, U7, box-zone, read-only and shrink suites pass unchanged.

## Tests (real processes and HTTP; serial, 512 MiB heap cap, MemAvailable 17–18 GiB before every file)

| Suite | Result | Peak RSS of the test process tree |
| --- | --- | --- |
| `test/shield-dns-challenge.test.mjs` | 15/15 | 377 MiB |
| `test/dns-relay-attested.test.mjs` | 6/6 | 222 MiB |
| `dns-relay` | 12/12 | 189 MiB |
| `dns-relay-shrink` | 1/1 | 214 MiB |
| `dns-relay-u7` | 3/3 | 351 MiB |
| `dns-box-zone` | 4/4 | 193 MiB |
| `dns-read-only` | 4/4 | 214 MiB |
| `shield-host-session` | 3/3 | 177 MiB |
| `windows-shield-verifier` | 6/6 | 192 MiB |
| `relay-hvnode-owner-only-fleet` | 5/5 | 162 MiB |
| `custody-endpoints` | 3/3 | 187 MiB |

### New tests

1. **The real responder process end to end, on loopback only.** This is a fixture, labelled as one in the test:
   - the TPM, guest report, registry contract and chain are synthetic;
   - the profile is the reviewed live profile with only the registry code hash and length replaced, re-encoded and
     pinned by its own digest;
   - the RPCs are HTTPS on 127.0.0.2 and 127.0.0.3 (distinct quorum hosts), trusted only by the child through
     `NODE_EXTRA_CA_CERTS`.

   What it shows:
   - the host's attest goes over HTTP through the profile-bound quorum read; a stranger's signature is refused;
   - the guest push gets 200, and a DNS TXT query answers over **UDP and TCP**;
   - negative attestations through the process are 403: another boot's report, a forged binding, and an SNP document;
   - delete removes the value; legacy zones are REFUSED;
   - no unhandled rejection is logged.
2. **Every admitted host is searched.**
   - 128 hosts with distinct IDKS are live; hosts 0, 1, 31, 32, 33, 64, 96 and 127 are all authorized (0..95 were
     outside the old cut).
   - A foreign report is refused after a 5 ms scan.
   - Re-attesting does not grow the session count; a 129th host gets 429 and evicts nobody; the oldest host is still
     served.
3. **Live capacity per TPM:** the fifth host on one endorsement key gets 429; re-attesting is not a new slot; another
   TPM is not counted against it.
4. **Registry freshness:**
   - inactive and refused registry entries cannot attest;
   - within 60 s, no chain read;
   - an outage at recheck is 503 with the session kept, and two concurrent pushes share one read;
   - an operator transfer, deactivation or refused read ends the session (403), which does not come back;
   - option bounds are enforced.
5. **The profile-bound registry read,** over two real local JSON-RPC servers with the committed quorum reader:
   - the real profile yields `{0x868e…ccac, 0x39911d6f…, 5892, "4"}`;
   - a schema-3 profile is refused;
   - an honest pair gives the entry; one spoofing `get()` is an outage;
   - agreed other code, schema 5, or a reverting schema getter are refused;
   - end to end, a code change after attest ends the session at the next recheck, and an inactive host cannot attest.
6. **The relay process with Shield on:**
   - starts only with the profile and digest;
   - refuses a wrong digest, mismatched pins, duplicate-spelled RPCs and an address book;
   - `/health` shows the registry pin;
   - unknown session routes get 404 (they used to hang); a GET is 405.
7. **SNP relay push bounds:**
   - unknown routes get a 404 within 1 s;
   - 413 for both declared and streamed bodies; 408 at the read deadline;
   - with 16 bodies held, the next request is 503 with `retry-after`;
   - after the held clients disconnect, a genuine push is 200.
   - `ADDRESS_BOOK_ADDRESS`, `BASE_RPC` and a bad `ATTESTED_PUSH_READ_MS` refuse startup.

### Mutation checks (isolated copy; each mutation must fail its tests)

| Mutation | Result |
| --- | --- |
| M1 newest-32 cut restored | fail |
| M2 no per-EK cap | fail |
| M3 no registry recheck | fail ×2 |
| M4 outage treated as revocation | fail |
| M5 inactive host admitted | fail ×2 |
| M6 registry code not judged | fail |
| M7 registry schema not judged | fail |
| M8 unknown session route unanswered | fail |
| M9 pre-selection inverted | fail |
| M10 no push read deadline | fail |
| M11 no global verification bound | fail |
| M12 no declared-length check | fail |
| M13 only the `close` release removed | **survives**: the `error` path also releases (benign redundancy) |
| M13b both disconnect releases removed | fail (a genuine push is 503) |
| M14 pins/profile registry mismatch accepted | fail |
| M15 `BASE_RPC` fallback allowed | fail |

The isolated copy was restored byte-identical after every mutation and was then deleted.

## Remaining gates

- **No real hardware or chain.**
  - No real Windows TPM boot log or Shield guest; no live Base RPC read. The registry facts were served by local
    fixtures. Only the pin values come from the live reviewed profile.
  - The Shield-direct guest candidate `c7084346` remains unactivated.
  - No responder was deployed or reconfigured.
- **The responder trusts its RPC pair,** like every quorum reader here. Two colluding RPCs can misstate a registry
  entry; they can only do that, not forge a TPM session or a guest report.
- **Doc owned elsewhere:** `docs/network/independent-shield-image.md` (Shield image owner) still says
  `ATTESTED_SHIELD_PINS` is required. It should name `ATTESTED_SHIELD_PROFILE` and `ATTESTED_SHIELD_PROFILE_DIGEST`
  (required) and PINS (optional). I did not edit it.
- **Clock-dependent bounds:**
  - registry revocation reaches a live session within `registryRecheckMs` (60 s) of the next push, not instantly;
  - with no pushes, the session simply expires after 10 minutes.
- **Leftover fixtures:** 167 recent `/tmp/shield-dns-*` fixture directories remain. They were newer than 2 minutes at
  cleanup, and I left them in case a parallel task was using them. I removed 1044 of my older ones (5.8 MB). The
  before-copies under `/tmp/dnsfinal` are removed below; their hashes:

  | Before-copy | sha256 |
  | --- | --- |
  | `dns-relay.js` | `6d25011057fd…` |
  | `dns-challenge-shield.mjs` | `6a25f5038afd…` |
  | `shield-dns-challenge.test.mjs` | `b714f30cd501…` |
  | `dns-relay-attested.test.mjs` | `672053d51147…` |

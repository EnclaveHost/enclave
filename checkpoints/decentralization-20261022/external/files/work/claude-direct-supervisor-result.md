# Direct-only supervisor: Claude result (2026-10-19)

Worktree `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`, branch
`decentralize/nan-retirement`. Nothing is committed or pushed, and nothing was run
live: no SSH, VM, chain or wallet action, and no private configuration was read.
I edited only the files listed below. The other working-tree changes
(`custody/v2/*`, `docs/network/cold-host.md`, `docs/design/decentralized-architecture.md`,
`cache/test-failures`) are not mine.

## Changed files

- `supervisor.js` (+~140 lines):
  - `ISOLATION_DIRECT_ONLY` flag, plus a pure `directOnlyProblems()` startup check
    that exits with status 2 and lists every problem.
  - It requires the SNP/vm tier, `ENCLAVE_CONTRACT_PINS_FILE` pins, no address book,
    explicit package replicas, and an explicit `IPFS_GATEWAY` (or storage plan).
  - It requires `SECRETS_API`, `DOMAINS_API`, `CERTS_API`, `DNS_API` and
    `APP_CERT_DOMAIN` to resolve empty. An unset `SECRETS_API` or `DOMAINS_API`
    counts as Enclave, because both default to `api.enclave.host`.
  - It requires `ISOLATION_RELEASE` off.
  - The refusal is checked in three places: `considerClaim` (uncommitted
    deployments get a logged reason), `launchSpec` (a non-committed launch throws
    before the relay path) and `spawnContainer` (a non-direct create throws).
  - **Bug fix (both modes):** `directPackageFor` now calls
    `fetchPackage(..., {allowHttpIPs:true})`. HTTPS rules are unchanged, and HTTP
    DNS names, credentials, queries and redirects are still refused by `fetchPackage`.
  - New `DIRECT_CLAIM_SELFTEST` seam: it replaces bindings only, the same way the
    existing seams do.
- `test/direct-only-supervisor.test.mjs` (new, 4 tests).
- `docs/network/direct-host-control.md` (new): operator environment, what the mode
  removes, the evidence, trust assumptions and remaining gates. It links to
  `cold-host.md` and `native-client.md`.
- `test/bootstrap-supervisor.test.mjs`: not changed.

## Audit: which paths actually call Enclave (from source, not from the default URLs)

For a `guestBootstrap` deployment, the claim, launch, restart and adoption path
already avoided the relay:
- `released = direct` skips the release list.
- `hasSecrets` comes from the package.
- `g.configCid` is cleared, which skips `configCidClaimRefusal`.
- `launchSpec` returns before `depHasSecrets`, `fetchDepSecrets` and `fetchDepDomains`.
- The ticket pump signs custody locally and throws if a ticket is requested.

Paths that still reached Enclave without this mode:
1. `refreshCustomDomains` runs every minute for every running on-chain record
   (direct ones included). It POSTs to `DOMAINS_API`, which defaults to
   `api.enclave.host` (`supervisor.js`, the `DOMAINS_API` constant and its
   setInterval). It is optional, but it is a real call and it discloses which
   deployments this host runs.
2. The prefetch-backoff probe `gatewayServes` defaults to `https://ipfs.enclave.host`
   when there is no storage plan. It is advisory and runs only after a prefetch
   failure.
3. Package fetch with literal-IP HTTP sources failed validation (fixed above).
4. With `CERTS_API`/`APP_CERT_DOMAIN` set, the guest WebPKI loop uses the platform
   certificate service and the `SECRETS_API` expected-guest fetcher; ACME uses
   `DNS_API`.

All of these are off in direct-only mode.

Checked and found to make no outbound call: `SESSION_API_HOSTS` (it only lists
audiences inbound signatures are matched against), and the SIWE/CORS defaults
(inbound browser flows).

## Tests

`test/direct-only-supervisor.test.mjs` runs the actual `supervisor.js` with a clean
environment. Results:

1. **Full sweep.** Claim sweep → `considerClaim` → `gateAppReference` (real catalog
   logic) → `tryClaim` → `adopt` → `launchSpec` → `spawnContainer` → real ticket pump.
   - Literal-IP replica A refuses and B serves.
   - Every recorded fetch went to A or B: **zero other outbound calls**.
   - Every chain read hit the pinned ledger or catalog only.
   - The only transaction was `claim(id, enclaveId)` on the pinned ledger.
   - The posted `derive` equals a record the test writes out independently from the
     catalog answer.
   - The exact package bytes were sent with no config or release flag.
   - A legacy row in the same sweep was refused.
2. **Hostile sources.** None of these produced a claim transaction, prefetch or guest
   create:
   - corrupt bytes, plus another owner's validly hashed package;
   - a redirect, plus an unreachable replica;
   - an owner transfer (scope mismatch).

   An owner change during prefetch stops the claim before any transaction. An HTTP
   DNS-name source refuses the whole list with zero requests.
3. **Restart.** The same committed guest is adopted with no transaction and no
   delete. A held guest with a stale package hash is deleted and replaced.
4. **Startup refusal** (exit 2) for: unset `SECRETS_API`, unset `DOMAINS_API`, no
   pins, no replicas, no `IPFS_GATEWAY`, `ISOLATION_RELEASE=1`.

Regression check: with `allowHttpIPs` temporarily removed, test 1 fails (zero
replica calls; the claim is declined). It was restored.

The full set of 57 test files that drive `supervisor.js`: **633 tests, 631 pass,
0 fail, 2 skipped** (pre-existing meta-test skips). `node --check supervisor.js`
passes.

## Remaining dependencies (concrete)

1. **The supervisor's own attestation.** `teeOk()` needs `ATTESTATION_URL` (the
   loopback document from the measured control image). A cold host needs a booted
   control guest carrying this environment; it has not been built or booted.
2. **Chain reads are not a quorum.** `chainClient` uses viem `fallback` over
   `BASE_RPC` plus public providers: the first answer wins, with no agreement check.
   This affects which work is claimed, not app authorization: the guest re-checks
   the commitment through its measured RPC quorum. A quorum reader for the
   supervisor's ledger and catalog reads is not implemented.
3. **Admission without a wallet policy** falls back to `approvalVerdict`, i.e. the
   catalog owner's approval flags. Only `ENCLAVE_HOST_*` wallet policy removes that
   gate, and owner acceptance plus policy commitment need the owner's wallet.
4. **Unsupported in this mode:** browser naming and WebPKI (ACME, platform certs,
   custom domains). Route publication lives in the network agent, outside this file.
5. **Replicas.** Package and component replicas are operator choices; today's public
   ones are Enclave-operated, and there is no retention guarantee.
6. **Restart with an old lease.** If the host still holds a live lease for a legacy
   deployment (for example after switching modes), it is refused on resume. The
   existing resume-first rule then holds new claims until that lease lapses. This is
   by design, and documented here only.
7. **Not done:**
   - a live claim plus hardware boot through this mode on a funded, active
     owner-committed deployment (test deployment `0x8750…` is suspended);
   - custody-v2 quorum availability;
   - production migration.

   The full decentralization goal is not complete.

# Independent owner management (S3): Claude result (2026-10-19)

Worktree `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave`. Nothing is committed or pushed. No live, chain,
wallet, SSH or production action was taken, and no private keys or configuration were read. I did not touch
`supervisor.js`, `native-client.mjs`, the CLI, site, custody, bootstrap, Windows or isolation files, or any of the
concurrent work in progress.

## Trust root

The management endpoint is authorized by the **operator wallet that the pinned ledger names as the deployment's current
`runnerOperator`**. The client reads it from a fresh lease; directories additionally require the registry's active
operator for that runner.

- The endpoint record binds one public literal IP, a port and a TLS SPKI digest. It carries a sequence, expiry and
  withdrawal.
- The host principal is kept separate from the tenant guest's SNP proof and never inferred from it. The attestation
  document returned through management is labelled host-reported.
- No measured host identity is verified. The owner trusts the operator currently running the deployment, which it already
  depends on to run the app.

## Files

New:
- `network/management-record.mjs`:
  - `managementBase(runner)` derives the signature base `enclave-management.invalid/<runner>`; the operator cannot
    choose it.
  - Record validation: exact keys, public literal IPs only (`isBlockedHost`), 24 h maximum lifetime, withdrawals.
  - Sign and verify.
  - `managementFor(envelopes, lease, {floor})`: accepts only the lease's runner and `runnerOperator`; the newest sequence
    wins; refuses equivocation and rollback below the floor.
- `network/management-routes.mjs`: the fixed table of four operations (status, logs, attestation, restart), an exact
  target builder, and strict parsing (no prefixes, encodings, extra queries or other methods).
- `network/management-gateway.mjs`: a TLS 1.3 listener with the host's management key. It requires, in order:
  - the route table;
  - `EnclaveSession` only (no bearer or cookie);
  - no body;
  - a fresh lease naming this runner;
  - the session verified with scope, single-use and fresh, against this runner's base;
  - refusal checks against the current ledger owner.

  It then forwards once to a loopback-only supervisor upstream, streams the answer with byte limits, keeps restarts
  single-flight per deployment, and reports `restart_outcome_unknown`.
- `network/management-host.mjs`: a runnable host service. It builds and signs the record (sequence = issue time in ms),
  publishes it to operator directories as public data (`redirect: 'error'`, no credentials), renews it at half its
  lifetime, can withdraw it, and runs the gateway. The CLI form requires a private operator key file.
- `network/management-client.mjs`:
  - `sessionRequestSigner` produces exactly the SDK `signApiRequest` format.
  - `ManagementClient` offers `status()`, `logs()` (streamed), `attestation()` and `restart()`.
  - Each call resolves a pinned lease, reads literal-IP directories, keeps a persistent per-runner floor, pins the TLS key
    before writing anything, signs per request and never retries.
  - Errors carry `sent` and `outcomeUnknown`.
- `test/management-plane.test.mjs`: 8 tests.
- `docs/network/independent-management.md`: trust root, checks, API, exact host setup and the wiring still missing.

Modified:
- `network/public-directory.mjs`:
  - New `management` kind in `accept`. It is admitted only from the registry's active operator for the runner, with a
    sequence floor that refuses stale or equivocating records, under the existing capacity bound.
  - `snapshot()` includes unexpired records, withdrawals included.
  - `import()` replicates them only with the new opt-in `importManagement`. App clients such as the native client do not
    pull every host's record.
  - Older state without `management` loads as `{}`.

Not changed: `route-record.mjs`, `enclave-network-host.mjs`, `session-api-auth.mjs`. The existing base mechanism plus
`SESSION_API_HOSTS` configuration was enough.

## Validation

`test/management-plane.test.mjs`, 8/8 pass. Real pieces: TLS, the `PublicDirectory` HTTP server, P-256 session
signatures and the shared session verifier, secp256k1 operator signatures, and every HTTP hop. Test doubles: chain reads,
and the supervisor, which is a stand-in running the same session verifier with the `apiBases(SESSION_API_HOSTS, PUBLIC_URL)`
construction `supervisor.js` uses. `supervisor.js` itself was not run; nothing here is SNP.

1. **Status, logs, attestation.** All three work.
   - The logs' first chunk is consumed before the host finishes.
   - Every client fetch went only to the operator directory's `/v1/network/records`; any other origin threw.
   - The supervisor saw exactly the three expected requests.
2. **Restart exactly once.**
   - A successful restart counts once.
   - When the supervisor received the request and then the connection dropped, the client got
     `restart_outcome_unknown`.
   - When the answer was cut mid-body, the client got `outcomeUnknown` with `sent: true`.
   - Four calls in total produced four supervisor hits.
   - A replayed signed restart was refused with 401 before reaching the supervisor.
3. **Wrong owner and runner mismatch.**
   - Changed ledger owner: 403.
   - The gateway's host is not the current runner: 409.
   - The lease names another runner: the client refuses with no gateway connection.
   - Zero supervisor hits.
4. **Bad records.**
   - A record signed by a foreign key is refused at the directory.
   - A withdrawal refuses.
   - A stale replay after the withdrawal is refused by the client floor.
   - Equivocation is refused at both the client and the directory.
   - An expired record is never current.
   - Only the one valid request reached the gateway.
5. **Wrong TLS key.** The client refuses with `sent: false`; the gateway handled 0 requests and decrypted 0 bytes.
6. **Disallowed requests return 404 with zero supervisor hits.** These include admin, listing, DELETE, app-token,
   prefix, extra-query, dot-segment, encoded, `/x/` and wrong-method requests. Also refused:
   - a bearer token (401);
   - another runner's base, or the relay's (401);
   - a cross-deployment signature (401);
   - a request body (413).
7. **Private targets and unsafe upstreams.**
   - Records with private, loopback, link-local or ULA addresses, or names, are refused.
   - Over-long records and extra keys are refused.
   - Non-loopback, HTTPS, `localhost`, path or credential upstreams are refused.
   - A record signed by a key the lease doesn't name is refused.
8. **Publication** goes to operator directories with `redirect: 'error'` and no credentials; one refusing directory
   doesn't block the others.

**Mutation checks.** Disabling each of the following made its test fail; all files were restored:
- the gateway's runner check;
- the client's TLS pin;
- the gateway's route allowlist;
- the client's lease-operator check.

**Regression.** All 67 test files that import `network/` modules: 370/370 pass, including `public-directory`, the native
client and session auth.

## Wiring still needed (outside my scope; exact changes)

1. `network/directory-server.mjs`:
   - add `'/v1/network/management':'management'` to the POST path-to-kind map;
   - pass `importManagement: true` to `new PublicDirectory(...)` in `runDirectory`.

   Until then, records can't be POSTed to running directories. Clients read them already.
2. Supervisor environment on each host: `SESSION_API_HOSTS=enclave-management.invalid/<runner>`. Add
   `api.enclave.host` only to keep the relay path, because the value replaces the default.
3. The metal/control launcher must start `node network/management-host.mjs <config>` beside the supervisor, publish the
   listen port, and provide the management TLS key and the operator key file.
4. The CLI (`enclave logs/attest/restart`, S7), the site and the Windows `hv-node` agent are not integrated with
   `ManagementClient` yet.

## Residual gaps

- No measured host binding: the management key is not tied to the control CVM's SNP report.
- Only SessionVault credentials work. There is no direct EOA or SIWE per-request credential, and wallet-held deployments
  need `setDelegate`.
- Private-app sign-in (`app-token`) and CPU profiles are not exposed.
- Logs have no follow mode, because the supervisor only offers a tail.
- Rate limiting is only an in-flight concurrency bound.
- A host that goes dark leaves its record until expiry (at most 24 h). It becomes irrelevant as soon as the lease names
  another runner.
- There is no live end-to-end run.

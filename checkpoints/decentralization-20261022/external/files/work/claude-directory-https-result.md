# Directory HTTPS activation — result (FINAL, 2026-10-20)

Workstream: remove the hidden minipc dependency from public HTTPS service-directory access, and prepare its rollout.
Candidate: `work/directory-https-activation/` (isolated). Interface: `work/directory-https-interface.txt` (final).

**Nothing was applied in this round:**
- no host change, reload or Caddy mutation;
- no `activation/journal.jsonl` exists (the controller was never run against a host);
- no key read, signature or chain write;
- no edit to `work/enclave` or any other candidate.

SSH use was read-only: `cat`/`sha256sum`/`ls` of the bootstrap-TLS Caddyfile and unit files, `ss`, and `cat` of the deployed Caddy binary.

## 1. Verified problem (live, read-only)

The literal-IP sites in `/etc/enclave-bootstrap-tls/Caddyfile` route `@recovery` paths, `/v1/*` included, to `https://127.0.0.1:30443`. That address is an sshd reverse tunnel to the minipc control API (Host `api.enclave.host`). Public 443 is the node provider's SNI router, which forwards to this Caddy on 127.0.0.1:28443.

Pre-activation readback, `activation/evidence/pre-activation-<ip>.json`, taken on all four hosts with an arbitrary Origin:

| Request | Answer |
| --- | --- |
| `GET /v1/network/records` | 404, no ACAO (minipc has no such route) |
| `OPTIONS` | ACAO absent |
| `/native/status` | 200 |

The ServiceIndex ad (operator `0xC9D0835C…`, slot 0, sequence 1) lists only `http://<ip>:8188/`.

## 2. Baselines (exact; re-read live 2026-10-19T23:42-07:00, unchanged)

| host | IP | baseline sha256 | result sha256 |
|---|---|---|---|
| us-west | 134.199.235.187 | 8cc8d22ecec3599577019c09e371efa5fd4364a56838b10d6b4eef17fe075554 | ad44dd6275222bbf63afca7375678c17577458f3e45887cd1d862300f3245150 |
| eu-central | 134.209.248.172 | 754c0131ab041eb813f5d32a75a4d35baa33aff67fa1456e3b7276dd185a693b | 46d081d7692e37ee15e17f2a95d957e9c3b6a3179850ce99cf96a72d6a8bc647 |
| ap-southeast | 165.245.191.129 | 6be49e3ae0f3189db1254bcd09ed4889e4a268435ba33a9c9073d320ad7ea310 | a10251bd1313aba13e394b2d1c9df4142654b133136fa5e8cf6eb264ae56ca35 |
| ca-east | 146.190.246.39 | 7be18afc6141a828a7490d83925d09b739d9e6312327c4c9aaa68334974b3d9f | e5b0e55fff079be14768b6e6025ed829e0d7330542cc3ba35eadf892ea2209cc |

- **Patches.** `patches/<host>.Caddyfile.patch` holds the same single hunk on every host (patch sha256 `af01b8f4…`). It inserts the fragment immediately before the `@recovery` matcher of the `https://<ip>` block. Every other byte is unchanged.
- **Deployed binary.** `/usr/local/lib/enclave-caddy/caddy` v2.11.4, sha256 `b7105518…c64d9`. The same binary is in `test/bin/caddy-2.11.4` and is used by every test.
- **Manifest.** `activation/manifest.txt`, sha256 `8f28968086e4e8a6037ea844b4a86a5be9caa0fd8c56da538b4d4a1e29d31ac7`. It covers the baselines, results, transform, host program and host parameters. It changed from `addace99…` after the final file-write fix to `remote.py`; `prepare.mjs gates` recomputes it.

## 3. The route (transform.py, deterministic and idempotent)

- **`@publicDirectory`.** `GET`/`POST` of exactly `^/v1/network/(providers|qualifications|routes|records|management|policy/0x[0-9a-f]{64})$`, with no `Authorization` and no `Cookie`.
  - Proxied to `127.0.0.1:8188`, dialed from `local_address 127.0.0.2` (verified in the fixture: the directory saw 127.0.0.2 only).
  - Request body limited to 64 KiB; `Authorization` and `Cookie` stripped on the way to the directory.
  - `Access-Control-Allow-Origin "*"` is set once at the handle, so it is also on Caddy's own 413/502. The upstream copies of ACAO, `Set-Cookie`, ACAC and `X-Content-Type-Options` are dropped.
- **`@publicDirectoryPreflight`.** `OPTIONS` with ACRM `GET|POST` (`header_regexp`), no `authorization` in ACRH, no `Cookie` → Caddy answers 204 with ACAO `*`, methods `GET, POST`, headers `content-type`, max-age 600.
- **`@publicDirectoryUnknown`.** Any other `/v1/network/*` path (case-insensitive) → Caddy answers 404 `{"error":"not a public-record path"}` with ACAO `*`. The exceptions are `/v1/network/byo/*`, `/v1/network/status/*` and `/v1/network/policy/*`.
  - The relay's own network handler answers 404 for exactly those other paths (`relay/network-api.mjs:145`). So the only observable change is that minipc is no longer involved.
- **Legacy compatibility (unchanged; minipc):**
  - `byo/*`, `status/*`;
  - policy ids that are not lowercase hex;
  - other methods on grammar paths;
  - credentialed grammar requests;
  - everything outside `/v1/network/`.
- **Behaviour change.** A credential-free `POST /v1/network/policy/<id>` via `https://<ip>` now lands in the host directory instead of the relay store. BYO stays relay-only.

## 4. Tests and actual exits

All runs used `test/guarded.sh`: a transient scope with `MemoryMax`, `MemorySwapMax=0`, the shared memory-guard tree cap and a 16 GiB floor. The start thresholds come from the coordinator's scoped exception: 17408 MiB for 256 MiB jobs, 17664 MiB for 512 MiB jobs. One job ran at a time.

Fixture suites ran under `unshare -rn` (loopback only); a positive check showed that an external fetch is refused.

### Caddy validate

`logs/validate.out`: all 8 configs (4 baselines, 4 results) VALID with the deployed binary, exit 0, peak 72 MiB.

Earlier failures, kept as history:
- **Invalid syntax.** The first `GET POST` header matcher was invalid (`malformed header matcher`). Superseded set: `superseded/result-invalid-header-matcher/`.
- **Duplicate `nosniff`.** Superseded set: `superseded/result-duplicate-nosniff/`.
- **No ACAO on Caddy's own 413.** Superseded set: `superseded/result-acao-missing-on-413/`.
- **Unknown paths sent to minipc.** Superseded set: `superseded/result-unknown-network-paths-to-legacy/`.

### Proxy fixture: `logs/fixture-all.final.log`

`run-fixture.sh --all` exited 0. Each of the 4 hosts passed 8/8, and the activation fixture passed 10/10; peak 329 MiB.

Per host, B is the real baseline and R the real result. Both are rewritten only by `fixture-config.mjs`; the substitutions are enumerated and counted, and B/R differ by exactly the fragment (asserted).

The cases, per host:
- **Arbitrary-origin `GET`.** providers, records, routes, policy, qualifications and management are answered by the local directory with ACAO `*` and zero control-tunnel hits. Under B, the same requests go to the tunnel with no ACAO.
- **Preflight.** `GET`/`POST` preflights are answered on the host; a credentialed preflight stays legacy.
- **Control tunnel stopped (B returns 502), using the real `DirectoryClient`:**
  - signed provider create → read (signature and registry-operator check by the client) → update;
  - qualification;
  - owner policy nonce 1 → 2 (read back through `DirectoryClient.policy`);
  - a qualified route publication (accepted by the directory's real route/qualification/price checks);
  - a management record via `publishManagementRecord`;
  - the records snapshot shows all of them.
- **Refusals by the local directory (400, with ACAO):**
  - tampered provider;
  - foreign operator;
  - stranger-signed policy;
  - stale nonce;
  - policy path mismatch;
  - untrusted checker;
  - forged management signature;
  - malformed JSON.

  Also refused: oversize bodies (413) and query strings (400). The refused writes changed nothing.
- **Legacy cases.** byo, status, mixed-case policy, `PUT`/`DELETE`/`HEAD` and credentialed requests stay legacy, byte-identical to B. Nine unknown paths, each sent as `GET` and as `POST`, get a host 404 and never reach minipc.
- **Legacy corpus.** 29 requests are byte-identical between B and R (status, body sha, security headers, upstream use). The IP-site recovery paths, enclave.host pages/installers/ipfs, www redirect, ipfs host, bootstrap host and the http ACME hops all behave the same.
- **Directory down.** 502 with ACAO and no fallback; recovery once the directory returns.
- **Invariant.** Every request the directory received came from 127.0.0.2. Any that was not exactly the grammar in the directory's own parse (`%70roviders`, `//v1/...`) was refused with 404.

Earlier failed runs, kept as history in `logs/fixture-us-west.try1-3.log`:
- my fidelity comparison;
- the double `nosniff` (a real config issue);
- a qualification window over 10 minutes;
- a provider "update" priced above the policy maximum, which the directory correctly refused;
- 413 without ACAO (a real config issue).

### Activation fixture (exact `remote.py`, real Caddy reload): `logs/activation.final.log`

`--activation-only` exited 0 with 11/11 (first passing run, before the final file-write review: `logs/activation.try4.log`, 10/10). `remote.py` runs as an awaited asynchronous child with a bounded timeout, and `after()` closes and awaits every server and Caddy. There is no forced exit.

The cases:
- **Guards.** drift, foreign backup, foreign prepared file and tampered bytes are each refused with nothing written.
- **Locks.**
  - Own lock held → refused; site-release lock held (a real util-linux flock holder) → refused.
  - An initially ABSENT site-release lock is created and held, and never unlinked.
  - A missing release root → refused with nothing written.
  - During an apply, a concurrent `flock -n` on the site-release lock (what a site release does) fails (exit 1); it succeeds after the run.
- **Apply.** validate → backup → install by compare-and-swap → reload → readback → active; a re-run does not reload.
- **Rollback.** Verified restore; a re-run is a no-op.
- **Lost connection.** If the result was installed but never reloaded, apply reconciles with exactly one reload.
- **Directory down.** Automatic rollback, with the restored state verified.
- **Cross-writer race.** Another writer replaces the Caddyfile while readback is failing → `rollback-refused-drift`; their bytes survive; apply and rollback then refuse.
- **Baseline reload fails during rollback.** Reported as `rollback-unverified` with the route still running (not "restored"), then reconciled by one baseline reload.
- **Reload cap.** Refused for operator review.

History:
- `activation.try1.log`: a coordinator-stopped run under the old blocking `spawnSync`. It is not counted.
- `try2`: the lock-holder harness kept the lock through its `sleep` child.
- `try3`: a real `remote.py` bug, the wrong snapshot path to `providerId`, which `public-readback.mjs` had too. The automatic rollback in that run worked and was verified.

### Write path (`test/remote_write_test.py`): `logs/remote-write.try1.log`

7/7, exit 0. The `os.write` count is no longer ignored. The cases:
- injected short writes (777 bytes per call) are completed to the exact bytes;
- an ENOSPC midway leaves the target untouched and removes the temp file;
- a "lying" write (claims all, writes half) is caught by the read-back length/digest check before rename;
- a zero-progress write fails cleanly;
- compare-and-swap refuses an unexpected target;
- `write_new` never replaces an existing backup/prepared file;
- the peer lock is created with `O_NOFOLLOW`, held exclusively and never unlinked; a missing root and a symlink are refused.

### Controller (`activate.py`): `logs/controller.final.log` (and `controller.try1.log`)

10/10, exit 0, using a fake ssh/readback (no host). The cases:
- the happy path;
- a wrong approval contacts nothing;
- a lost response (ssh timeout) → `unknown`; that blocks further runs, and `--reconcile` runs status, then apply;
- an unparsable answer → `unknown`;
- a public-readback timeout → scoped rollback, then `rolled-back-verified` with an inactive public view;
- an unverified rollback → `unknown`, reported as not restored;
- a rollback whose public view disagrees → `unknown`;
- `rollback-refused-drift` is recorded and blocks;
- a host refusal stops the rollout;
- an operator rollback is verified.

### Negative controls

Each suite was run with one injected failing assertion. All exited 1, as required:
- the controller (`logs/controller.negative-control.log`);
- the write-path test (`logs/remote-write.negative-control.log`);
- `directory-https.test.mjs`;
- `activation.test.mjs`.

The fixture negative-control step itself exited 0, meaning both injected runs failed (`logs/fixture.negative-control.log`).

`run-fixture.sh` refuses `none` and unknown host names (exit 2). An empty selection is an error.

## 5. Unsigned ServiceIndex update (`service-index/prepared.json`, sha256 a83913ba…)

Read through `agreedRead` from two agreeing RPCs, publicnode and drpc, at block 52844576. The code hash matched the pin, and the proof guard saw 0 forbidden attempts.

| Field | Value |
| --- | --- |
| Operator | `0xC9D0835C…`, slot 0, kind directory (1), version 1 |
| Sequence | 1 → 2 |
| Descriptor | Zero, the same as sequence 1 |
| TTL | 30 days (2592000 s; sequence 1 observed 2591981 s) |
| Endpoints | `https://134.199.235.187/`, `https://134.209.248.172/`, `https://165.245.191.129/`, `https://146.190.246.39/` |
| Calldata | `publish(...)`, keccak `0x1999a48edd19e2c161daf40badb6293674f3a24712bfcaac41bf5b3d6567ff14` |
| Gas | Estimate 103355; limit 134361; max fee 0.0000016 ETH |
| Operator balance | Sufficient |

The request is unsigned and nothing was broadcast.

`prepare.mjs gates` was run and exited 1, as expected (`service-index/gates.json`):
- A1 (activation journal): not met.
- A2: skipped, so that no POST probe hits the production minipc before activation.
- A3: OK — sequence still 1, read from publicnode and mainnet.base.org at block 52844584.
- A4: fresh until 2026-10-21T06:41Z. After that, re-prepare.

## 6. Who owns the config (so the next release does not erase it)

- **No in-repo generator.** Nothing in the repo generates `/etc/enclave-bootstrap-tls/Caddyfile`.
- **Where the block came from.** The literal-IP block was appended by `work/control-vm/prepare-native-ingress.py`. That script refuses to re-run because it asserts `default_sni` is absent.
- **Other writers do not touch it.** Site releases (`work/logo-site-hotfix/activate-final.py`, and site-release's documented one-time migration) change only the `enclave.host`/`ipfs.enclave.host` blocks, by exact string match. site-release itself never writes the Caddyfile; it swaps a symlink, writes `headers.caddy` and reloads.
- **Owner for these hosts:** `transform.py` plus `activation/`.
- **Spec in the repo:** an isolated docs patch, `patches/docs-open-participation.patch` (sha256 `6476fdb8…`). It applies to the base file `docs/network/open-participation.md` (`4b6da1fd…`, HEAD abe86262; `git apply --check` OK; not applied). It adds "Serving a directory to browsers (HTTPS)" with the exact protocol rules for any operator.

## 7. Activation sequence (root, after review)

1. `python3 work/directory-https-activation/activation/activate.py status --hosts us-west,eu-central,ap-southeast,ca-east` (read-only). Expect `isBase` on every host.
2. `activate.py apply --hosts us-west --approve 8f28968086e4e8a6037ea844b4a86a5be9caa0fd8c56da538b4d4a1e29d31ac7`.
   - Expect `verified-active`.
   - On `unknown` or `rollback-refused-drift`: run `status`, then `--reconcile`. Never repeat blindly.
3. Repeat for eu-central, ap-southeast and ca-east, one at a time.
4. `node work/directory-https-activation/service-index/prepare.mjs gates` must exit 0. Then sign exactly `prepared.json` `data`/`to`/`from`/value 0 with root's journaled signer flow, and reread the slot from agreeing RPCs.
5. Rollback: `activate.py rollback --hosts <h> --approve <manifest>`. It restores only if the file is still exactly the result.

## 8. Remaining conditions (unresolved; stated precisely)

- **Not live.** No host has the route, and the ad is unchanged (A1–A3 pending, root's action). Live public readback has only been run in the pre-activation (`inactive`) mode.
- **Concurrency.**
  - The host program creates `/opt/enclave-site/.site-release.lock` if absent (absent on all four hosts today; this scoped creation is authorized), holds it with flock(2) for the whole run, and never unlinks it. A site release that starts mid-activation is therefore blocked.
  - The lock is created root-owned with mode 0644. A site-release agent that does not run as root would need the file chowned before it could take the lock.
  - Root's ad hoc Caddyfile editors take no lock and are not coordinated by any lock. Compare-and-swap means their bytes are never overwritten knowingly, but a microsecond window remains between the final hash check and `rename(2)`.
  - Do not run other Caddyfile editors during an activation.
- **What the fixtures stand in for.** The control API is a fixture (it mimics minipc's CORS and its 404 for records). TLS is `tls internal`, not ACME (the live IP certificates and the `shortlived` renewal are untouched by the patch). Site files are small fixtures. Reloads use `caddy reload` over the admin socket rather than `systemctl reload` (which runs the same `ExecReload` command).
- **Shared budget.** Public HTTPS traffic shares the directory's global public budget (100 tokens, 32 in flight) with the existing public `:8188` HTTP. The loopback-reserved DNS budget is protected.
- **Odd spellings.** Dot-segment paths are cleaned by Caddy to the same grammar resource. `…/policy/<id>%2f..` gets a Caddy 404.
- **Independence.** These are four Enclave-operated hosts behind one operator key. Nothing here shows organizational independence or cold new-operator participation.

## 9. Inventory

The full sha256 list is `work/directory-https-activation/inventory.sha256` (42 files). Key files:

| File | sha256 |
| --- | --- |
| `transform.py` | 747dbe96… |
| `activation/remote.py` | 13c0f27c… |
| `activation/activate.py` | 79a9710a… |
| `activation/public-readback.mjs` | a1652e7c… |
| `service-index/prepare.mjs` | 2013839c… |
| `test/directory-https.test.mjs` | 11ebefcc… |
| `test/activation.test.mjs` | d8e9bb02… |
| `test/remote_write_test.py` | 6fd938b0… |
| `test/controller_test.py` | 88f2f276… |
| `test/fixture-config.mjs` | 3c72adb8… |
| `test/guarded.sh` | 7c0eb833… |
| `test/run-fixture.sh` | 03f6763d… |

Earlier versions are kept under `superseded/` (including `pre-review2/` for the sources before the second review), and all logs under `logs/`. No owned process or temp directory remains.

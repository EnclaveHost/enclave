# Independent CLI: GPU, Shield configText (F1) and full validation (2026-10-19)

Repo: `work/enclave`. The tree was tested as it stands. HEAD is now `7b89d6b2`; it was `3542e180` at the start, and the
two commits since then do not change `network/`, `cli/`, `test/helpers/`, `windows/node/shield-startup.mjs` or
`windows/vbslike/`.

**What I did not do:** no commits, production use, SSH, chain writes (anvil only), Wine or GUI.

**What I did not edit:** Windows/Go, management, SDK, custody, network-management or browser files.

**`cli/dist/enclave.mjs` is unchanged** (`9db0f36a8c9de0cc128a36eac728c30484be21f2193328b3e18669e50dc34b10`).

## Changes this round

### 1. `gpu <deployment-id>` in independent mode (`cli/enclave.mjs`)

- **Path:** it goes through `ManagementClient.gpu()`, the coordinator's `gpu` operation from `3542e180`, with scope
  `api.status`. The same `independentManagementCall` path is used as for status, logs and the other management commands:
  1. the pinned factory is checked;
  2. on chain: the session is live, holds the `api.status` scope, and the deployment is held by its vault or the vault's
     owner;
  3. the host is taken from the current lease and its operator-signed record;
  4. the TLS SPKI is pinned before any byte is written.
- **The deployment id is required:** `enclave gpu` alone gives a usage error that says there is no host lookup by name.
- **Output** is labelled "host-reported capacity: not an attestation and not a reservation". `--json` adds
  `hostReported: true` and the runner.
- **CPU-only hosts:** the supervisor's `404 no_gpu` is printed as "current host reports no GPU (CPU-only)", exit 0.
- **Command lists:** `gpu` was removed from `INDEPENDENT_REFUSALS` and added to `INDEPENDENT_COMMANDS`. `gpu` was added
  to `MANAGEMENT_SCOPE`.
- **Hosted `cmdGpu`** behaves exactly as before; it only dispatches to the new path when `--independent` is set.

### 2. F1: the Shield package commits exactly the measured config

**Prepare (`bootstrap prepare --target shield`).** `shieldAppId` now returns the bytes the partition measures:
`typeof plan.spawn.derive.config === "string" ? plan.spawn.derive.config : ""`, the same expression as
`windows/node/shield-startup.mjs`.

`prepare` commits those bytes, never the file's spelling:
- canonical JSON with `_media` removed;
- `""` when there is no effective config (`{}`, `{"_media":…}`, ` { } `);
- `"{}"` for a secrets-only custody package.

It prints when it rewrote the file's text. The AppID is derived from the same plan.

**configSha256.** Every prepare now outputs `configSha256 = sha256(utf8(configText))`, matching
`custody/protocol.mjs configSha256`. A custody prepare also prints "seal the custody-v2 bundle with configSha256 …".

**Custody on Shield**, now the host's own rule instead of a blanket refusal:
- **Prepare** with `--custody-file` is allowed only when `--shield-manager` states `supports.directBootstrap`,
  `custodyV2` and `secrets`, and the plan derives `enclave-catalog-bundle/6` or `/7` without inference. Otherwise it
  refuses before writing a file.
- **Activate** of a custody Shield package needs the same manager statement. It is checked locally, right after the
  package is verified and before any storage read or send.

**Invariants and unchanged behaviour:**
- The public package and the custody pointer format (`sdk/bootstrap/package.mjs`) are unchanged.
- SNP prepare still preserves exact config bytes; the hosted test for this passes.
- Names stay SNP-only.
- The tier rule for prepare, publish and activate is unchanged.

### 3. Tests and fixture

**`test/helpers/cli-independent-rig.mjs`:** the supervisor stand-in answers `gpu`. It returns 200 with capacity, or
404 `no_gpu` when `mode.gpu = "none"`.

**`test/cli-independent.test.mjs`, test 13** now also checks:
- `gpu --json`: `hostReported`, capacity, and the runner from the lease;
- the human output, including the "not an attestation and not a reservation" label;
- CPU-only `no_gpu`;
- the usage error with no id;
- `gpu` on a deployment the vault does not hold, refused before the host is contacted;
- route-log count ≥10, every route dialling the signed public address.

**`test/cli-independent-sessions.test.mjs`:**
- **Shield test**, with the manager now `directBootstrap: true`:
  - a whitespace/`_media` config file is committed as `{"greeting":"hi"}`, and `configSha256` matches;
  - `{}`, `_media`-only and ` { } ` are committed as `""` (derivation `/2`, because the app has an HTTP port);
  - custody with a non-custody manager is refused and no file is written;
  - custody with a direct-custody manager (`/6`) commits `"{}"`, prints the right `configSha256`, and gives a different
    AppID;
  - custody activate is refused with no manager, and with a manager that has no custody support, with zero sends;
  - `publish` without `--target shield` is refused by the round-6 tier rule;
  - **`materialize()` from `windows/node/shield-startup.mjs`, with `supports.directBootstrap: true`, accepts the package
    with `startup.direct === true` and the package carried in `spawn.bootstrap`.** This is the F1 path that would have
    failed with the file's spelling.
- **encvol/host test:** the `gpu` refusal was replaced by the explicit-id usage check.

**Failures found and corrected during the runs** (all were test expectations; no CLI logic was wrong):
1. **Derivation expectation.** I expected `/1` for an empty config, but the app has an HTTP port, so it is `/2`. The CLI
   output (`""`) was correct.
2. **Custody activate check order.** It ran after the storage availability read, so an unpublished package reported a
   storage error first. I moved the check before any read; refusing locally is the safer order.
3. **Old Shield `publish` line.** It lacked `--target shield`, so the round-6 tier rule refused it correctly. That rule
   had never run on anvil before. The test now asserts the refusal and publishes with `--target shield`.

Test 12 of the sessions suite failed in runs 1–3 only because test 10 aborted before it set `shieldRecord`.

## Exact run results

**Guard:** `/tmp/s6/run-768.sh`. It runs the command in its own `setsid` process group and SIGKILLs only that group if:
- its own RSS exceeds 768 MiB;
- MemAvailable drops below 16384 MiB;
- it passes the 900 s deadline.

Runs were serial, one at a time. "Peak RSS" is the guard's sampled maximum for the whole group (node, anvil, CLI
children). No run was killed by the guard.

| # | Run | Result | Peak own RSS | Min MemAvailable | Time |
| --- | --- | --- | --- | --- | --- |
| 1 | sessions suite, source (first attempt) | 11/13 (fails 1 and 2 above) | 519 MiB | 17922 MiB | 46 s |
| 2 | sessions suite, source | 11/13 (fail 2 above) | 523 MiB | 17590 MiB | 47 s |
| 3 | sessions suite, source | 11/13 (fail 3 above) | 527 MiB | 17135 MiB | 48 s |
| 4 | sessions, `--test-name-pattern` session new\|Shield (diagnosis) | 1/2 (fail 3 diagnosed) | 374 MiB | 17581 MiB | 9 s |
| 5 | **`test/cli-independent-sessions.test.mjs`, source** | **13/13, 0 fail/skip/cancelled** | 389 MiB | 17220 MiB | 49 s |
| 6 | **`test/cli-independent.test.mjs`, source** | **14/14, 0 fail/skip/cancelled** | 400 MiB | 17690 MiB | 39 s |
| 7 | staging bundle build (`node cli/build.mjs ../cli-staging/enclave.mjs`) | built, 1954 KB | 39 MiB | 18157 MiB | 1 s |
| 8 | **sessions suite, staged bundle** (`ENCLAVE_CLI_ENTRY`) | **13/13** | 375 MiB | 17422 MiB | 39 s |
| 9 | **cli-independent suite, staged bundle** | **14/14** | 396 MiB | 17599 MiB | 29 s |
| 10 | **hosted `test/cli.test.mjs`** | **76/76, 0 skip/todo** | 271 MiB | 17021 MiB | 56 s |
| 11 | **hosted `test/cli-session.test.mjs`** | **3/3** | 737 MiB | 16445 MiB | 92 s |
| 12 | **hosted `test/cli-deploy-visibility.test.mjs`** | **7/7** | 262 MiB | 17489 MiB | 5 s |
| 13 | **hosted `test/cli-deploy-isolation.test.mjs`** | **12/12** | 245 MiB | 16497 MiB | 6 s |
| 14 | **hosted `test/cli-attest-verifier.test.mjs`** | **3/3** | 214 MiB | 16574 MiB | 5 s |

**Highest peak this round:** 737 MiB, in hosted `cli-session` (run 11), under the 768 MiB allocation. The four hosted
files were run one at a time instead of together; together they reached 760 MiB last time.

**Memory floor:** the lowest MemAvailable seen was 16445 MiB, during run 11. The floor was never crossed, so I never
had to stop my group. Each hosted run checked for ≥17000 MiB before it started.

**Staging bundle:** `work/cli-staging/enclave.mjs`, 2000647 bytes, sha256
`ad81e36b5016d2879dcc24dbd03937d67af457b3af0ef45cecd2753efeb05330`. It replaces `cc91b3ad…`; runs 8 and 9 tested it.

**Cleanup:** after the runs, no process from these runs remained: no chain-8453 anvil, test runner or CLI child.

**Anvil processes left alone:** 26 anvil processes on chain 31337, started 2026-10-13 under a different session
(SID 734238 and others), were already running. They are not mine and I did not touch them. They may be another
worker's orphans; their owner should decide what to do with them.

## Remaining gaps (not claimed)

1. **Hosted accounts and passkeys** (`account`, `login`, `logout`, credit-vault and order-provisioned deployments)
   remain architecture backlog. The wallet path (`ls`, `whoami`, `fund`, sessions) is the independent route, but it is
   **not** a complete equivalent of hosted account and passkey capability, and nothing here claims it is.
2. **`move`** needs management operations `release` and `claimHint` (`work/cli-remaining-interface.txt` §4).
3. **`availability`**, and GPU state of a host you hold no deployment on, needs signed capacity records or a
   capacity operation (§6). `gpu` covers only a named deployment's current host.
4. **`secrets` and `custody`.** `secrets` stays refused. The `custody` command (`cli/custody.mjs`) still uses
   first-answer clients and relay hooks. Shield custody-v2 is now prepared and activated only where the manager
   states direct custody, but this round did not test the owner's custody bundle sealing or a custodian release, end to
   end.
5. **Shield manager input.** `--shield-manager` is operator-published `/health` text. A wrong file gives a package the
   host refuses (the host re-derives everything); it never gives one that runs under another AppID or another config.
6. **`session resume-wait` and `session top-up-link`** are hosted by nature. The equivalents are `session open` and
   `session top-up`.
7. **The positive native-attestation path** is not exercised here; it delegates unchanged to `NativeClient`.
8. **Delegation for wallet-held deployments** is not checked client-side, because the deployed ledger's mapping is
   private. The host gateway decides.
9. **Promotion.** `cli/dist` is unchanged pending review; promoting it is `node cli/build.mjs`, after review of the
   staging bundle.

## Files changed this round

- `cli/enclave.mjs`: `cmdGpuIndependent`, the gpu scope and dispatch, the refusal and command-set change, the
  `shieldAppId` measured config and custody rule, the prepare canonical commit and `configSha256`, and the early
  custody-activate check. The naming worker's `--names`/ACME flags are untouched.
- `test/cli-independent.test.mjs`, `test/cli-independent-sessions.test.mjs`, `test/helpers/cli-independent-rig.mjs`.
- `docs/network/independent-cli.md`: the gpu row, the measured configText, Shield custody and the sessions `config` note.
- `work/cli-remaining-interface.txt`: §5 gpu is now SUPPORTED-NOW.
- `work/cli-staging/enclave.mjs`: rebuilt.

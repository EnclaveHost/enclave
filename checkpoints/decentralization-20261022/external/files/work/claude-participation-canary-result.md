# Provider canary: an operator-chosen zone, wired into the real startup and shutdown paths (2026-10-19, round 3)

**Round 3** adds the agent's shutdown and failed-start hooks in `network/privacy-agent.mjs`, and a test against the real
daemon process. See "Agent lifecycle" below. This report supersedes the earlier versions. The startup wiring that version proposed as a patch is now implemented in
`network/enclave-network-host.mjs`, under the narrow ownership granted: import, configuration, construction and
lifecycle.

**Files changed this round:**

- `network/enclave-network-host.mjs`: the wiring. The pending `ownerNames` changes are preserved.
- `network/provider-canary.mjs`: startup failures now release every resource; `close()` is idempotent; a `probeZone`
  key is counted only when it holds a value.
- `test/provider-canary-independent.test.mjs`: the host child now runs the real `createNetworkHost` from a daemon config
  file.
- New `test/enclave-network-host-canary.test.mjs`: lifecycle and leak tests.
- Docs: `docs/network/open-participation.md` §1b and `docs/network/bandwidth-revenue.md`.

**Carried over from round 1, unchanged:** `scripts/network/qualify-provider.mjs` and `network/provider-probes.mjs`.

**Round 3 files:**

- `network/privacy-agent.mjs`: network-host cleanup hooks only. The other worker's pending `attestedKey` change is
  preserved.
- New `test/privacy-agent-lifecycle.test.mjs`.
- `docs/network/open-participation.md`.

**Not edited:** `network/direct-runtime.mjs`, `supervisor.js`, and the management and Shield modules. Their working-tree
modifications are other workers'.

**Not done:** no production access, SSH, Wine, GUI, chain writes, commits or heavy builds. Mutation runs used a scratch
copy, since removed.

## The wiring (`createNetworkHost`)

1. **Judged first.** Inside the `direct` block, `directProbeConfig(c.direct.probe)` checks the probe before anything
   else is read or bound:
   - only the known fields are allowed: `hostname`, `keyFile`, `certFile`, `tokenFile`, `udpPort`, `manifestFile`,
     `bindHost`, `independent` and `probeZone`;
   - the four file paths must be absolute;
   - `udpPort` must be an integer from 1024 to 65535;
   - `bindHost` must be an IP address;
   - `independent` must be a boolean;
   - `canaryHostname` must accept the name: the legacy `probe-*.enclave.host`, or `probe-<label>.<probeZone>` in an
     explicit, non-Enclave reviewed zone.

   A malformed probe stops the start; it is never ignored.
2. **Started last.** The canary and the `DirectRuntime` are now created after every other configuration check, including
   `hostEgressOffer`, at the end of the function. So nothing is bound while the configuration can still be refused.
3. **Listening at startup, with a canary.** `DirectRuntime.listen()` is called immediately, because a checker must reach
   the canary on 80/443 before any app can be qualified. Without the canary, apps never qualify, and before this change
   the runtime listened only at the first direct app.
4. **Without a probe, nothing changes.** The runtime is constructed exactly as before (no `canary` key) and listens
   lazily at the first direct app.
5. **Cleanup on failure.** If canary creation, runtime construction or `listen()` fails, whatever was bound is closed
   (the runtime, which closes its canary, or the canary alone) before the error is rethrown.
   - Inside `createProviderCanary`, a failed UDP bind, egress-proxy start or manifest write now also closes what was
     already open. Before, its TLS endpoint leaked.
6. **Lifecycle.** The returned host gains `close()`, which releases the direct runtime and its canary. It is idempotent,
   and so is `canary.close()`; a second close no longer throws "Not running".
   - **Ownership caveat.** `DirectRuntime.close()` itself (another owner's file) is not idempotent, so callers should use
     the host's `close()`.
7. **Pass-through.** The owner-name source (`c.direct.ownerNames`) passes through unchanged to the runtime. A test shows
   it coexists with a canary.

## Agent lifecycle (`network/privacy-agent.mjs`, round 3)

**Before:** the agent never closed the network host. With a canary, the host holds listeners from startup, so the real
daemon did not exit after SIGTERM, nor after a failed start. This was measured, below.

**Now** the edits are narrow, and every path calls the host's idempotent `close()` through
`closeNetwork()`, which logs a close error instead of throwing:

| Case | What happens now |
| --- | --- |
| SIGTERM or SIGINT | The handler sets `stopping`, closes the agent, control transport and paid network as before, then closes the network host **last, and always**, even if an earlier close rejected (`.finally`). |
| A stop during `createNetworkHost` | Once the host exists and `stopping` is set, the host is closed and startup aborts with "privacy agent stopped during startup". |
| A setup step after the host's creation fails | The control transport start, paid-network creation or `PrivacyAgent` construction runs inside a `try`. On failure the host is closed and the error rethrown. |
| `agent.start()` fails, or a stop arrives before it | The existing cleanup (host proof, agent, control transport) now runs in a `try`, and the network host is closed in its `finally`. Then the error is rethrown. |

**Unchanged:** the agent's and other components' own close behaviour. `DirectRuntime.close()`, which belongs to another
worker, is reached only through the host's idempotent `close()`.

**Does the real daemon exit and release the probe listeners? Yes.** `test/privacy-agent-lifecycle.test.mjs` runs
`node network/privacy-agent.mjs --config FILE` as a child process. The daemon config has no Enclave authority:

- pinned contracts and two unreachable operator RPCs;
- non-Enclave directories and checkers, with no relay;
- the canary in `probe.alice-net.org`.

Every `*.enclave.host` lookup or connection is refused and logged. Results:

1. **Started, then SIGTERM.**
   - The canary starts, and the agent reaches its status write. The chain refresh failed against the unreachable RPCs, so
     startup needs no chain.
   - The canary's UDP port and the direct HTTPS and HTTP ports are bound.
   - After SIGTERM the process **exits by itself** (code 0, not killed by a signal) within the 20 s limit, and all three
     ports are free.
2. **Failed start.** The agent's status path is occupied, so `agent.start()` fails with `EISDIR` after the canary had
   started. The process exits with code 1 and all three ports are free.
3. **Malformed probe** (an Enclave zone): exits with code 1 and the `direct.probe` reason. No canary or manifest is
   created, and nothing is bound.

In all three, the `enclave.host` log stays empty.

**Baseline.** One run of the same test against the pre-change `privacy-agent.mjs`, in a scratch copy, since removed:

- case 1 failed: "the daemon did not exit after SIGTERM";
- case 2 failed: "the daemon did not exit after its start failed";
- case 3 passed, as expected (it doesn't depend on the hooks).

The test's `finally` killed those daemons, so nothing hung. Every child in the test is SIGKILLed in `finally` if it is
still running, with hard deadlines, so a regression fails instead of hanging.

**Not covered:** a SIGTERM landing exactly while `createNetworkHost` is still awaiting. That path exists in the code, but
I didn't time a test into that window.

## Tests

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 test/privacy-agent-lifecycle.test.mjs` (round 3, real daemon) | **3 of 3 pass, two consecutive runs** |
| Round 3 focused set, `--test-concurrency=1`: `privacy-agent-config`, `privacy-agent-proofs`, `network-consumer-bundle` (esbuild bundles, including `privacy-agent.mjs`), `privacy-agent-lifecycle`, `enclave-network-host-canary`, `provider-canary-independent`, `provider-canary`, `independent-name-routing`, `network-authority-pins`, `provider-bootstrap`, `host-egress` | **42 of 42 pass** |
| `node --test test/enclave-network-host-canary.test.mjs` | **5 of 5 pass, three consecutive runs** |
| `node --test test/provider-canary-independent.test.mjs` | **5 of 5 pass** |
| Focused regression run: `independent-name-routing`, `network-authority-pins`, `provider-bootstrap`, `local-byo-config`, `network-policy-outage`, `host-egress`, `provider-canary`, plus both files above | **37 of 37 pass** |

**One transient failure.** In the first combined run, one `network-authority-pins` case failed once, while the files
were running in parallel. It passed in three isolated runs (4 of 4 each), and the whole set passed 37 of 37 on rerun. I
saw no link to this change, but I also did not diagnose it.

### `test/enclave-network-host-canary.test.mjs` (in process, real `createNetworkHost`)

Open TCP and UDP handles are counted (`process.getActiveResourcesInfo`) before and after each case.

- **With a probe:**
  - the host listens on the configured ports from startup;
  - the canary answers its challenge on the runtime's public HTTP port, for its own Host header only (another name gets
    421);
  - the manifest is written;
  - `close()` twice leaves the same handle count, and every port is free again.
- **Without a probe:** the legacy construction is unchanged (no `canary` key); nothing listens; `close()` is harmless; a
  host without direct hosting has `direct: null`.
- **14 malformed probes are refused** with specific messages, and never `ENOENT`, so no file is read and nothing is
  bound: null, an array, an unknown field, relative paths, a missing manifest path, ports 80 and `"9000"`, a `localhost`
  bind, a non-boolean `independent`, a missing zone, an Enclave zone, a name outside the zone, a zone without
  `independent`, and the operator's zone with `independent: false`.
- **Failed starts leave nothing bound:** a missing certificate; a busy UDP port (the canary's own cleanup); a busy public
  HTTPS port (the canary is closed with the runtime); and a malformed `hostEgress` checked after the direct block (the
  canary is never started, and no manifest is written).
- **Coexistence:** `ownerNames` and the canary together, and the legacy `probe-*.enclave.host` canary still starts.

### `test/provider-canary-independent.test.mjs` (child processes, `*.enclave.host` refused and logged)

**Host child: the shipping entry point.**

- It reads a **daemon config file** in `privacy-config.json`'s shape and calls `createNetworkHost` exactly as
  `privacy-agent.mjs` does.
- The config has no Enclave authority:
  - pinned contracts (`chain.authorityPins`) and the operator's RPCs;
  - non-Enclave directories and checkers, with no relay;
  - `enclaveNetwork.direct.probe` with `independent: true` and `probeZone: probe.alice-net.org`;
  - public ports named in `direct.httpsPort` and `direct.httpPort`.
- **Faked:** only the chain quorum reader (`agreed()` throws, proving startup needs no chain read), the forwarder and
  the authorizer.
- **Teardown:** the child is killed in a `catch` if setup fails, and always in `after`.

**What the run proves:**

- **End to end.** The real `qualify-provider.mjs --config` (independent) passes all nine checks against that host, over
  public test addresses mapped to loopback: TCP 80/443, UDP, the 40 MiB echo, the HTTPS canary through the host's egress
  proxy, and the four refusals.
- **Shipping path.** The host reports that it is listening, on the ports from the daemon config, with the canary name in
  the operator's zone. The envelope verifies.
- **No Enclave traffic.** Neither child touched `enclave.host`. A positive control shows the blocker refuses and logs an
  Enclave request.
- **Refusals from real entry points.** The checker refuses missing, malformed and Enclave zones, and manifests outside its
  zone. The host refuses each malformed probe, now through `createNetworkHost` (which exits 3 with the reason), and never
  `ENOENT`.
- **Protections in the operator's zone.** Token, path, port and SNI protections hold on the live host.

### Mutation checks (scratch copy; each mutation alone; both files rerun)

| Mutation | Result |
| --- | --- |
| W1: `direct.probe` ignored (the old behaviour) | 7 tests fail, across both files |
| W2: no early validation | Malformed-probe tests fail in both files |
| W3: no listen at startup | Startup, end-to-end and protection tests fail |
| W4: no cleanup on a failed start | The failed-start leak test fails |
| W5: canary started before the later checks | The leak, refusal and end-to-end tests fail |
| W6: `close()` releases nothing | The close and leak tests fail |
| W7: the canary leaks its TLS endpoint when UDP fails | The failed-start leak test fails |

## Limits

- **Agent lifecycle** is now integrated (above). The one untested window is a SIGTERM that lands while
  `createNetworkHost` is still awaiting.
- **Network stand-ins.** Public addresses were simulated by a loopback-mapping preload. Not exercised: a real public
  interface, a shared 80/443 frontend (whether `sync-fallback`'s name check accepts non-Enclave canary names is
  unverified; the script is not in this tree), SSH (`qualification-round.mjs`), and `--publish` (chain write).
- **Listening at startup has a consequence.** With a canary configured, the configured direct ports must be free when the
  agent starts, or the start fails, cleanly and with nothing left bound. Before, a busy port only surfaced at the first
  direct app.
- **The zone is not verified.** It is "reviewed" by both the host operator and the checker configuring it. Nothing
  verifies who controls its DNS, and probes reach the host by address, not DNS.
- **No independent checkers or providers exist yet.**

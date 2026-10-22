# Adapter wallet admission outage: cause and candidate fix (RESULT, 2026-10-22)

**Status: source only. Candidate committed locally and tested offline. NOT deployed.**
- There was no SSH, live RPC, wallet use, funding, process restart or production change.
- The wallet ownership gate is not disabled or bypassed, and no expired permit is extended.

## Installed source (live hashes from `public-health/admission-source-hashes.json`)

| installed file | sha256 | local copy (same bytes) |
|---|---|---|
| `network/wallet-admission.mjs` | `0fa7678f7586388b4725f1432683fa4ab172fd1d57c163d9a63195fbb2f445ee` | `work/root-control-rpc-final-20261022/control-package/files/network/` |
| `windows/node/host.mjs` | `9634cb40c60b74f92eff8497f687dcaa1ec04a33c21cbd22dc745d773b1da396` | same package `files/windows/node/`; also `lease-readiness-20261022/tree` |
| `windows/node/agent.mjs` | `76cac3559713313251a0c0ab618fc31980c750496b6d55d94969d30b32c083a1` | same |
| `windows/node/host-admission.bundle.mjs` | `6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18` | same |
| `network/privacy-agent.mjs` (package `deploy` entry) | `cfb69370…` | same package `files/network/` |

The privacy agent's live hash was not read. `cfb69370` is the package's deploy target, and its `walletUntil` and
`walletAdmission` status fields match `admission-state.json`.

`work/enclave/network/privacy-agent.mjs` is not the installed agent (root's suspicion was right). The installed reader is
the one bundled from `network/wallet-admission.mjs` 0fa7678f into `cfb69370`.

## Cause (evidenced in source and consistent with every live observation)

1. **The deadline (writer).** `WalletAllowWriter.allow()` accepts an allow only with a deadline no more than
   `POLICY_MS` = 90 s away (`wallet-admission.mjs`).
   - `commit()` and `heartbeat()` prune expired allows.
   - The 10 s heartbeat renews only the 30 s channel lifetime. It never lengthens an allow, by design.
2. **Where the deadline comes from.** The host takes it from `hostAdmission.decision()`:
   `validUntil = min(authority snapshot + 90 s, catalog snapshot + 90 s, now + 90 s)`.
   - Source: `network/host-admission-runtime.mjs`; the installed bundle has the identical expression
     (`x.timestamp+9e4`, `u()+9e4`).
   - Snapshot block timestamps lag the head, so a fresh allow buys roughly 73-85 s.
3. **Who publishes it, and how often.** The ONLY publishers are `#walletGrant` calls inside `Host.ensureApp` and the serial
   per-deployment loop of `Host.#tickOnce`.
   - `tick()` is single-flight: an interval that finds a pass running joins it.
   - A pass walks every tracked deployment, doing chain reads, wallet decisions, adoption and renewal.
   - Under this host's public-RPC 429 pressure (see `claude-resumed-20261022/rpc-budget-review/REVIEW.txt`), a pass
     takes about 7 minutes. The adapter's "isolation adopted" lines are ~6m47s to 7m56s apart.
4. **Result.** Each pass grants about 73-85 s, then `allows=[]` and `walletUntil=0` until the next pass.
   - Live: egress back 21:17:44, OFF 21:18:41; back 21:25:02, OFF 21:26:15.
   - The agent reports this as "authorization lapsed (lease or guest proof)", which is misleading: the gate is
     lease && proof && **walletUntil**.

**What it is not:**
- **Not a monitor or agent restart.** Writer generation `5058e0c4` is unchanged at revision 16933. The channel is `fresh`
  and `applied`.
- **Not the budget gate.** The lease is funded, active and live; the host row says `running` with `walletHeld: null`.
- **Not a refusal.** No hold or give-up was recorded.

It is the admission **verdict going stale between passes**: the decision's 90 s bound is correct, but nothing re-decides
before the next pass.

## Candidate fix (`windows/node/host.mjs` only)

`Host.walletRefresh()` is driven by a 10 s timer started beside the existing channel heartbeat in `walletChannelStart`. For
each allow THIS process published (`#walletGrants`), once fewer than 40 s remain, it refreshes independently of the pass:

- **Per deployment.** At most one refresh in flight per deployment. Each is bounded (25 s; tests override this via
  `cfg.walletRefreshDeadlineMs`). At most 4 run at once, earliest deadline first. A slow app never starves another.
- **Fresh authoritative row.** It reads `chain.readDeployment(id)`, the same read the pass uses, and refreshes only while
  the row is:
  - active, with runner = this enclave and a live lease;
  - the SAME owner, visibility (`isPublic`), appRef (version) and configCid that the pass granted;
  - free of any placement refusal;
  - still `running` here and not wallet-held.

  Any change is the pass's to decide; the allow simply lapses. Otherwise it asks `hostAdmission.decision()` anew for
  exactly that row (`forPrivate` from the row) and publishes only that decision's deadline.
- **Reads only.** No transaction, renewal, release or retirement happens in this path.
  - A refusal withdraws the allow at once (`#walletRevoke`); the next pass gives the deployment up as before.
  - An unknown or a timeout publishes nothing, so the allow lapses at its own deadline. It is never lengthened.
- **Fenced.** `#walletRevoke` and `#walletHoldConfirmed` delete the grant before writing the channel. A refresh result is
  dropped if the grant object, the channel or the tracking changed meanwhile. A new process starts with an empty map
  under a new generation.
- **Scope, not authority.** Only deployments the network agent routes (`status.json` `apps`) are re-decided. If that
  status is unreadable, every published allow is refreshed. The status never grants anything.
- **Unchanged:** tick single-flight; admin ban, refusal, stop, transfer, hold and give-up semantics; the writer; the agent;
  the 90 s bound.

**Added RPC cost** (reads, per routed served deployment, every ~40-50 s): one single-RPC `readDeployment`, plus one
catalog-moderation agreed read and an authority read (that one cached 15 s). On this host only the adapter is routed, so
about 1.3 decisions per minute.

## Evidence (queue 256 MiB; offline `unshare -r -n`; ssh/scp/sftp denial stubs proved; raw logs in `logs/`)

**Candidate** (isolated, dereferenced copy of the installed-base tree):
- `adapter-admission-review/candidate`, git (local only);
- baseline `32fecf5` (host.mjs = installed `9634cb40`);
- fix `ad4a72a83de85db72a5c5ddce45a5c8d8599140e`, tree `30e22230…`, author and committer SteveDeFacto.

| run | result |
|---|---|
| g1 | 0/9: my edit had dropped `walletHeartbeat()` (restored from baseline). Retained. |
| g2 | 6/9: test timing (a refresh had already happened at +40 s). Retained. |
| g3 | 9/9 |
| **g4** | **11/11 (peak 183 MiB)** on the committed blobs (host `637fbdf6`, test `903de416`) |
| **mut / mut2** | **frozen INSTALLED host.mjs 9634cb40 FAILS** the suite (7-minute gap = the outage; slow app; fresh-row binding; refusal; in-flight withdraw and hold; generation; private). Only the mechanism, unknown and no-resurrection cases pass on it, as expected. **9/9 mutants killed**: no fence; no fresh-row check; forPrivate not from the row; refusal not withdrawn; revoke keeps the grant; hold keeps the grant; one deployment per round; unknown extends; no per-app in-flight guard |
| reg | existing suites lease-readiness, tick-single-flight, wallet-policy, wallet-network-hold, appzone-wallet-hold: 34/35 |
| reg2, reg3 | the one remaining case (Host readiness through the pwsh cutover gate) needed PWSH and the sibling `cutover/` tools. With them it was guard-stopped at 267 MiB > 256 (exit 99, a NON-RESULT, retained). Its other 8 cases pass; the fix does not touch `leaseReadiness`. It needs a 512 run if root wants it. |

**Test cases** (`test/windows-node-wallet-grant-refresh.test.mjs`). The harness is the real Host on a fake Base RPC, plus
the real PrivacyAgent and WalletAllowFile on the host's channel:
- **Mechanism:** with no refresh, the allow lapses at its decision deadline, leaving the channel fresh with
  `allows=[]`.
- **7-minute pass gap:** admitted throughout; 9-12 decisions in 420 s; every refresh is one decision on the fresh row.
- **Slow app:** app A's decision hangs while app B is refreshed. A is not re-asked while in flight, ends unknown at its
  deadline, and is retried next round.
- **Fresh-row binding:** for a change to private, owner, version, config or runner, for inactive, and for a lapsed lease,
  no decision is asked, nothing is extended, and the allow lapses.
- **Refusal:** withdrawn at once, never re-asked.
- **Unknown:** no publish, no extension; restored by a later fresh decision.
- **No resurrection:** after a pass stop, or after a pass hold on unknown.
- **In-flight fences:** a refresh in flight during a pass withdraw, or during a pass hold, is dropped.
- **Process generation:** a new process starts empty and refreshes nothing; the old generation is refused by the agent.
- **Private deployment:** re-decided with `forPrivate: true` from the row.

## Patch and hashes

| item | value |
|---|---|
| `adapter-wallet-grant-refresh.patch` (`git diff 32fecf5 ad4a72a`) | sha256 `422f144d7f3fe0e27894883d7a5a2651be066f1cea6f46fa80bfcdaa3f81812d` (2 files, +381/−4) |
| `windows/node/host.mjs` | installed `9634cb40…` becomes candidate `637fbdf6af2eedc868444c471d1d9cb7d767d8fb70ab52a2cc05b20e3c49dca3` |
| `test/windows-node-wallet-grant-refresh.test.mjs` | `903de4163ea715ed3ecf3b7179fcd52235e50b24f35f5f88598da262bec2851b` |
| unchanged | wallet-admission `0fa7678f`, agent `76cac355`, host-admission bundle `6bef372d`, privacy agent `cfb69370` |

`host.mjs` is not an input of any generated bundle (no manifest lists it), so no bundle changes.

## Activation (root only; not done)

- Swap `C:\Program Files\Enclave\control\windows\node\host.mjs` from `9634cb40` to `637fbdf6`.
- This is a node control-file change. Use root's established node control procedure: stop node, swap, start node. Mind
  the lease window and G-UPD gates from the node-hold work.
- The refresher starts only with `ENCLAVE_NETWORK_WALLET_HOLD=1` and the channel on (the `heartbeat: true` start path),
  exactly where the heartbeat already runs.
- **Rollback:** restore `9634cb40` and restart node. Any extra allow simply expires within 90 s.

## Not done / open

- Not run on Windows, so no native timing measurement. The agent is the source module, not the bundled `cfb69370` (same
  wallet-admission reader).
- The pass itself stays slow. Its RPC cost (`rpc-budget-review` F1/F2) is a separate, root-owned decision.
- **Diagnostic wording (not changed).** The privacy agent says "lease or guest proof" when the wallet allow lapses.
  Naming `walletUntil` there would require a privacy-agent rebuild.

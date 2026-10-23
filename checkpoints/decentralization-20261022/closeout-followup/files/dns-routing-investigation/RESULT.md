# EnclaveDNS (0x59f1273d) public routing failures at 01:07 and 01:18Z: evidence and diagnosis (RESULT)

**Method.** Read-only: scoped SSH reads of service identity, file hashes and journals on the 4 fronts; minipc
`network.log` via `powershell -EncodedCommand`, emitting each line with `[string]::Concat`; public dig/curl; and the live
bundles' source. Nothing was configured, restarted or deployed. No credential or environment was read. **No patch: I
found no concrete routing source bug** (§4).

## 0. Answer

1. **Both failures are fail-closed authorization withdrawals at the host, followed by DNS that lags the withdrawal.** A
   valid client can be sent to a path the host has already closed. This is not a TLS or certificate failure: the
   certificate stayed valid throughout.
2. **01:07:** one of the old node's (9634cb40) recurring per-app authorization lapses. 59f1 was OFF from 01:07:35 to
   01:08:00. Eight running apps flapped the same way from 23:50 to 01:08 (6–18 OFF events per 5 min).
   - This matches the known slow-pass wallet-grant lapse (an allow is re-published only by the ~7-min serial pass),
     plus chain-quorum trouble.
   - The e7 node deployed at 01:17 carries ad4a72a's per-app wallet refresher. **0 OFF events from 01:19 to 01:26:53**:
     encouraging, but only 8 minutes. Quiet stretches existed before (00:15–00:35), so this does not yet prove the fix.
3. **01:17–01:18: caused by the node restart, by mechanism and not only by timing.**
   - `network.log` shows "wallet admission withheld: invalid or expired wallet admission document" at 01:17:30, and
     all 9 running apps "egress OFF" at 01:17:31. Every front's route map dropped 11 → 2 at 01:17:34–35.
   - Apps came back 01:17:59–01:18:39 (59f1 at 01:18:19), and the maps were back to 11 by 01:18:25–49.
   - **This is the designed behaviour.** `WalletAllowWriter` is "atomic, empty-on-start", and the channel document
     expires 30 s after the last heartbeat. Carrying allows across a restart would be the stale-authorization grace
     root ruled out.
   - **Bound observed:** about 48–68 s with no wallet admission per node restart (start 01:17:13 → apps back
     01:17:59–01:18:39).

## 1. Live components (hashes read on the hosts)

| where | component | sha256 |
|---|---|---|
| all 4 fronts | route-dns `/opt/enclave-route-dns/caa-e8fe12132621/dns.mjs` | `e8fe12132621ba4e…` (local copy `work/dns-caa-bundle/dns.mjs`) |
| all 4 fronts | directory `/opt/enclave-directory/runtime-37366ab/enclave-directory.mjs` (the same-route churn fix) | `37366abb5a33725c…` |
| us-west, ap-southeast, eu-central | provider `native-recovery-464cad3/provider.mjs` | `464cad341e4a816a…` |
| ca-east | provider `hs-transport-39d1513b/wg-provider.mjs` (the A1 canary) | `39d1513b8a884317…` |
| minipc | `C:\Program Files\Enclave\network\privacy-agent.mjs` (installed 2026-10-22 02:21Z) | `cfb69370a00dea14…` (= `root-control-rpc-final-20261022/control-package/files/network/privacy-agent.mjs`) |

**IPs:** us-west 134.199.235.187, ca-east 146.190.246.39, ap-southeast 165.245.191.129, eu-central 134.209.248.172.

## 2. Evidence timeline (UTC)

| time | where | event |
|---|---|---|
| 01:04:40–01:08:23 | ca-east provider | "lease 0x59f1273d: no fresh agreeing chain quorum … using the agreeing read from 18–64 s ago" (×6) |
| 01:05:05 / 01:05:26 | minipc | 59f1 egress OFF / back (also a69dcbba; 38f368d6 01:05:21–35) |
| 01:05:37 | minipc | "app 0x59f1273d: guard provider 146.190.246.39: chain quorum unavailable" |
| 01:06:07–01:07:59 | minipc | OFF/back for ef514ed3, 38f368d6, a77d0c57, 7ae476a3, c13d4b6a, e64f7cba |
| **01:07:35 / 01:08:00** | minipc | **59f1 egress OFF / back** |
| 01:07:24–01:08:04 | us-west, ap route-dns | route map 9 → 6 → 7 → 8 → 11 labels |
| 01:07 / 01:08 | root | us-west TLS unexpected EOF while ap answered 200 / directory and DNS without us-west (A TTL 15 s) |
| 01:17:13 | minipc | new node (e7) started (root's receipt) |
| **01:17:30** | minipc | **"wallet admission withheld: invalid or expired wallet admission document"** |
| **01:17:31** | minipc | **all 9 running apps egress OFF** |
| 01:17:34–35 | all fronts' route-dns | "route map dropped to 2 label(s); keeping the previous 11 for 12 s" |
| 01:17:49–50 | route-dns | the map is 2 labels (hold expired) |
| 01:17:58–01:18:37 | minipc | 19 "AppContainer verified" (circuit workers rebuilt) |
| **01:17:59–01:18:39** | minipc | apps egress back (**59f1 01:18:19**) |
| 01:18:09–01:18:49 | route-dns | 3 → 4 → 7 → 10 → 11 labels |
| 01:18 | root | normal URL briefly failed; dig gave 146.190.246.39 + 134.209.248.172; ap direct 200 |
| 01:19:00–01:26:53 | minipc | **0** egress OFF |
| 01:28:29 | public | authoritative A 165.245.191.129 TTL 15; normal URL 200, tlsverify 0 |

**OFF events per 5 min under the old node:**
- 00:00 6, 00:05 9, 00:10 15, 00:15 4, 00:35 4, 00:40 18, 01:05 11;
- 01:15 9 (the restart);
- before midnight, about one per 5–10 min.

## 3. Mechanism in source (live bytes)

**Host side** (the minipc privacy agent, `cfb69370` = source `network/*` of the installed lineage):
- **What authorizes egress.** `wg-manager.mjs:62-66` `authorizationUntil` = min(lease `validUntil`, guest proof
  `validUntil`, **wallet allow** `walletUntil`).
- **Misleading log text.** The OFF log `egress-map.mjs:16` says "(lease or guest proof)" and **omits the wallet**,
  which made the 01:05–01:08 lapses look like lease or proof failures.
- **Withdrawal.** On a lapse, `enforceAdmission` → `withdraw()` (`wg-manager.mjs:68, 87-95`):
  - closes every circuit immediately ("Local traffic stops independently of a slow/unreachable route distributor");
  - THEN publishes `routes: []`.
  - Re-admission builds NEW circuits, possibly through other providers, which gives new addresses.
- **Wallet channel** (`network/wallet-admission.mjs`):
  - `WalletAllowWriter` is "empty-on-start" (a new generation, `allows: {}`).
  - The document expires `CHANNEL_MS` = 30 s after its last commit, and each allow lasts at most `POLICY_MS` = 90 s
    from a verified decision.
  - A stopped node therefore withholds every app ≤ 30 s later, and a new node grants each app only after its own
    first verified decision. Both are fail-closed by design.

**DNS side** (route-dns `e8fe1213`, read from the live bundle):
- **Poll.** It polls the local directory; the logs show 5–20 s between map changes.
- **Collapse-hold.** When the map drops below half (`t.size*2 < previous.size`, ≥ 2 labels), it keeps the previous
  labels for `WQ` = 12 s (`ROUTE_SHRINK_CONFIRM_MS`). It keeps them **only while each route record's own signed
  `expiresAt` is still in the future**.
- **Effect.** This is a bounded guard against directory glitches; it serves no authority. During a REAL mass
  withdrawal it lengthens the dead-path window by up to 12 s, which it did at 01:17:35–01:17:47.

**Provider side.**
- Guard and exit peers for 59f1 linger on the fronts until they expire (for example us-west guard removed 01:16:56,
  ap guard 01:14:00), but a closed host circuit no longer answers. The fronts end the TLS session: the EOF root saw.
- ca-east's provider re-checks each app's lease through its own chain quorum and fell back to held reads of up to 64 s
  (existing bounded behaviour). Under the shared public-RPC quorum trouble this is a further source of circuit failures
  and rebuilds.

**Answers to the two questions:**
- **Can a valid client be sent to a withdrawn path?** Yes. From the host's withdrawal until clients stop using the old
  addresses takes:
  - the directory and route-dns propagation (observed 3–20 s);
  - plus the collapse-hold (≤ 12 s, only when more than half the map drops);
  - plus the client resolver cache (TTL 15 s, or longer where a resolver enforces a minimum TTL; not measured).

  So up to roughly 30–50 s per event. The reverse applies on re-admission: new addresses appear only after the same
  propagation.
- **Is there a safe handoff?** Not for authorization-driven withdrawal, and by design there must not be one: serving
  after the lease, proof or wallet lapses would be stale-authorization grace. The only "grace" is route-dns's bounded
  12-s collapse-hold, which grants nothing (the host still refuses).

## 4. Bug or behaviour?

- **The DNS TTL plus propagation is normal behaviour**, and it is correct to withdraw first. There is no routing defect
  that sends clients to a path the system still considers valid.
- **The real cause is the frequency of authorization lapses on an otherwise valid app:**
  - **Old node, slow-pass wallet allow:** already fixed in source and deployed with e7 at 01:17 (ad4a72a's refresher).
    It needs a longer observation (hours, across lease renewals; the first keeper renewal was due about 01:29) before
    it is called fixed.
  - **Node restart:** inherent, about 48–68 s for all apps. It can only be shortened by publishing verified wallet
    decisions earlier in a new node's start, not by inheriting old ones.
  - **Chain-quorum read failures** (host and ca-east provider): the existing public-RPC capacity problem
    (memory: host wallet policy quorum).
- **Small diagnosability defect (not patched, root's call):** `network/egress-map.mjs:16` should name the lapsed factor
  (lease, guest proof or **wallet allow**), for example by asking the manager for the minimum term. It changes no
  decision. It ships in the 2.9 MB privacy-agent bundle, so it would ride the next privacy-agent release rather than
  justify one.

## 5. Remaining uncertainty

- The exact route sets the directory published for 59f1 between 01:07 and 01:18 are not recoverable: the directory
  logs nothing per label. Root's dig at 01:18 (ca-east + eu-central) and the ap-direct 200 are consistent with rebuilt
  circuits being published before the client's cached answer turned over, but that is not proven.
- Whether the 01:05–01:08 lapses were wallet, lease or proof: the log line cannot tell (§4). The attribution to the
  wallet slow pass rests on the old node's known defect and the drop to 0 under e7; it is not proven per event.
- The resolver behaviour of root's client (minimum TTL) was not measured.
- 59f1 currently has ONE published path (ap-southeast). A lapse of that circuit is a full outage until a rebuild.

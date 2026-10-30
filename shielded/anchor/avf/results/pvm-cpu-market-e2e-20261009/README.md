# The first purchase on a pVM host (2026-10-09, production, Base mainnet)

The phone (`pixel10-pvm-cpu`, Pixel 10 Pro XL, release build `769b5947…`, protected) bought like any other host. The
buyer was the platform's agent wallet; every step went through production: the ledger on Base, the relay on nan
(`PVM_MARKET=1`), the platform certificate service, the DNS daemon and TUNA.

| time (UTC) | step | evidence |
|---|---|---|
| 02:26:38 | the host agent registered `https://api.enclave.host/t/pixel10-pvm-cpu` at 2 µUSDC/s with the VM's attested proof key | tx `0xa9e7f8d7…`, block 52361724 |
| 02:37:07 | re-stated for the protected build `769b5947…` (a dev build is refused by the relay) | tx `0x61cc960c…`, block 52362039 |
| 02:36:54 | nan: `pixel10-pvm-cpu pvm-cpu ADMITTED`; the row: eligible, serving, `appEvidenceRequired`, operator `0x8179…E84e` | relay-log.txt, enclaves-row.json |
| 02:41:2x | buyer: `create` hello-world 1.0.4 (catalog `0x5356e8bd…/4`), 25 % CPU, placement pin to the phone, rate cap 1; funded $0.25 (EIP-3009); claim hint to `pixel10-pvm-cpu` → "accepted" | deployment `0x7f45af3e9e9bf1261048ff24e81d589d91b7fff33f941466db190ca90b30a5fd`, txs `0x5615b269…`, `0x45b7fa67…` |
| 02:41:48–02:42:34 | the agent fetched the component by CID (`29090a8d…`), restarted the VM serving it with the lease's proof pins | host-agent-events.jsonl (`taking`, `vm-serving`) |
| 02:42:42 | claim | tx `0x4797a85c…`, block 52362206 |
| 02:42:48 | first VM-signed checkpoint, then one every ~5 min | txs `0x88afdafa…`, `0x4dae88b8…`, `0xc4557792…`, `0x9a697e86…`, `0xbcdb5f1e…` |
| 02:42:53 | nan: `[pvm-market] verified pixel10-pvm-cpu/0x7f45af3e: app 29090a8de8d5, TLS key 98585697b696, instance cd3358ebfc12` | relay-log.txt |
| 02:51:51 | nan: ZeroSSL issued `7f45af3e.app.enclave.host` (ec-p256: the VM's own key); the agent installed it in the VM | relay-log.txt, `cert-installed` |
| 02:52–02:56 | the phone's TUNA privacy agent: local proof (the VM's v4 evidence on its own TLS connection), a guarded circuit on 107.174.142.20, route published | tuna-route.json |
| 02:56 | `curl https://7f45af3e.app.enclave.host/` → `Hello World!` (WebPKI, ZeroSSL ECC DV, ~0.44 s); `/.well-known/enclave-ready` → 200; `http://` → 308 | |
| 03:03:11 | buyer: `setActive(false)` (tx `0x39bb1967…`); the agent's round had just renewed (`0x49e178a6…`) | |
| 03:04:18 | the agent saw the stop: release (the unused tail back to the buyer), then the idle VM | tx `0x9131f07b…` |
| 03:05:21 | buyer: `setActive(true)` (tx `0x22c3081c…`) | |
| 03:06:29 | the agent's sweep took it back (pinned to this host): VM restarted with the app, claim, certificate from the relay's cache | tx `0x0c63bd34…` |
| 03:09:55 | `https://7f45af3e.app.enclave.host/` → `Hello World!` again; `servesDeployments` lists it; the row shows its one slot taken | enclaves-row.json |

Also in this run (found and fixed live): the DNS daemon's eligibility took app-evidence hosts only of mode hv-node, so the
first dns-01 push was refused (relay/fleet.mjs, main d87c0ac79, hand-deployed to nan-relay before CI could ship it: CI's
relay job refuses while an admitted app has no TUNA route); the agent first trusted a stale capture after an APK update
(liveness check added); a dev-mode build was refused by the relay (protected build).

Files: host-agent-events.jsonl (the agent's own events; raw transactions removed), relay-log.txt (nan's lines for this
host), tuna-route.json, enclaves-row.json.

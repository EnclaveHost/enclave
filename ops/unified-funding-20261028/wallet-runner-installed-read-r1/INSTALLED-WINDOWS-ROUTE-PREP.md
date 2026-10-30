# Prepared-only Windows per-app runner release route investigation

No runnable invocation is qualified by the available artifacts. No remote read, live request, signer process, code edit, restart, author, test, build or financial action was performed. This review uses prior captures and identifies the exact missing external entry point; root owns fresh installed identity/source inspection.

## Stronger historical source than generic checkout

`work/restore-queued-20261028/nucbox-reconnect-source/metadata.json` names C:\Program Files\Enclave\control\windows\node\agent.mjs, observed mtime2026-10-26T17:15:54.9295109Z and SHAa41ca4cd59252d6a00648fda88232e97fe92049c8142dc1bf7910ae38ecae1a4. Actual local file hash agrees. Its agent,chain,host and lease-gas bundle bytes also exactly match root's installed-manager-http-baseline-r1/control/windows/node source copies. The baseline PROVENANCE traces a separately captured source archive whose manager-server hash matched prior installed inspection. That does not independently prove every module currently loaded by the agent; preserve this evidence limit.

Prior identity observation at2026-10-29T21:17:26Z found SYSTEM scheduled task\Enclave\Node, node.exe listener9600/PID41272 with known agent entry. Effective NODE_DIR and task-process ancestry were explicitly unqualified. Do not use old PID as current identity or infer a new process from a stale port observation.

## Existing internal path in that captured build

- chain.mjs349 exports releaseDeployment(id) -> leaseSend("release",[id])285.
- With configured app-funded leases, leaseSend uses the in-process chainTx promise queue318, shared with ordinary operator sends and EIP7702 account-nonce consumption. It loads actual configuredLeaseSender/bindings from the same process.
- Release requires the durable release journal292; begin(id)296 persists before signing, onSigned297 records each signed intent before relay visibility. Pending unknown outcomes remain held; nonces consumed are fences, not release-success claims.
- A successful exact quorum-verified receipt settles the journal315. resolvePendingReleases321–338 reconciles recorded operator/chain/reserve/executor/ledger identities, rather than current settings; expired or consumed is not recorded as released.
- host.mjs190–191 sets journal to cfg.dir/lease-release-journal.json. Private #giveUp2611 revokes local renewal/wallet permissions, confirms retirement, stops app/forgets serving, reads current runner and calls releaseDeployment2646. Concurrent #giveUp requests share one in-process promise2604.

This is useful existing implementation, but an exported ESM function is not an externally callable command in the running agent. A new process importing chain.mjs would initialize another signer/nonce queue and is specifically NOT a safe substitute.

## External surfaces inspected: none invokes a targeted release

1. Agent localHttp802 POST /v1/host/run invokes runUnleased; it is not a migration tool.
2. Agent localHttp806 POST /v1/host/stop only accesses host.apps, calls app.stop and deletes that local entry. It neither calls chain.release nor reliably represents an isolated VM (which is not necessarily in host.apps).404 not_running is not proof the lease is gone.
3. Agent generic /v1/deployments/<id> branch627 returns the row regardless of HTTP method. DELETE can return200 without stopping or releasing. POST restart636 requires a live lease and restarts; it is not release.
4. The separate token-authenticated hosting control9610 is imported from hosting.mjs and receives{host,port,token,payouts}; no arbitrary chain-call adapter is passed. Baseline hosting.mjs411–444 supports earnings/payout-wallet/payout,price and GET/PUT hosting caps. Drop is acknowledgment of the host's computed cap-reduction plan; extra IDs absent from that plan do nothing. No per-app release/stop/manual transaction route exists in this source.
5. Captured host inactive handling2373 calls #stopApp2799, which retires and untracks but doesn't release the chain lease. #giveUp is private and reachable through failure/cap-drop flows; do not manufacture a failure, force claim-hint, modify placement or pause/reduce host-wide caps to reach it.

## What root's bounded installed inspection needs to decide

Identify the current listener/process start/actual module path and hashes for agent,host,chain,hosting,lease-gas bundle; determine whether a later installed route or IPC exists that calls releaseDeployment or a targeted retire+release method IN THE EXISTING PROCESS/queue. Compare its actual authentication/request schema, per-ID isolation, journal semantics, pending-operation status and exact ledger/operator bindings. Only an actual current exposed entry point can yield a concrete safe invocation. Do not dump operator keys/tokens, raw private journals or inherited environment. Public pending state/identity and receipt hashes suffice for qualification.

If no later route exists, the existing-artifact answer is NO qualified external per-app command. Report that honestly rather than produce a fictional URL or second-process signer script. A minimal new route/change would be separate work requiring root review/admission, not prepared or launched here. No host/global restart is implied.

## Root's new chain observation, recorded as reported evidence

At common block53272441 API+Azul: DNS first refund tx366ff41ca1f118bc71be828ccedb3e591e5bf100f4ae8be1a626756d767c645b at53272262 paid4799124microUSDC toB794. DNS activefalse,balance0,ownerEscrow50876,earn111600,refundable0. Thus NO second refund now. KVM still active/refundable4425558 at that block; no refund yet then. Current runner/operator in that report remain2fcef48d…/1a01194c…. Old gas buckets retained for release; do not withdraw them first. These values are root's fresh report, not independently queried by this preparer. A62 included transfer is not replayable; root reports below-finalized as of that observation.

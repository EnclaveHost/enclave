# Enclave RPC r13 (1.3.0): the cutover from r12

Status: **PREPARED, NOT RUN** (2026-11-12 08:45Z). Production is r12 (1.2.0, catalog version 3) with no app
address. Image r13 is built and qualified (`IMAGE-r13.json`, `release.json`, `RELEASE-MANIFEST.json`; see
`../ROOT-RESULT.md`). Nothing on the host, the control VM, the edges or the chain has been changed for it.

What r13 gives the deployment `0x5ff56a4d…454f`: the address `https://5ff56a4d.app.enclave.host`, a page behind it
served by the VM itself, and with site release r6 (`../site-whole-vm-address-r6/`) the dashboard row's address and
Open link.

## Order

The lease's catalog version decides what the host may launch, so the move is a stop and a start, not an in-place
swap. Each step is checked before the next.

| | Who | Step |
|---|---|---|
| a | owner | publish catalog version index 4 (`PLAN.json` step `publish`) |
| b | operator | `host-prepare.sh all`: network agent and reconciler that admit and route a whole-VM app; VM manager on release `19572bf2c` with the relay's certificate service configured and the deployment bound to image r13. r12 keeps serving |
| c | owner | `setActive(id,false)` (step `stop`): metal0 shuts the VM down and releases the lease |
| d | owner | `multicall([setAppRef(…/4), setConfig(…measurementsFrom …/4), setActive(true)])` (step `start`), offered once the lease is released |
| e | operator | `finish.sh`: host-local proxy to r13's measurement, gateway chain policy to version 4, wait for the guest's certificate, run the reconciler, check the app address |

`run-cutover.sh` is b, site release r6 and e in one command; it waits while the owner signs a, c and d on the
signing page (`rpc/snp/owner-sign/server.mjs PLAN.json 42291`, loopback only; the page offers a step only when the
chain and the host are ready for it and simulates it first).

```
bash ops/rpc-snp-prod-r7/release-r13/run-cutover.sh
```

Between c and the r13 guest answering, public Ethereum is down (the gateway serves it from the enclave only) and
Base falls back to its providers. r13 starts on r12's chain disks, so the wait is a replay, not a sync.

After b the manager refuses to relaunch version 3 (the bound image is r13's, and it launches only the image the
lease's version names). The running r12 guest is not touched, but a restart of it before d would not come back.
Rollback before d: `host-prepare.sh rollback-manager`, then the owner's `setActive(true)` alone. After d the way
back is a further owner transaction to version 3 with the r12 binding.

## Files

- `PLAN.json`: the three owner transactions and what the signing page checks before offering each. Built by
  `rpc/snp/owner-sign/upgrade-plan.mjs` from `release.json`; calldata simulated against Base from the owner address.
- `host-prepare.sh`: step b. `agent` records which app names answer before the swap and puts the previous agent
  back unless the new one brings its control circuit up, keeps its pid and serves every one of those names again;
  `manager` puts the r12 release and binding back unless the new manager adopts the running guest.
- `finish.sh`: step e; every part is skipped when already done. Its read-only probes were run against the present
  state (r12 serving): `start=False leased=True`, guest up, proxy answers, gateway serves Ethereum, no route record,
  app address does not answer.
- `agent-whole-vm.patch`: the network agent and reconciler change as deployed (below).

On the host, not in the repository: `/vm/enclave-volumes/rpc-snp-release-r13/` (the plan, the agent bundles, the
control VM ssh wrapper), `~/.config/enclave/snpvm.r13.json` (the manager config b installs; it names the operator
config file that holds the host's relay credential).

## The network agent for a whole-VM app

metal0's deployed agent is not built from main: it is the tree at `266c98d1f` (rebuilt here, its bundles equal the
deployed ones byte for byte: agent `cbcc2c55…2b2c`, reconciler `b8a93826…d332`). The release is that tree plus
main's whole-VM change (154f4f458, 19572bf2c) to `network/guest-probe.mjs`, `privacy-agent.mjs` and
`reconcile-apps.mjs` (`agent-whole-vm.patch`), with main's `network/snp-vm-app.mjs` added unchanged; the verifier it
imports is the base tree's, which equals main's.
Bundled as `network/build.mjs` does (esbuild, node22, esm):

| file | sha256 |
|---|---|
| `privacy-agent.mjs` | `a4d6e11c7dbb2ec20ba2c88faa820980b06e5aecdc4b944ee025ce4224671f62` |
| `reconcile-apps.mjs` | `d3152798e3754c821ed0e64effde07ea069ac15d6ded55654b0fc8d928487cf2` |

Tests in both trees (`snp-vm-app`, `privacy-agent-config`, `privacy-agent-proofs`, `reconcile-independent`,
`guest-probe-busy`, `guest-probe-sni`, `shield-ingress`, `custody-direct-ingress`): patched tree 31 tests, 30 pass,
none fail; base tree 21 tests, 20 pass, none fail. Dry run of the new reconciler against the live
config: the same decisions as the deployed one for the other apps, and for this one "whole-VM app serves no
certificate for catalog://…/3 yet; skipped".

The manager's launch check was run offline against the candidate config: the r13 binding accepts the plan the
supervisor derives from version 4 (8 vCPU, 65536 MiB).

## Not yet exercised

These need the live lease on the name and first run in e: the relay issuing a certificate for
`5ff56a4d.app.enclave.host` (the endpoint exists; an empty request is refused 422), the manager installing it in
the guest and writing the route record, the reconciler enrolling the app from that record, the agent admitting the
VM on its report, and the edges resolving and routing the name. `finish.sh` says at which of them it stops and
prints the journal that explains it; r13 serves the RPC on its attested certificate either way.

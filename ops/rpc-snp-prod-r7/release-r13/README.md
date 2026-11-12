# Enclave RPC r13 (1.3.0): the cutover from r12

Status: **r13 RUNNING WITH ITS ADDRESS; GATEWAY AND CONTROL IMAGE PENDING** (2026-11-12 10:21Z). metal0 claimed the
deployment 10:14:55Z and runs the r13 guest; `https://5ff56a4d.app.enclave.host` answers 200 on a publicly trusted
certificate and the dashboard row shows RUNNING with its address and Open link. Two operator steps remain (see "The
run"): the gateway's chain policy still names version 3, so public Ethereum through the gateway is down until
`finish.sh` moves it, and metal0 still runs the control image whose policy quorum rarely answers
(`control-image.sh apply` does both).

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

## The run (2026-11-12)

| time (Z) | |
|---|---|
| 08:44 to 08:49 | `run-cutover.sh`: `host-prepare.sh all` (agent, reconciler, manager on the r13 binding), site release r6 active on the four edges |
| 09:09:51 | owner: publish version 4, `0x5ef95a9ddb50b3b5c8759352749346fa699ba120742f54b082fc5480eaa2aed9` |
| 09:10:04 | owner: stop, `0xdc8383bd3ab2d544d0d796f15a70cafcead4c0bfd3a06e0d82b4893b53e9c204`; metal0 shut the r12 guest down and released the lease (`0x3897fe633ee6ee1693d5274a251860e5d25b3223c9f6c3f4e6ce050e1a6a07d8`, block 56421520) |
| 09:29:16 | owner: start on version 4, `0x15ef8577e69feed0d618793d44d4d11aecd413a408e1a783f8e1811fb51c9db3` |
| 09:59 | `finish.sh` gave up waiting for metal0's claim (30 minutes) |
| 10:14:35 | metal0 admitted on one readable policy round (still the old control image) |
| 10:14:55 | metal0: claim, `0xf0e76ba4679a1d00939fb2beba8069e913f57190c55515ae069ac15a9998fd7d`; VM launched 10:14:59, lease until 10:44:53 |
| 10:15 | guest front ready 13 s after launch, measurement f3e72089…4b5c; the relay issued the certificate (ZeroSSL ECC DV, not after 2027-02-10) |
| 10:17 | the manager's second delivery of the chain was confirmed and it wrote the route record; the reconciler's timer run (10:17:35) enrolled the app and reloaded the agent |
| 10:17:22 | host-local proxy moved to r13; `eth_blockNumber` answers through it (the guest attests) |
| 10:18:41 | `https://5ff56a4d.app.enclave.host/` 200, certificate verified, served through the edges; page, `/health` and the attestation panel render |
| 10:19 | dashboard (owner's browser): `enclave-rpc:1.3.0`, RUNNING, on metal0, Open link "TLS verified by this browser", address |

**Still to do (operator).** The gateway on the control VM names version 3 and refuses the enclave ("chain refuses
enclave: deployment runs a different app version"): `finish.sh` sets `versionIndex` 4 and restarts it; every other
part of `finish.sh` is done and is skipped. metal0 is still on `dist-snpvm-b4446c3`: its admission at 10:14:35 was one
lucky read, and while it is not serving it neither claims nor renews. `control-image.sh apply` switches the image and
then runs `finish.sh`.

**The first certificate delivery failed inside the guest.** `front.py` took the chain and then raised on its own log
line (`stage('certificate', name=…)` against `def stage(name, **fields)`), so the manager's POST got no answer. The
chain was already being served; the manager's retry a minute later was answered `installed` (same chain, nothing
newer) and the route record followed. Cost: one minute and a second ask of the certificate service. Fixed in source
(`def stage(event, /, **fields)`; the test now runs the real function instead of a stub); image r13 carries the bug
and behaves the same way on every fresh boot.

**Why metal0 did not claim.** Not the deployment and not the new version: metal0 was not serving at all. A host takes
work only while its platform host policy gate can read the policy, and the gate reads through its own quorum, 3 of
the 4 public Base RPCs compiled into the measured control image. Of those, `base.public.blockpi.network` no longer
answers without a key and `base.drpc.org` rate-limits keyless traffic, so any slow answer from the other two made the
policy unreadable. The journal: `[host-policy] this host is not serving: policy unreadable: only 2 RPCs answered
(need 3)`, every minute from 09:26Z (the last admitted reads were 08:04Z and 09:00Z), and the claim sweep skips every
deployment while the host is not serving. The dashboard's line under the queued row ("its options carry snpVm, which
this host does not apply") is a different host type declining the deployment, as it should; it is not metal0's reason.
The gate fails closed and the image carries no unmeasured override, so the remedy is an image whose quorum answers.

**The control image.** Main 5b292efce makes the quorum five keyless endpoints that answer (majority still 3).
`~/enclave-prod/dist-snpvm-16520ea` is the running image's tree (`dist-snpvm-b4446c3`, see `../ROOT-RESULT.md`) with
that one change: of the 40 overlay files only `/app/windows/node/host-admission.bundle.mjs` and
`/opt/metal/host-policy.bundle.mjs` differ, same kernel, initramfs sha256
`a6b7e1a7694087ef2e00c1f8d53d90923bd68aaaf1b55d7891a6451b7e3d51e0`, launch measurement
`a74528dc6910b64656f5c9e5126e2f4eb04b39232a5358c1248c206ea03a9fbe10c0a4d509f2d8d22ed08cea3e0ee1e8` (the same
`sev-snp-measure` invocation reproduces the running image's c9fe2438…12d5). The real policy decision for metal0,
read through the new list from this host, was readable in 28 of 30 rounds 20 s apart (`admit=true
status=not-activated`); a host keeps serving for 15 minutes after its last admitted read.

`control-image.sh apply` puts it in service: the measurement is added to the relay's `METAL_ALLOWED_MEASUREMENTS`
(previous file kept as `linux-leasegas-measurements.env.before-snpvm-16520ea`), metal0's config is pointed at the new
image (kept as `config.json.before-snpvm-16520ea`) and `enclave-metal` restarted; unless the relay accepts the new
measurement within five minutes the previous image is put back. It then waits for the host to be admitted, for the
claim, and runs `finish.sh`. `control-image.sh rollback` returns to the previous image.

The same four endpoints are compiled into every component built before 5b292efce that enforces the platform host
policy, and into the custodian's measured RPC list (`custody/v2`, a separate measured configuration, not changed).

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
- `control-image.sh`: metal0 onto the control image whose policy read quorum answers (above), then `finish.sh`.

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

## First exercised in this run

The relay issuing a certificate for `5ff56a4d.app.enclave.host`, the manager installing it in the guest and writing
the route record, the reconciler enrolling the app from that record, the agent admitting the VM on its report, and
the edges resolving and routing the name: all worked on the first live run, with the one retry described above.
r13's L1 execution client started on r12's disks about an hour behind and its beacon node caught up at about 30 slots
a minute; Base starts once the L1 head is fresh.

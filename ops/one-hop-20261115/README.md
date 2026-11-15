# One hop: the release (prepared 2026-11-15; steps 1 to 3 of 6 done: the four edges, the control VM, the frontend; of step 4, the NucBox, the Node half)

One hop (main `f814b020a`, design in `docs/design/enclave-network.md` "One hop") lets an app's circuit be one
provider with no guard: host → provider ← visitor. It takes two choices, neither enough alone: the app's owner signs
`enclaveNetwork.guard: false`, and the operator of the host sets `enclaveNetwork.oneHop` for that app. What it gives
up: that one provider sees the host's address together with the app's names and visitors.

This folder is the release that carries the change onto what runs today: the four edges, the control VM, the
frontend and the NucBox. **The operator runs every step that changes something.** What has been run is under
"Activation" at the end; the rest of this file is as it was written before anything was installed.

State at 06:40Z on 2026-11-15, before anything was installed:

- Four edges: provider and directory on the previous builds; `one-hop-edges.sh preflight` passed on all four at
  05:43Z (`activation/<edge>.preflight.txt`).
- Control VM: policy bridge, route pull and relay on the previous files and at work; `one-hop-control.sh preflight`
  passed at 06:33Z (`activation/control.preflight.txt`).
- Frontend r7: built, not activated on any edge.
- NucBox: the release's three files staged in `C:\ProgramData\Enclave\one-hop-20261115\` at 05:14:39Z and verified
  there; nothing running changed. The box has run `near-routes.sh node` (02:27–02:29Z); it has not run
  `near-routes.sh agent`, so `nearRoutes` is not set and the agent is the October one.
- The KVM Box app (`0x9a28642b…`) has no owner policy stored, at the relay or in any of the four directories. Its
  circuits are guard Toronto → exit San Francisco and guard Frankfurt → exit Singapore.

## What has to carry it, and why the order is fixed

A validator that knows only `guard: true` refuses a policy with `guard: false` whole. So every program that checks
an owner's policy must run the new rule before any owner signs one, and the program that takes the signature in goes
last. Reading what runs found more of them than the four components the change was planned for:

| where | program | on the previous file, with one stored `guard: false` policy |
|---|---|---|
| each edge | provider (two different builds: one on three edges, another on ca-east) | refuses a host's direct exit request for that app |
| each edge | public directory | refuses to store the policy; the host never reads it |
| control VM | policy bridge (relay → directories, every 5 s) | stops its whole round: no owner's policy is copied any more |
| control VM | route pull (directories → relay, every 10 s) | drops that app's route publication, with no error |
| control VM | relay | refuses the owner's signature. This is the gate |
| frontend | hosted Network tab | cannot offer the setting, and its validator refuses a policy that has it |
| host | network agent, node enrollment | withdraws the app's network; the node removes the operator's field |

Route DNS on the edges does not check policies and is not touched. The relay's manifest is left as it is (nothing
reads its digest of the bundle at start). The pinned host-service packages (`network/host-services/packages`,
directory replica and policy mirror) still carry the previous validator and cannot be rebuilt from this worktree;
where they run was not established.

The path of a policy: Network tab → relay → policy bridge → the four directories → the host (read about once a
minute). The path of a route publication: host → directories → route pull → relay.

## Files

| file | what |
|---|---|
| `one-hop-edges.sh` | the edges' command: `status`, `preflight`, `activate`, `check`, `revert` |
| `one-hop-edge-install.sh` | runs as root on an edge: a drop-in names the new bundle beside the old one; a step that does not come up is taken back |
| `rehearse-edge-install.sh` | the installer and the runner against stand-in services in a private namespace (23 cases) |
| `one-hop-control.sh` | the control VM's command: `status`, `preflight`, `activate`, `check`, `revert` |
| `one-hop-control-install.sh` | runs as root on the control VM: bridge, route pull, relay |
| `rehearse-control-install.sh` | the same rehearsal for the control VM (32 cases) |
| `one-hop-bundles.py` | how the six edge and control-VM files were made: the installed file by SHA-256, a fixed list of replacements, every anchor found exactly once |
| `site-r7/` | the frontend release: build, backport, `release.json`, capture, preflight, per-edge apply and verify, `run-activate.py` |
| `one-hop-nucbox.sh`, `one-hop-nucbox.ps1` | the NucBox's command and its NucBox side: `status`, `stage`, `node`, `agent`, `check`, `near-on`, `near-off`, `revert-agent`, `revert-node` |
| `set-one-hop.cjs` | sets or removes `enclaveNetwork.oneHop` where the node's own pass writes it |
| `one-hop-agent-bundle.py`, `one-hop-enroll.py` | how the NucBox's agent bundle and `network-enroll.mjs` were made |
| `qualify/` | one hop over a real tunnel with the patched provider bundles (`one-hop-e2e.sh`), and the control VM's three patched files run offline (`control-vm-check.mjs`) |
| `one-hop-check.sh` | read only, at the end: do the relay, the four directories, the host and the exits agree that an app is on one hop |
| `activation/` | what the read-only preflights found; each run of `activate` writes its result here |

The replaced files are not in the repository: they are copies of installed files with the change carried onto them,
not maintained source. They are in `…/2026-10-23/it/work/one-hop-20261115/payload/<first 8 of the SHA-256>/`, the
installed originals in `installed/` beside them. The frontend's working copy is
`…/rpc-production-final-20261025/unified-funding-20261028/one-hop-site-r7/`.

| installed | bytes, SHA-256 | this release | bytes, SHA-256 |
|---|---|---|---|
| edge provider (three edges) `provider.mjs` | 377,787 `464cad34…b3bc6d24` | `03cb11f6/provider.mjs` | 378,619 `03cb11f6…95640d26` |
| edge provider (ca-east) `wg-provider.mjs` | 877,413 `39d1513b…3a1b6563` | `0c201bd7/wg-provider.mjs` | 878,501 `0c201bd7…7ee130e8` |
| edge directory `enclave-directory.mjs` | 348,090 `37366abb…88fc6e46` | `a49ba438/enclave-directory.mjs` | 348,103 `a49ba438…7bd52308` |
| control VM bridge `mirror.mjs` | 127,415 `a219f492…f232576a` | `3c778817/mirror.mjs` | 127,427 `3c778817…61b58f51` |
| control VM route pull `mirror-public-providers.mjs` | 136,718 `934b511e…04fd7609` | `69b16600/mirror-public-providers.mjs` | 136,730 `69b16600…11e1a7bd` |
| control VM relay `network-runtime.bundle.mjs` | 792,069 `55544ec1…3132215b` | `3bbc6bf0/network-runtime.bundle.mjs` | 792,081 `3bbc6bf0…04a5e749` |
| NucBox `network\privacy-agent.mjs` | October 2,951,587 `5f463944…12ed6366`, or near routes 2,956,624 `576d69da…2fe06ee8` | `9b9c0288/privacy-agent.mjs` | 2,960,676 `9b9c0288…32709c` |
| NucBox `control\windows\node\network-enroll.mjs` | near routes 21,210 `3ba1282c…25b86a09` | `nucbox/network-enroll.mjs` | 21,956 `42bc9b4a…63b43bf` |

The full digests are in the installers and in `one-hop-nucbox.ps1`. Each replaces or supersedes a file only when it
is the installed one by SHA-256.

Frontend r7: CID `bafybeieafatljeedsrts2u4npvk4mfo7z76fopvy6fqkv3gliedzo7wobi`, base the live r6
`bafybeihcq2ckylienfbs3tg6smcucmagz3hcavl4sda44ogjmfz5dze5ia`. 1,730 files: 1,649 of the base kept byte for byte, 81
in the delta, of which one replaces an existing file (`js/boot.js`, which now names the entry
`js/boot-one-hop-r7.js`). CAR 66,203,329
bytes, SHA-256 `f4487b0c…a5421902`. Three source files differ from r4: r6's whole-VM row address, the policy
validator, and the hosted Network tab (the "One hop, no guard" box, offered only when the app's host reports the
setting). Method and scripts are those of `ops/rpc-snp-prod-r7/site-whole-vm-address-r6/`.

## Why backports and not main's files

None of these targets runs a build of main. The edges' and the control VM's bundles are builds from October and
early November with their own histories; the NucBox's tree is from 2026-10-26 with the near-routes release on top.
Installing main's builds would be a full release of each, with everything since in it. `one-hop-bundles.py` makes
each file from the installed one with a short, fixed list of replacements and leaves every other byte as it is; the
NucBox's agent bundle is made section by section from two builds of main (`f814b020a^` and `f814b020a`) onto the
near-routes bundle. Main stays the maintained source of the change; these files are its carriers.

## What was checked

- **The source.** The repository's tests of `f814b020a` (recorded with that commit).
- **The patched provider bundles over a real tunnel.** `qualify/one-hop-e2e.sh` runs a host, a guard, an exit and a
  visitor in unprivileged network namespaces with userspace WireGuard, the provider bundles themselves as the
  guard's and the exit's provider: a guarded app and a one-hop app side by side, a direct request refused with no
  policy, with `guard: true` and with a `guard: false` not signed by the owner, granted with the owner's
  `guard: false`, a visitor's bytes through both, and the one-hop circuit closed when the owner signs `guard: true`
  again. 17 of 17 lines pass with either patched build as the exit and either build, patched or installed, as the
  guard (seven arrangements), and once more with the host's side run by the code of the NucBox's patched agent bundle.
  With an installed build as the exit the run shows what is true today: it grants a host's direct exit request
  whatever the policy says, and refuses a `guard: false` policy whole.
- **The control VM's three patched files, run offline** (`qualify/control-vm-check.mjs`): the relay's validator, the
  bridge's round and the route pull's round, each on the installed and the patched file, with a `guard: false`
  policy and without. 22 lines, all as expected, including that the installed bridge stops its round and the
  installed route pull drops the publication.
- **The installers and runners, rehearsed.** `rehearse-edge-install.sh`: 23 of 23 as expected.
  `rehearse-control-install.sh`: 32 of 32. The scripts run unchanged except the digests, one path and shorter
  waits, against stand-in services and a stand-in `systemctl` in a private namespace: install, repeat, remove, every way a new
  service can fail to come up (cannot start, does not answer, dies after two seconds, does less than the old one),
  the refusals (a file that is not the release's, another drop-in sorting later, the relay before the bridge, three
  of four edges verified, a lease running down with no renewal), and the ways back.
- **The real boxes, read only.** `one-hop-edges.sh preflight` on the four edges and `one-hop-control.sh preflight`
  on the control VM: every guard that can be read without changing anything holds.
- **The frontend.** `site-r7/backport-check.mjs` and the build's own file accounting against the live r6.
- **The NucBox's files.** Main's manager, one-hop runtime, provider-distance and host-egress tests run against the
  code of the patched agent bundle, and main's enrollment test against the patched `network-enroll.mjs`. The staged
  copies verify on the box by SHA-256.
- **`one-hop-check.sh`** against today's state: it reads all four directories, the relay and the host's report, and
  says "not one hop yet" with seven reasons, which is correct.

**Not checked:** a provider on the kernel's WireGuard (this workstation has no module for its running kernel);
nftables `reject` as the edges use it; the patched bundles starting under systemd on an edge or on the control VM;
systemd itself in either rehearsal (drop-in order, `Restart=`, sandboxing); the ssh and sudo paths of the control
runner; any `activate`, `install`, `remove` or `revert` on a real box; the NucBox's `node`, `agent`, `near-on`,
`near-off` and revert modes, which have only been parsed; anything on Windows, including the installed
`enclave-wg.exe` on a circuit with no guard; a grant from a live provider (it takes a leased host that asks);
the Network tab rendered in a browser; the success path of `one-hop-check.sh`. The first one-hop circuit that exists
anywhere will be the one this release makes.

## Order

Each step is one command. A later step refuses when the one before it is not in place.

1. **Edges.** `one-hop-edges.sh activate` — eu-central, ca-east, us-west, ap-southeast, one at a time; on each the
   directory, then the provider. Each provider restart ends the connections through that edge, as a guard or as an
   exit (a stream through it stops and has to be started again; an app's name keeps answering through its other
   circuit where that one is healthy) and the new provider is watched for five minutes, so the four take about 26 minutes. A service that does not come up, or a provider
   that refuses a host's request as "requires a guard" while no owner has signed, is taken back by the installer and
   the run stops there. `one-hop-edges.sh check` reads the result.
2. **Control VM.** `one-hop-control.sh activate` — bridge, route pull, then the relay. The relay is refused unless
   the four edges are verified and the other two run this release's files. Its restart takes `api.enclave.host`
   away for a few seconds; the run waits until the RPC app's lease has at least 15 minutes left, restarts, and then
   watches metal0's journal for the app's next renewal (up to about 26 minutes; `WAIT_RENEWAL=0` skips the watch).
   If the lease gets to 90 seconds with no renewal the previous relay bundle is put back. All three units need the
   start-condition file under `/etc/enclave-control`, which only root can see: the installer checks it before it
   restarts anything.
3. **Frontend.** `python3 …/unified-funding-20261028/one-hop-site-r7/run-activate.py` — capture, apply, verify per
   edge (us-west, ca-east, ap-southeast, eu-central); a verified edge is skipped on a second run. Journal on each
   edge: `/var/lib/enclave-one-hop-site-r7`.
4. **NucBox.** `one-hop-nucbox.sh node` (the Node task alone: two to three minutes with no claims or renewals from
   the box; the apps' VMs keep running), at least two minutes later `one-hop-nucbox.sh agent` (the bundle,
   `oneHop` naming the KVM Box app, the agent restarted: every circuit of every app on the box is built again),
   then `one-hop-nucbox.sh check`. Each step puts the previous file back itself when what it started does not come
   up. One hop takes the nearest provider only with near routes on: either `near-routes.sh agent` before this
   release's `agent` step, or `one-hop-nucbox.sh near-on` after it. Without it the one provider is chosen as
   providers are chosen today, by price and qualification, not distance.
5. **The owner's signature, last.** In the app's Network tab: "One hop, no guard". Nothing before this step changes
   any circuit's shape.
6. `one-hop-check.sh` — read only; ends with `ONE HOP: …` or with the list of what does not agree yet.

Ways back, before the owner signs: `one-hop-nucbox.sh revert-agent` then `revert-node`; `one-hop-control.sh revert`
(relay, route pull, bridge); `one-hop-edges.sh revert`; a frontend edge from the `before.json` and
`before.Caddyfile` in its journal directory. **After the owner signs, the way back starts with the owner signing
`guard: true` again.** The previous files refuse a `guard: false` policy whole: a reverted bridge stops copying
every owner's policy (the rehearsal shows it), a reverted provider or directory takes that app's network away. The
installers refuse `remove` while such a policy is stored unless `FORCE=1`.

## Not established

- Whether anything deployed to the control VM later (a relay release, a new image of that VM) replaces the three
  patched files with files that carry the previous validator. If it does, the bridge stops at the first stored
  `guard: false`. `one-hop-control.sh check` reads which files run.
- What a host's node does with a renewal whose relay answer is lost during the relay's restart. The relay restarted
  at 00:39:08Z today and the NucBox's apps kept their leases; the RPC app's lease is the one the runner times.
- How many policies the relay holds (its state file is root's). The running bridge has copied five apps' policies.
- Why the route pull drops between 3 and 10 publications in each round today, on the previous file.

## Activation

**1. Edges, 2026-11-15 07:18–07:44Z, run by the operator** (`one-hop-edges.sh activate`). On each edge the directory
and then the provider were restarted on this release's builds, each provider watched 300 s; no step was taken back.
Evidence: `activation/<edge>.result.txt`, `<edge>.verified.json` (the `preflight.txt` files are those of this run).

| edge | directory | provider | provider after (guard / exit / direct peers) | verified |
|---|---|---|---|---|
| eu-central | `a49ba438` 07:18:49Z | `03cb11f6` 07:24:18Z | 10 / 3 / 0 | 07:24:32Z |
| ca-east | `a49ba438` 07:25:19Z | `0c201bd7` 07:30:48Z | 9 / 3 / 0 | 07:31:00Z |
| us-west | `a49ba438` 07:31:42Z | `03cb11f6` 07:37:09Z | 6 / 6 / 0 | 07:37:17Z |
| ap-southeast | `a49ba438` 07:38:35Z | `03cb11f6` 07:44:05Z | 3 / 8 / 0 | 07:44:27Z |

Read afterwards, 07:49–07:50Z: `one-hop-edges.sh check` passed for the four (both services on this release, no
request refused as a host's own, every app name that answered through an edge before answers through it now; the ten
probed names answer). The RPC app's lease was renewed at 07:34:39Z, during the run. `one-hop-control.sh preflight`
passed again at 07:50Z with four of four edges verified. This is the first time the patched builds have started under
systemd, on the kernel's WireGuard and with nftables; no host has asked an exit directly, so the grant of a one-hop
request by a live provider is still unseen. ap-southeast's provider came back with 3 guard peers where it had 4; which
peer did not return was not read.

**2. Control VM, 2026-11-15 08:24–08:52Z, run by the operator** (`one-hop-control.sh activate`). The bridge, the route
pull and then the relay were restarted on this release's files; no step was taken back. Evidence:
`activation/control-<service>.result.txt`, `control.verified.json`.

| service | file | restarted | after |
|---|---|---|---|
| bridge | `3c778817` | 08:24:05Z, done 08:24:34Z | copied 5 of 5 stored policies, 0 error lines |
| route pull | `69b16600` | 08:24:39Z, done 08:25:03Z | last round handed on 36, dropped 4 (37 and 3 before), 0 error lines |
| relay | `3bbc6bf0` | 08:26:41Z, done 08:27:04Z | `/v1/network/status` answers 200 |

The relay step waited for the RPC app's renewal (08:26:37Z, lease until 08:56:36Z) and restarted the relay four seconds
after it; the API answered from the workstation at 08:27:06Z. The run then watched metal0's journal: the app renewed at
08:52:37Z, until 09:22:36Z, and the run wrote `control.verified.json` at 08:52:40Z. Read afterwards, 08:53–08:54Z:
`one-hop-control.sh check` passed, `one-hop-edges.sh check` passed for the four edges with the ten app names answering,
and the KVM Box's host reported to the new relay 18 s before the read (two circuits, both with a guard, both healthy;
no owner policy). This is the first time the three control VM files have run there, and the first real use of the
installer's root path. The relay has not been handed a `guard:false` policy; the stored-policy count and the units'
start condition are readable only as root and were read by the installer, not by the checks.

**3. Frontend r7, 2026-11-15 08:57–08:59Z, run by the operator** (`run-activate.py`). Each edge was captured, given the
81 added files beside the r6 tree, switched to the new root and verified over HTTPS; none failed. Evidence:
`site-r7/activation/<edge>.intent.json`, `.result.txt`, `.verified.json`.

| edge | verified | result |
|---|---|---|
| us-west | 08:57:14Z | `apex-switched`, 1,730 files verified on the edge, 2 roots changed, old tree preserved |
| ca-east | 08:57:41Z | the same |
| ap-southeast | 08:58:26Z | the same |
| eu-central | 08:59:23Z | the same |

Read afterwards, 09:00–09:01Z, from the workstation by the site's name: `js/boot.js` names `js/boot-one-hop-r7.js`, and
the 87 files each edge's verification lists were fetched and match the release's SHA-256, 87 of 87; the Network tab's
chunk among them carries the "One hop, no guard" box. That read went to whichever edge the name resolved to, once. The
Network tab has not been opened in a browser, and no host reports `oneHop` yet, so the box is offered to nobody.

**4a. NucBox, the Node half, 2026-11-15 09:03–09:05Z, run by the operator** (`one-hop-nucbox.sh node`). The script's
log stays outside the repository; what it and the reads afterwards show:

| what | when | read |
|---|---|---|
| operator gas on Base | 09:03:28Z | 2.519e-07 ETH (low before this step, unchanged by it) |
| `network-enroll.mjs` replaced | 09:03:31Z | this release's file; the near-routes release's file kept beside it |
| Node task started | 09:03:45Z | one node process |
| Node listed in the registry | 09:04:04Z | `setPrices` failed at 09:04:34Z for lack of gas, as it did before |
| app VMs adopted | 09:04:38–09:04:54Z | seven, each `running`; manager: 8 VMs, none recovered or unattributed |
| app names answered | 09:05:25–09:05:48Z | eight 200, the KVM Box 401 (its sign-in) |

The network agent was not restarted (the process is the one started 11-14 20:18:23Z), but the step was not free for
the apps' routes. The agent's log: at 09:03:59Z it turned egress off for all seven apps ("authorization lapsed (lease
or guest proof)"), and turned it back on between 09:04:16Z and 09:05:00Z, the last app 61 s later. The circuits it
reports afterwards have other roles than before: every app now has guard sfo3 to exit fra1 and guard sgp1 to exit tor1,
where the KVM Box had guard tor1 to exit sfo3 and guard fra1 to exit sgp1; the loopback exemption list went from 180 to
193 entries of 682. The log has no line that names a rebuild, so that the lapse caused it is a reading of the two
together. Whether a visitor was refused in that minute was not measured.

Leases, read from the chain: the four that ran out first were renewed by the restarted Node, each four to five minutes
before its end (`0xd9798e4c` 09:16:17Z to 09:41:41Z, `0xa77d0c57` 09:16:22Z to 09:41:50Z, `0x7ae476a3` 09:17:17Z to
09:42:40Z, `0xa69dcbba` 09:18:16Z to 09:43:40Z; seen between 09:12:15Z and 09:14:18Z). The other three, the KVM Box's
among them, were not yet due. At 09:14Z: no enrollment error since the restart, each of the box's seven apps with its two
network circuits healthy, the storage app's health check 200.

This is the first run of this release's `network-enroll.mjs` on Windows and the first execution of the script's `node`
mode. The agent half has not been run: the agent bundle is still the October one, `oneHop` and `nearRoutes` are absent
from the box's configuration, and no circuit is one hop.

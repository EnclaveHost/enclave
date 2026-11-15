# Near routes on the NucBox (prepared 2026-11-15, not installed)

The KVM Box stream of 2026-11-15 00:45Z ran viewer → Frankfurt (exit) → Toronto (guard) → NucBox
(`ops/gamestream-gateway-20261114/stream-20261115.md`). Near routes (main `1b06202c3`, off unless a host's operator
sets `enclaveNetwork.nearRoutes: true`) lets the host put its nearest provider in front as the guard and the next
nearest behind it as the exit. This folder is the release that carries it, with the enrollment cadence of main
`206f85fd5`, onto the files the NucBox runs. **The operator runs it; nothing here has been installed.**

State at 02:21Z on 2026-11-15: the four files are staged in `C:\ProgramData\Enclave\near-routes-20261115\` and verify
there; the three installed files, the configuration, the Node and the network agent are untouched.

## Files

| file | what |
|---|---|
| `near-routes.sh` | the command: `status`, `stage`, `node`, `agent`, `check`, `revert-agent`, `revert-node` |
| `near-routes.ps1` | the NucBox side of every mode (guards, replacement, restarts, taking a failed step back) |
| `set-near-routes.cjs` | sets or removes the one configuration field where the node's own pass writes it |
| `near-routes-bundle.py` | how the agent bundle was made: the change carried onto the installed bundle, section by section |

The three replaced files are not in the repository (they are copies of an installed tree with changes carried onto
them, not maintained source). They are in `…/2026-10-23/it/work/nucbox-near-routes-20261115/payload/`, the installed
originals beside them in `installed/`, the three patches for the node files there too.

| on the NucBox | installed (bytes, SHA-256) | this release (bytes, SHA-256) |
|---|---|---|
| `C:\Program Files\Enclave\network\privacy-agent.mjs` | 2,951,587 `5f463944…12ed6366` | 2,956,624 `576d69da…2fe06ee8` |
| `C:\Program Files\Enclave\control\windows\node\agent.mjs` | 93,212 `a41ca4cd…8ecae1a4` | 92,268 `f262b30e…f4553eac` |
| `C:\Program Files\Enclave\control\windows\node\network-enroll.mjs` | 16,963 `5c01acb1…5ae4e0da` | 21,210 `3ba1282c…25b86a09` |

The full digests are in `near-routes.ps1`, which replaces a file only when it is the installed one by SHA-256.

## Why a backport and not main's files

The installed tree is from 2026-10-26 and differs from main in far more than these two changes (a whole-bundle
difference against a build of main is 449 kB). Installing main's node and agent would be a full node release with
everything since October in it. So:

- **Agent bundle.** `near-routes-bundle.py` takes the installed bundle and two builds of the same entry point, one
  from `a640a54b9` (the commit before near routes) and one from `1b06202c3`. It replaces the `wg-manager.mjs` section
  only because the installed section equals the parent build's line for line, adds `provider-distance.mjs` as a new
  section, and makes three one-line insertions, each after a line that occurs exactly once. Everything else is the
  installed bundle byte for byte.
- **Node files.** The hunks of `206f85fd5` and `1b06202c3` for `agent.mjs` and `network-enroll.mjs`, applied to the
  installed copies.

## What was checked

- The patched bundle: the repository's manager and provider-distance tests run against it, 17 of 17.
- The patched `network-enroll.mjs` beside the installed siblings: the enrollment tests, 19 of 19.
- The patched `agent.mjs`: syntax check, and every name its changed lines use exists in the installed file. It was
  not executed here: it starts a Windows node.
- `set-near-routes.cjs` on a sample: `on` adds one line after `paceMbps`, a second `on` changes nothing, `off`
  restores the file byte for byte; a file that is not JSON or has no `paceMbps` is refused.
- On the box, read only: `near-routes.sh check` runs every guard's reading (the whole PowerShell text parses as one
  block). 02:21Z: one node (since 11-14 20:31:45Z), one agent (since 20:18:23Z), 8 VMs with none recovered, 164 of 682
  loopback exemptions, the field absent, the configuration in the form the node writes.

**Not checked:** any of this running on a Windows host. The measurement (`net.connect` to port 443 of each ingress
provider) has only run on Linux.

## Order

1. `near-routes.sh node` — the two node files, then the Node task alone. First, because the installed node removes a
   field it does not know from the configuration within five minutes and restarts the agent. The apps' VMs keep
   running; the node adopts them by name. It must list itself again within six minutes and stay one process with no
   `enrollment loop:` error for 80 s, or the previous files go back and the Node is restarted with them.
2. `near-routes.sh agent`, two minutes or more later — the bundle, the field, then the agent process. Every circuit
   of every app on the box is rebuilt. If no new agent appears, it does not stay up, there is no control circuit
   within five minutes or no app has a healthy circuit five minutes after that, the field is taken off, the previous
   bundle goes back and the agent is restarted.
3. `near-routes.sh check` — read only.

`revert-agent` then `revert-node` take it back in that order.

## What it changes, for every app on the box

Distances from the NucBox (TCP handshake, 2026-11-15): San Francisco 23–34 ms, Toronto 81–89, Frankfurt 158–162,
Singapore 186–189. Expected: circuit 1 guard San Francisco, exit Toronto (listed); circuit 2 guard Frankfurt, exit
Singapore (built, standing by, listed only when circuit 1 is unhealthy).

Sums of the legs for a viewer beside the host / in Frankfurt / in Singapore, in ms:

| | beside the host | Frankfurt | Singapore |
|---|---|---|---|
| today, guard Toronto, exit Frankfurt (KVM Box circuit 1) | 345 | 185 | 339 |
| today, guard San Francisco, exit Singapore (circuit 2) | 386 | 354 | 200 |
| near routes, guard San Francisco, exit Toronto | 185 | 200 | 349 |

- It is host-wide: the seven apps on the box all get the same two circuits, and all their names list Toronto alone.
  A failure of the Toronto or the San Francisco provider takes every listed circuit until the standby is listed
  (one to two minutes), where today each name lists two exits.
- It is worse for a visitor in Asia than today's better circuit.
- 185 ms is a sum of measurements, not a measurement of a circuit. `check` shows `host to guard` / `host to exit`
  per circuit and what the KVM Box name lists.
- The measurement is a contact from the host's own address to every ingress provider, which nothing else in the
  agent makes. That is why the setting is the operator's.
- The stream's lag came from the circuit's one TCP connection queuing video under loss. A shorter path loses less and
  recovers faster; it does not bound the queue.

## Why not one hop through San Francisco (≈55–60 ms)

Asked 2026-11-15: host → us-west ← viewer. The network does not build that. A circuit is host → guard → exit through
two different providers (`selectNetworkCircuits` in `network/wg-manager.mjs`; the policy accepts only `guard: true`,
`network/network-policy-core.mjs`), the guard forwards only to other providers, and a name lists exits only. The
reason is the table in `docs/design/enclave-network.md`: the guard sees the host's address and only ciphertext, the
exit sees the visitors and never the host. One provider in both places sees both. A one-hop mode would be a new,
owner-signed and operator-opted choice (policy, providers, host agent, relay records, the Network tab); it is not in
this release.

# GameStream gateway on the four edges (2026-11-14)

Status at 07:30Z:

- **On the edges now:** the first gateway bundle (sha256 `982463a2…85f5af`), installed and verified on all four
  edges at 06:37:41-06:38:34Z by the operator's `run.sh activate` (evidence in `activation/`). The run was activate,
  then a revert, then activate again; the evidence is from the last one.
- **What that gives:** Moonlight with the PC added as `9a28642b.app.enclave.host` lists and streams the KVM Box
  desktop with a picture, as long as all of one client's connections reach the same edge.
- **What it does not give:** the name has two addresses (us-west, eu-central) and each edge keeps its own bindings. A
  client whose HTTP goes to one edge and whose RTSP or UDP goes to the other gets nothing. This was measured, below.
- **Prepared here, on no edge:** a second bundle (sha256 `2387eb9d…f50e98`, pinned in `plan.json`) in which the
  edges ask each other for a client's binding. `run.sh activate` replaces the gateway on each edge with it. That run
  is the operator's.

## Why

The KVM Box page tells a user to add PC `127.0.0.2` in Moonlight, which needs the local connector. The public form is
the app's own name (`9a28642b.app.enclave.host`), which needs an edge to listen on Sunshine's six ports and carry them
through the app's 443 port tunnel (`docs/network/gamestream-ingress.md`).

Main has that gateway as a field of the provider (`"gameStream": true`). The edges do not run main's provider: three
run `native-recovery-464cad3/provider.mjs`, ca-east runs `hs-transport-39d1513b/wg-provider.mjs`. Replacing the
provider on all four to turn on one port forwarder would be a provider release with its own risks. So this uses the
service form: a process of its own beside the provider, which reaches apps through the provider's own 443 router on
the box and does not read or change the provider.

## What each edge gets

- `/opt/enclave-gamestream-gateway/gamestream-gateway.mjs`, the bundle `plan.json` pins by sha256
- `/etc/enclave-gamestream-gateway/config.json`: the zone `app.enclave.host`, the edge's public address, the router
  `127.0.0.1`, caps of 256 flows, 32 per client, 4096 bindings, and (second bundle) `siblings`: the other three
  edges' addresses
- `/etc/enclave-gamestream-gateway/siblings` (second bundle): the sibling rules the installer added, so it can take
  exactly those out again
- `enclave-gamestream-gateway.service`: a dynamic user, no key, no state, at most 192 MB and 60% of a CPU
- ufw: `47984/tcp 47989/tcp 48010/tcp 47998:48000/udp` from anywhere, and (second bundle) TCP 47997 on the edge's
  address from each of the three sibling addresses only

Nothing else. `run.sh activate` stops if the provider's main PID or start time changed across the install.

## The second bundle: edges ask each other

A request that names the app binds the client's address on the edge that received it. With the second bundle, an
edge that gets a nameless flow (RTSP, or HTTP(S) under a bare address) from a client it has not heard a name from in
the last five seconds asks its siblings on TCP 47997 `enclave-gs-binding/1 <client address>` and takes the most
recently named answer. One question per client at a time, one second at most, a silent sibling is skipped for 30
seconds. UDP never asks: it follows what RTSP from the same client settled.

Who may ask is decided by the source address of an established TCP connection, and by the ufw rule in front of it.
That is only sound between boxes of one operator. What a sibling, or someone on the path between two edges, could do
with it: point a client's nameless flows at another app under the zone. That app's Sunshine does not know the client,
so the stream fails; nothing is exposed. It cannot make an edge open a flow to anything outside the zone.

## Running it

    bash ops/gamestream-gateway-20261114/run.sh activate

Order: ca-east, ap-southeast (neither holds the KVM Box route today), then us-west, eu-central (the two addresses the
app's name resolves to). One edge at a time; the first failure stops the run. An edge is skipped only if its
`verified.json` names the planned bundle and the same siblings, so today's run replaces all four.

After the last edge the run does two more things and writes them to `activation/final.txt`:

- `links`: over ssh, each edge asks each sibling about a documentation address (192.0.2.1) from its own address. All
  twelve must answer.
- `check`: from this machine, without ssh. Per edge: no name gives nothing, the TCP ports connect, the sibling port
  gives a stranger nothing. Then for every pair (A, B) where B routes the app: a name that does not exist is given to
  B (so B's own binding is useless), the app is named at A, and a nameless `/serverinfo` at B must return Sunshine's
  answer. That is the proof that B took the name from A.

If that fails the gateways stay installed (each was verified on its own) and the run says so.

Other commands: `preflight`, `status`, `check`, `links` (read-only), `revert [edge...]` (removes everything from the
named edges, or all).

The named checks need the KVM Box desktop started.

During the run the edges are mixed for about a minute. An updated edge asking one that is not updated yet gets no
answer (the port is closed there), which costs at most one second per 30 on a nameless flow and otherwise behaves as
today.

If an update fails on an edge (the new service does not come up listening), the installer removes the gateway from
that edge, including the one that ran before, and the run stops there. Re-running `activate` installs it again.

## What has been checked

| When (Z) | What | Result |
| --- | --- | --- |
| 06:29 | `preflight`, four edges | address on the box, Node 22, provider active, ufw active, six ports free, 247-359 MB available |
| 06:37-06:38 | `activate` (first bundle), four edges | installed, listening, verified; providers untouched (`activation/*.verified.json`) |
| 06:44 | `check` (as it then was) from a workstation | passed on all four |
| 06:48 | `moonlight list 9a28642b.app.enclave.host` (moonlight-qt 6.2.0, paired by name) | `KVM Box Desktop` |
| 06:51-06:58 | five streams by name, 1280x720 at 30 fps | video 19-30 fps, 0-2.07% frames dropped by the network, audio; a screenshot shows the KVM Box desktop. All five went through us-west |
| 06:58 | which address resolvers put first, 12 lookups each | 8.8.8.8: us-west 4, eu-central 8. 1.1.1.1: 10 and 2. 9.9.9.9: 4 and 6 (two failed). The order is not stable |
| 06:58:25 | after naming the app at us-west only: nameless `/serverinfo` at each address | us-west 200; eu-central closed, nothing sent |
| ≈07:20 | TCP and UDP 47997 on the four edges; ufw rules naming it | free; none |
| 07:22 | `rehearse.sh` with the second bundle (`rehearsal-20261114.txt`) | passed: two boxes on 127.0.0.5 and 127.0.0.6, activate, status, check, links, the sibling port asked by hand (sibling answered, stranger not), skipped re-activate, an update over a running gateway, revert, nothing left |
| 07:22-07:23 | the new `check` against the edges as they are (first bundle) | each edge passes on its own; all six pairs "NOT carried". Expected: it is the fault the second bundle is for, and it shows the check sees it |
| 07:25 | tests: `test/wg-provider-gamestream*.test.mjs`, `test/service-index.test.mjs` | 36 of 36 pass |
| 07:29 | `preflight` as it now is, four edges (written outside `activation/`) | ready on all four: gateway active, sibling port free, 282-319 MB available |

## What is not known until the second bundle runs on the edges

- Whether the edges reach each other on TCP 47997 from their public addresses (a cloud firewall or routing between
  droplets is not ufw). `links` answers this.
- Whether real ufw accepts and orders the `from <sibling>` rules as the stand-in did.
- Whether a client is carried across two real edges. `check` answers this for HTTP; a Moonlight stream forced
  through two edges has not been run.
- UDP is not carried across edges by itself: it follows the binding RTSP settled on the same edge. A client whose
  RTSP goes to one address and UDP to the other would still fail. Moonlight takes the UDP address from the RTSP
  session, so this is not expected, and it has not been observed either way.

## After

- The KVM Box page keeps saying `127.0.0.2` until its own release (enclave-apps branch
  `kvm-box/page-moonlight-public-20261114`, a signed desktop release, owner signatures, a host switch). That release
  must not go out before `activation/final.txt` shows the pairs carried.
- Seen while reading the edges' journals, not caused by this work: Ubuntu's unattended upgrades restarted
  `enclave-network-provider` on three edges between 06:06Z and 06:38Z (ap-southeast 06:06:02Z, us-west 06:12:10Z,
  eu-central 06:37:22-27Z).

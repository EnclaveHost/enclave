# GameStream gateway on the four edges (2026-11-14)

Status at 08:00Z:

- **On the edges now:** the second gateway bundle (sha256 `2387eb9d…f50e98`), in which the edges ask each other for
  a client's binding. Installed and verified on all four edges at 07:46:07-07:47:26Z by the operator's
  `run.sh activate` (evidence in `activation/`). The first bundle (`982463a2…85f5af`) ran from 06:38Z until then; its
  evidence is in this directory's history (commit `aa863409f`).
- **What that gives:** Moonlight with the PC added as `9a28642b.app.enclave.host` lists and streams the KVM Box
  desktop with a picture. A client that names the app at one edge and comes without a name to another is carried:
  shown from outside for all six pairs of edges at 07:50-07:51Z (`activation/check-0750Z.txt`).
- **Not shown:** a Moonlight stream whose own connections were split across two edges. The workstation this was
  tested from always sorts us-west first, so its streams never split.
- **Not done:** the KVM Box page still says `127.0.0.2`. That is the page's own release.

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
`verified.json` names the planned bundle and the same siblings.

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
| 07:45-07:47 | `activate` (second bundle), four edges | each replaced, listening on seven ports, sibling rules in ufw for the three other addresses, providers untouched (`activation/*.verified.json`) |
| 07:47 | `links`, part of that run (`activation/final.txt`) | all twelve edge-to-edge questions answered |
| 07:47 | `check`, part of that run (`activation/final.txt`) | **stopped at ap-southeast with "47989 timed out"; the pairs were not tried.** A fault of the check, not of the edge: see below |
| 07:50-07:51 | `check` after its fix (`activation/check-0750Z.txt`) | every edge passes; all six pairs carried (200 from Sunshine at the edge that was given no name) |
| 07:52 | `links` and `status` again | twelve answered; four edges active with the second bundle, 47997 listening, three sibling rules each |
| 07:53 | RTSP port: app named at us-west only, then a nameless connection to 48010 at each | us-west and eu-central behave alike (the tunnel opens, Sunshine closes an RTSP request without a session, no gateway error); with a name that has no app eu-central logs the failed tunnel instead |
| 07:53 | `moonlight list` by name | `KVM Box Desktop` |
| 07:53-07:54 | one Moonlight stream by name, 1280x720 at 30 fps | RTSP handshake, first video packet after 600 ms, audio; ended by the test after 38 s, session quit, Sunshine free |

## The check's false stop at 07:47Z

The activation's own final check reported `ap-southeast: 47989 timed out` and stopped before the pairs. What
happened: the workstation had just named the app at us-west (the activation's named probe). ap-southeast, asked
without a name, took that name from us-west, as designed, and tried the app through its own router. ap-southeast
does not route this app, and its provider holds such a connection for ten seconds before closing it (ca-east's
closes at once). The check waited exactly ten seconds, so it saw a timeout where a second later it would have seen
the close. `run.sh` now waits twenty. Nothing on the edges was changed for this.

It also shows something about the edges: on a provider release like ap-southeast's, a client that named an app at
one edge and reaches an edge that does not route it waits ten seconds for the close. DNS only hands out the edges
that do route an app, so a real client does not get there.

## What is still not known

- A Moonlight stream split across two edges by its own lookups. HTTP and the RTSP connection were shown separately
  from outside; a whole stream was not. A client on Windows, macOS or Android may order the two addresses
  differently from this workstation.
- UDP is not carried across edges by itself: it follows the binding RTSP settled on the same edge. A client whose
  RTSP goes to one address and UDP to the other would still fail. Moonlight takes the UDP address from the RTSP
  session, so this is not expected, and it has not been observed either way.
- Why two early pairing tries answered "Incorrect PIN".

## After

- The KVM Box page keeps saying `127.0.0.2` until its own release (enclave-apps branch
  `kvm-box/page-moonlight-public-20261114`, a signed desktop release, owner signatures, a host switch). That release
  was waiting for the pairs to be carried, which `activation/check-0750Z.txt` now shows.
- Seen while reading the edges' journals, not caused by this work: Ubuntu's unattended upgrades restarted
  `enclave-network-provider` on three edges between 06:06Z and 06:38Z (ap-southeast 06:06:02Z, us-west 06:12:10Z,
  eu-central 06:37:22-27Z).

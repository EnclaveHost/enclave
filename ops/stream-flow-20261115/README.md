# Live datagrams over a path that loses packets: port-tunnel flows (2026-11-15)

The owner's report, after the KVM Box was moved to one hop through us-west (`ops/one-hop-20261115/`): the Moonlight
stream "still lags", "keeping a buffer of frames that gets jammed up". RISC Box, with fewer resources, streams
smoothly. The instruction: at least RISC Box's performance, whatever it takes to build.

This folder is the record of what was found, what was built for it, and what a simulation of the path measured.
Installing it (the gateway on the four edges, a desktop image with the new front on the NucBox) is recorded in
"Activation" below as it happens.

## What was found

- After the owner's stream on the one-hop circuit (read 2026-11-15 11:49Z from the NucBox's
  `network/state/status.json`): 40,510,989 bytes up, 57,093 segments, 562 retransmitted (0.98%), 4 timeouts. The other
  apps on the box, through the same provider, retransmit 0.1-0.2%.
- The stream's path (`docs/network/gamestream-ingress.md`): Sunshine's UDP → the measured front in the guest
  (`isolation/m2/front/tunnel.go`), which frames each datagram onto one TLS connection → the host's tunnel stack
  (gVisor, `network/wg`) → the provider → the edge's gateway (`network/wg-provider/gamestream.mjs`), which makes
  datagrams of the frames again → Moonlight. One TCP connection per UDP port, and neither end knows how far behind
  the other is.
- That is enough to explain the report, and the simulation below reproduces it: with 1% loss on a 25 ms round trip
  the tunnel stack's one connection carries about half of a 5 Mbit/s video, the rest queues, and the picture is 7 s
  behind after 30 s.
- RISC Box's own remedy for the same jam (`risc-box/gs-bridge/src/screen.rs` in enclave-apps): its bridge pulls,
  "what changed since my last reply", so no more than one reply is ever on its way, and the app sends a fresh full
  picture when the screen outruns the link. It encodes for Moonlight on the viewer's machine, which a stock Moonlight
  on the public path cannot do. And the RISC Box the owner compares with is reached over an SSH tunnel on the LAN
  overlay (about 11 ms), not through the Enclave network.
- The NucBox's own line is part of it and is not explained yet: 1,500 pings of 1,300 bytes from the NucBox to
  us-west lost 74 (4.9%), where the same from the workstation, on the same LAN, a few minutes later lost 5 (0.3%)
  (2026-11-15, about 12:05-12:10Z). The NucBox's route is its wired card (Intel I226-V, driver of 2022, no error or
  discard counted); Wi-Fi is disconnected. Not measured at the same moment, and not followed further yet.

## What was built

A **flow**: a UDP port tunnel whose two ends report what they received, over several connections. The protocol and
the reasons are in `isolation/m2/front/tunnel_flow.go`; `isolation/m4/PROTECTED-PORTS.md` has the wire format.

| | the app's front (`tunnel_flow.go`) | the edge's gateway (`port-flow.mjs`, `gamestream.mjs`) |
|---|---|---|
| lanes | up to 16 connections of one flow share one UDP socket to the app | opens 16 for video, 4 each for control and audio; opens another when one ends |
| reports | sends each datagram on the lane least behind its usual delay | tells each lane's count as it receives |
| parity | every 4 data frames (or 4 ms) one XOR frame, on a lane that carried none of them | makes a missing datagram from its group at once |
| second copy | what a lane that is behind and silent still holds goes out again elsewhere, at most a quarter of what is sent | delivers in sequence and once; waits for a missing datagram about as long as the front says a copy takes |
| late | drops a datagram when every lane is more than 100 ms behind | |
| dead lane | closes a lane silent for 1 s with frames on it | |
| input | reports what it received from the client on each lane | keeps the client's datagrams off a lane that is behind |

A front without flows ignores the request header (or refuses it and is asked again without): the plain tunnel. A
client without flows does not send the header. Nothing in it knows GameStream.

Compared with RISC Box's pull: the same bound on how far behind the picture can be, without a bridge on the viewer's
machine; and where RISC Box's one connection still waits out every lost packet, here the datagram behind it goes
around.

## What the simulation measured

`sim/`: the real `tunnel.go` and `tunnel_flow.go` behind a tunnel stack tuned as `network/wg/tune.go` does, a link
with delay and loss, a second stack and a relay (the provider's router), the real `gamestream.mjs` in front, and a
receiver that applies Moonlight's rule (a frame not whole when a later frame's packet arrives is given up). The
source sends 60 frames a second of 1,392-byte packets, one in six of them parity, a key frame of eight times the size
every ten seconds. `sim/results-20261115.txt` is the run below (30 s each; the path is 12.5 ms each way, 1% lost
towards the edge and 0.3% back, 5 Mbit/s, unless the row says otherwise). Delays are from when the frame was made,
in ms.

| case | datagram delay p50 / p95 / p99 | frames shown / missing | dropped by the front |
|---|---|---|---|
| plain tunnel (today) | 6,752 / 13,720 / 14,400 | 861 / 452 | none: it queues |
| flow, 1 lane | 120 / 318 / 380 | 790 / 986 | 55% |
| flow, 4 lanes | 22 / 82 / 161 | 1,753 / 39 | 0 |
| flow, 8 lanes | 13 / 21 / 46 | 1,793 / 0 | 0 |
| **flow, 16 lanes** | **13 / 14 / 40** | **1,793 / 0** | **0** |
| 16 lanes, no parity | 13 / 46 / 56 | 1,793 / 0 | 0 |
| 16 lanes, no loss | 13 / 14 / 15 | 1,793 / 0 | 0 |
| 16 lanes, 2% loss | 13 / 30 / 47 | 1,793 / 0 | 0 |
| 16 lanes, 3% loss (1% back) | 14 / 41 / 53 | 1,787 / 4 | 0 |
| 16 lanes, 5% loss (2% back) | 40 / 562 / 879 | 1,234 / 537 | 13% |
| 16 lanes, losses in threes | 13 / 30 / 52 | 1,793 / 0 | 0 |
| 16 lanes, the path dead 0.4 s every 10 s | 13 / 24 / 86 | 1,739 / 54 | 2.5% |
| 16 lanes, 12 Mbit/s | 14 / 30 / 47 | 1,790 / 3 | 0 |
| 16 lanes, 20 Mbit/s | 29 / 57 / 91 | 1,779 / 14 | 0 |
| 16 lanes, 30 Mbit/s | 461 / 1,711 / 2,143 | 211 / 1,572 | 13% |
| 16 lanes, 40 ms each way | 41 / 102 / 136 | 1,774 / 5 | 0 |
| 16 lanes, 80 ms each way | 548 / 5,355 / 8,204 | 494 / 1,254 | 25% |
| plain tunnel, 80 ms each way | 12,679 / 23,780 / 25,637 | 165 / 0 | none: it queues |

## Limits

- It is a simulation. The loss is independent per packet (and in threes in one row); the far stack is gVisor's too,
  where the edge's is Linux; there is no Moonlight, Sunshine, WireGuard or Windows in it. A real stream through an
  installed gateway and image has not been measured.
- Beyond what the lanes' TCP can carry it falls behind as well: 5% loss, 30 Mbit/s at 1%, or a long path (80 ms each
  way, where the tunnel stack times out 160 times in 30 s with 1% loss; that is the stack on a long path, which the
  plain tunnel shows too, and it is not addressed here). The KVM Box's path is the short one: with near routes and
  one hop its only TCP leg is NucBox to us-west, about 25 ms.
- Parity and second copies add a quarter to a half to the bytes on the path.
- The datagrams from the client (input) are kept off a lane that is behind but are not covered by parity or sent
  again; Sunshine's control channel retransmits its own.
- Nothing asks Sunshine for a key frame or drops a whole frame: Moonlight's own requests do that when the front
  drops.
- The local connector (`isolation/m2/client.mjs`) and the KVM Box's own owner-gated tunnel do not use flows.

## Activation

**1. The four edges, 2026-11-15 13:38-13:40Z** (`edges.sh activate`, run from the assistant's session on the owner's
instruction to run the installs). It is the 2026-11-14 gateway activation with this checkout's bundle
(`bundle.sha256`, 85675750…3738, built from main `3c4de3758`): on each edge the gateway's service was replaced and
restarted, the provider was not touched (same process and start time before and after on all four).

| edge | verified | named probe |
|---|---|---|
| ca-east | 13:38:45Z | KVM Box server info 200 |
| ap-southeast | 13:39:07Z | not routed there |
| us-west | 13:39:20Z | KVM Box server info 200 |
| eu-central | 13:39:43Z | not routed there |

Afterwards, together: twelve of twelve edge-to-edge questions answered, and a client that names the app at one edge
is carried at another for the six pairs that can be tried. Sunshine answered "busy" at 13:39:52Z: a stream was open
when the gateways restarted, and it will have dropped. The evidence files name the edges' addresses and stay outside
the repository.

What this changes today: nothing a viewer can see. The desktop that runs (SVN21) has a front from before flows, so
the new gateways get plain tunnels from it. That a plain tunnel still carries UDP through the new gateway was not
exercised (it needs a Moonlight stream); the TCP ports were.

**2. The desktop image with the new front, SVN22, on the NucBox since 2026-11-15 14:20Z.**

Built in `…/2026-10-23/it/work/native-flow-image-v18/`, exported to
`…/2026-10-23/it/outputs/kvm-box/native-platform-v18-stream-flow/`:

| | |
|---|---|
| platform source | the SVN21 tree with `m2/front/tunnel.go`, `tunnel_flow.go` and its test as in main `3c4de3758` (local commit `3b0679ad8`; three sources differ from SVN21's inventory, `source-diff.json`) |
| platform archive | one entry differs from SVN21: `plat/front`, 9,478,268 → 9,506,940 bytes; rebuilt from a fresh compiler cache to the same archive (7667d9db…a496) |
| root image, profile, controller, models | SVN21's bytes |
| signed image | `native-igvm.bin`, 86,637,572 bytes, 5022c649a295aa10ac4708eea601a771ce81d8f4eb399955335314eed56b6d4b, guest SVN 22, launch measurement a367f079…2613 (computed, not read from hardware); signature verified by the independent implementation |
| desktop app identity | unchanged, a6072ed0…e1b5: it comes from the profile and the controller |
| Shield policy | d202746f943486a7239f5180a0811dd35fbaab35fa11c1fbdf56f8e756349e62 (SVN21's: 2d245e65…0540) |

No owner signature: the controller and the catalog version are SVN21's. The front's change was not exercised in a
booted guest before this (the isolated KVM run is of the root image and does not start the front).

Activation, from the assistant's session on the owner's instruction (`desktop-svn22.sh` beside the earlier releases'
scripts in `ops/unified-funding-20261028/funding-reactivation-20261111/queued-apps-20261113/`):

| when (Z) | step | result |
|---|---|---|
| 13:46 | `stage` | files on the NucBox, verified there; nothing running changed |
| 13:54:29 | `policy` | relay admits SVN22, restarted (the previous file is kept beside it) |
| 13:54:44 | `hostpolicy` | host policy SVN22, network agent restarted. **KVM Box down from here.** The other apps' names did not answer for about two minutes |
| 13:58:23-14:09:11 | `switch` | Shield manager on SVN22, seven app VMs back and settled by 14:05:39; Node restarted 14:06:24, listed, settled |
| 14:11:39 | `retry` (timed) | claimed; the launch failed as SVN20's first did ("not ready within 120000 ms", the same 463-byte console), released 14:14:40 |
| 14:18:28 | `retry` (at once) | claimed; desktop VM running 14:20:03; the public name answered 401 from 14:21:57 |

KVM Box was down 27 minutes. The one-hop check passes again (both circuits without a guard, exit sfo3 and tor1).

Read on the running desktop, 14:27:58Z, through its public name (`flowprobe.mjs` here,
which opens tunnels to UDP 47999 as the gateway does): a plain tunnel is answered without the flow header; sixteen
lanes of one flow are each answered 101 with `Enclave-Port-Flow: 1`; a seventeenth is refused (503); a flow on a TCP
port is refused (400); a report is taken and the lanes stay open. **So the front with flows runs in production. No
datagram has been through a flow there yet: that needs a Moonlight stream.**

Seen during and after the switch and not explained: the agent withdrew every app's network for about a minute at
14:21:58Z, 14:23:13Z and 14:30:58Z ("authorization lapsed (lease or guest proof)"). The same line has been written
all day for two other apps (`0xd9798e4c`, `0x7ae476a3`, every few minutes since before 05:00Z), not for the KVM Box,
whose only lapse between 10:00Z and 13:54Z was at 13:52:05Z for 30 s.

**3. The gateway again, with one log line per ended flow** (what a stream's video, control and audio each met:
delivered, rebuilt from parity, late, passed over, second copies, lanes opened): bundle 2abac82b…fc72, on the four
edges 2026-11-15 14:32-14:34Z, each verified. The run's last check stopped ("serverinfo on 47989 gave HTTP 000"): the
new desktop VM's desktop had not been started from the app's page, so Sunshine was not there to answer. Starting it
needs the owner's sign-in, which the assistant does not enter.

**What the withdrawals of 14:21Z-14:37Z were** is in `ops/policy-check-20261115/`: the agent's refresh rounds had
been slow since the owner's signature of 11:35Z (a signature check that reads the chain, five times a round), and the
switch pushed them past the leases' freshness. Fixed in main and on the NucBox at 20:02Z.

**Where it stands, 20:10Z.** Edges and desktop carry flows; no stream has been through one. The KVM Box's name lists
Toronto (one one-hop circuit; us-west refuses its request at the moment, see the same folder), so a stream now would
have an 85 ms leg where 25 ms is intended. To measure a stream: the owner starts the desktop on the app's page, pairs
Moonlight again (a new desktop VM has no paired clients), streams; then the edge's journal has one "flow ended" line
per UDP port, and the NucBox's `status.json` the circuit's TCP counters.

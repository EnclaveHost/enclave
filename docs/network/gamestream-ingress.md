# Public GameStream ingress on a provider

Status at 2026-11-14 08:00Z. The code is in `network/wg-provider/gamestream.mjs`. It has two forms: a field of a
provider that runs this source (`"gameStream": true`), installed on no provider; and a service of its own beside a
provider that runs another release ("Beside a provider that runs another release" below).

Enclave's four edges run older provider releases, so they got the service form, with each edge asking the others
for a client's binding ("Siblings"): on all four since 2026-11-14 07:47Z (`ops/gamestream-gateway-20261114/`).
Through it a stock Moonlight, with the PC added as `9a28642b.app.enclave.host`, lists and streams the KVM Box
desktop with a picture, and a client that names the app at one edge is served at another ("By name through the
edges"). The KVM Box page still names the local connector's `127.0.0.2`.

## What it is for

A desktop app (KVM Box) runs Sunshine inside its guest. The guest's front already serves Sunshine's ports to anyone
under the app's public name, as port tunnels on 443 (`isolation/m4/PROTECTED-PORTS.md`:
`/.well-known/enclave-tunnel/{tcp|udp}/{port}`, upgrade `enclave-port/1`). A stock Moonlight cannot speak that tunnel,
so until now it needed the local connector and the PC was added as a loopback address.

With `"gameStream": true` in `provider.json`, a provider listens on Sunshine's own ports on its public address and
carries each flow through that tunnel. The PC added in Moonlight is then the app's own name
(`<id>.app.<zone>`), which resolves to the providers' public addresses.

| Port | Use | How the app is chosen |
| --- | --- | --- |
| TCP 47989 | HTTP: server info, pairing | `Host` header |
| TCP 47984 | HTTPS: app list, launch | TLS SNI |
| TCP 48010 | RTSP | the client's binding |
| UDP 47998, 47999, 48000 | video, control, audio | the client's binding |

## How one address serves many apps

GameStream's ports are fixed and RTSP and UDP carry no name. So:

- A request on 47989 or 47984 whose name is an app a peer of this provider holds **binds** the client's source address
  to that app.
- RTSP, UDP, and requests without such a name (an address in `Host`, no SNI) follow the client's binding.
- No name and no binding: the connection is closed, the datagram dropped. Nothing is opened toward any app.
- A name no peer holds is never bound. Neither is a name served on the provider itself (`localRoutes`).
- A binding lasts ten minutes after the client's last flow; an open flow holds it for as long as it lasts.
- Caps: 4096 flows, 64 per client address, 16384 bindings.

A bare IP address therefore cannot select an app: there is one address for every app on the provider. The name is the
public address a user adds.

## What it does and does not grant

- Nothing new is reachable. The gateway opens the same tunnel any internet client can open on 443, to ports the app's
  measured image declares. The front refuses everything else.
- There is no owner check on this path, as there is none on the tunnel. Sunshine's pairing PIN (entered on the app's
  owner page) and its mandatory stream encryption are what protect a session.
- The provider ends the tunnel's TLS, so it sees the GameStream bytes as any network hop of an ordinary Sunshine
  would: Sunshine's own encryption, not the app's TLS, is what covers them. A client that wants the attested path
  uses the local connector instead.
- Traffic is metered against the peer like routed 443 traffic.

## Limits

- Two clients behind one source address that stream different apps through one provider share a binding; the later
  name wins for new flows.
- Bindings are per provider. An app name that resolves to several providers works only while a client keeps to one
  address, and clients do not: Moonlight resolves the name again for its stream, and public resolvers rotate the
  order of the addresses. The service form closes this between boxes of one operator ("Siblings"). The field form
  does not ask anybody yet, and nothing covers a name served by providers of different operators.
- UDP follows the binding that the same client's RTSP settled on the same box. A client that sent RTSP to one
  address and UDP to another would not be carried. Moonlight takes both from one resolution; not observed either way.
- Video and audio ride TCP inside TLS between the provider and the app's front: loss causes head-of-line delay.
- A host on Enclave Direct has no provider in front of it and would need the same listener itself. Not built.

## Turning it on

Set `"gameStream": true` in `/etc/enclave-network/provider.json` and run `install.sh` with a release that contains the
gateway. `install.sh` keeps the field across updates and opens `47984/tcp 47989/tcp 48010/tcp 47998:48000/udp` in ufw.
`node wg-provider.mjs --check-config` prints `"gameStream": true|false` and rejects a value that is not a boolean.

## Beside a provider that runs another release

`network/wg-provider/gamestream-gateway.mjs` is the same gateway as a service of its own
(`enclave-gamestream-gateway.service`). It does not read or change the provider: for each flow it opens TLS to the
provider's own 443 router on the box (`router`, 127.0.0.1) under the app's name, and that router forwards it to the
peer holding the name as it forwards any internet client. It holds no key and no state, and the app's public
certificate must verify.

What differs from the field form:

- It cannot ask the provider which names a peer holds. It binds a name that is **one label under a configured zone**
  (`<id>.app.enclave.host` for the zone `app.enclave.host`). A name under the zone that no peer holds still binds the
  client that sent it; that client's flows then end at the router, and no other client is affected. The field form
  never binds such a name, so a provider on this source should use the field.
- Bytes are metered by the router as routed 443 traffic from 127.0.0.1, not by the gateway.
- Defaults are smaller: 256 flows, 32 per client address, 4096 bindings. Log lines are capped at 30 a minute.

Configuration (`/etc/enclave-gamestream-gateway/config.json`; unknown fields are rejected):

| Field | Meaning |
| --- | --- |
| `zones` | 1 to 8 DNS zones whose one-label names may be bound |
| `host` | the IPv4 address to listen on (the box's public address) |
| `router` | where the provider's 443 router answers; default `127.0.0.1` |
| `maxFlows`, `maxPerClient`, `maxBindings` | caps, defaults above |
| `siblings` | up to 8 IPv4 addresses: the other boxes of the same operator that serve the zones; default none |
| `siblingPort` | the TCP port siblings ask each other on; default 47997 |

### Siblings

A request that names an app binds the client's address on the box that received it. With `siblings` set, a box that
gets a nameless TCP flow (RTSP, or HTTP(S) under a bare address) asks the others before it decides:

- It asks unless a name set the client's binding on this box within the last 5 seconds, or it asked within the last
  5 seconds (1 second after an empty answer). One question per client at a time, at most 64 clients being asked about.
- The question is one line on `siblingPort`, from the box's own `host` address: `enclave-gs-binding/1 <client>`. The
  answer is `<name> <ms since a name set it>` or `-`. All siblings are asked at once with one second to answer; a
  sibling that fails is left out for 30 seconds. Without an answer the box decides from what it has.
- The most recently named binding wins, here or there. A name heard from a sibling is taken only if it is under this
  box's own zones.
- UDP never asks; a stream's RTSP comes first and has asked.

Trust: a box answers only connections that come from a sibling's address, and the installer opens the port to those
addresses alone. The source address of an established TCP connection is the whole authentication, so `siblings` must
be boxes of one operator. A sibling, or someone on the path between two of them, can at most point a client's
nameless flows at another app under the zones. That app's Sunshine does not know the client: its stream fails and
nothing is exposed. A box tells a sibling nothing but the name a client address last gave.

Build and install:

- `node scripts/network/build-gamestream-gateway.mjs <dir>` writes the one-file bundle and prints its sha256. The
  build is reproducible; the installer holds the bundle to the sha256 it is given.
- `network/wg-provider/gamestream-gateway-install.sh install <bundle> <sha256> <config.json>`, as root on the box,
  checks the configuration with the bundle, requires the listen address on the box and the six ports free, installs
  the service (a dynamic user, read-only system, 192 MB and 60% of a CPU at most), opens
  `47984/tcp 47989/tcp 48010/tcp 47998:48000/udp` in ufw and starts it. With `siblings` it also requires the sibling
  port free, opens it to each sibling's address alone, and records those rules in
  `/etc/enclave-gamestream-gateway/siblings` so that the next install or `remove` takes out exactly them. A service
  that does not come up listening is removed again. `status` is read-only; `remove` takes out the service, its files
  and the rules.
- Installing over a running gateway replaces it. If the new one does not come up, the box is left with none (the
  previous one is not put back); install again.
- Do not run both forms on one box: they want the same ports, and `remove` deletes the rules the field form needs.

Tried on 2026-11-14 (between 06:10Z and 06:29Z) with the built bundle on a workstation loopback address and one production edge as
`router`: `/serverinfo` under the app's name 200; a bare-address request after it 200 (binding); a name outside the
zone, and no binding, closed with nothing sent; a zone name no peer holds closed, one log line; TLS on 47984 with the
app's name as SNI reached Sunshine's own certificate. Not tried: the service under systemd's sandbox on a real box
(the unit passes `systemd-analyze verify`), and everything listed as not established below.

## What was tried (2026-11-14, 05:45-06:03Z)

The gateway code ran on a workstation (loopback address, real ports) with one production edge as the tunnel hop and
the KVM Box desktop on the NucBox as the app:

- 47989 `/serverinfo` with the app's name: 200, binding made. RTSP before any binding: closed.
- 47984: TLS 1.3 end to end with Sunshine's certificate.
- moonlight-qt 6.2.0 paired (PIN entered on the app's page) and listed `KVM Box Desktop`.
- Three stream runs at 1280x720, 30 fps: launch, RTSP handshake, encrypted video, control and audio over UDP at about
  1.35 Mbit/s; datagrams reached the client side of the gateway about every 2.5 ms with a longest steady gap of
  28-37 ms.

Not established: a picture on screen (the client, started from a shell without a usable window, logged decode queue
overflows in every run); behaviour with a name that resolves to more than one provider; a Moonlight client that added
the PC by name (the trial added it by address, so its 47984 requests followed the binding; SNI with the name was
later shown with a plain TLS client, above).

## By name through the edges (2026-11-14, 06:44-07:23Z)

With the first bundle (no siblings) on the four edges, from a workstation, moonlight-qt 6.2.0 paired with the PC added
as `9a28642b.app.enclave.host`:

- `moonlight list`: `KVM Box Desktop`.
- Five streams at 1280x720, 30 fps: video at 19-30 fps, 0-2.07% of frames dropped by the network, audio. A screenshot
  of the client window shows the KVM Box desktop. All five ran through us-west.
- Which of the name's two addresses a resolver puts first, 12 lookups each: 8.8.8.8 us-west 4, eu-central 8; 1.1.1.1
  10 and 2; 9.9.9.9 4 and 6.
- After naming the app at us-west only, a nameless `/serverinfo`: us-west 200, eu-central closed.
- The activation's outside check, in the form that goes with the second bundle, run against the first: every edge
  passes on its own, and none of the six pairs (named at one edge, nameless at another that routes the app) is
  carried.

With the second bundle (siblings) on the four edges, 07:47-07:54Z:

- All twelve edge-to-edge questions on TCP 47997 answered; the port gives a machine that is no sibling nothing.
- For each of the six pairs: a name without an app given to edge B, the app named at edge A, then a nameless
  `/serverinfo` at B: 200 from Sunshine. B took the name from A.
- App named at us-west only, then a nameless connection to the RTSP port at eu-central: the tunnel opened as it does
  at us-west.
- `moonlight list` and one stream by name: as before.
- An edge that takes a name from a sibling but does not route the app closes the flow only when its router gives up:
  at once on ca-east's provider release, after ten seconds on ap-southeast's.

Not established: a Moonlight stream whose own connections were split across two edges (the test workstation always
orders the two addresses the same way); why two early pairing tries answered "Incorrect PIN".

## Tests

`node --test test/wg-provider-gamestream.test.mjs` and the config test in `test/service-index.test.mjs`. The service
form: `test/wg-provider-gamestream-gateway.test.mjs` (names, configuration, flows through a stand-in router, the entry)
and `test/wg-provider-gamestream-gateway-install.test.mjs` (the installer against a staging root with stand-in
`systemctl`, `ufw`, `ss` and `ip`: refusals change nothing, install and remove are exact, a gateway that does not come
up is removed, sibling rules are opened, replaced and removed with the install). Asking: the core's rules for when to
ask and whose binding wins are in the first file; two gateways that are siblings of each other, a stand-in router and
a client that names the app at one and sends a nameless request to the other are in the second.

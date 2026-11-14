# Public GameStream ingress on a provider

Status: source only. The code is in `network/wg-provider/gamestream.mjs`; as of 2026-11-14 it is installed on no
provider. A trial copy of it, run on a workstation against one production edge, carried a real Moonlight pairing and
stream (see "What was tried" below). The KVM Box page still names the local connector's `127.0.0.2`.

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
- Bindings are per provider. An app name that resolves to several providers works when a client keeps to one address
  for a session. Moonlight sends the name on every HTTP(S) request, and resolver address ordering is stable per
  client, but this has not been observed with a real multi-address name.
- Video and audio ride TCP inside TLS between the provider and the app's front: loss causes head-of-line delay.
- A host on Enclave Direct has no provider in front of it and would need the same listener itself. Not built.

## Turning it on

Set `"gameStream": true` in `/etc/enclave-network/provider.json` and run `install.sh` with a release that contains the
gateway. `install.sh` keeps the field across updates and opens `47984/tcp 47989/tcp 48010/tcp 47998:48000/udp` in ufw.
`node wg-provider.mjs --check-config` prints `"gameStream": true|false` and rejects a value that is not a boolean.

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
overflows in every run); behaviour with a name that resolves to more than one provider; SNI on 47984 when the PC is
added by name (the trial added it by address, so those requests followed the binding).

## Tests

`node --test test/wg-provider-gamestream.test.mjs` and the config test in `test/service-index.test.mjs`.

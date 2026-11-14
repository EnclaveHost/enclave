# GameStream gateway on the four edges (prepared 2026-11-14, run on no edge)

Status at 06:35Z: prepared and rehearsed. Nothing here has been run against an edge except the read-only `preflight`
and `status`. The activation is the operator's to run.

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
  `127.0.0.1`, caps of 256 flows, 32 per client, 4096 bindings
- `enclave-gamestream-gateway.service`: a dynamic user, no key, no state, at most 192 MB and 60% of a CPU
- ufw: `47984/tcp 47989/tcp 48010/tcp 47998:48000/udp`

Nothing else. `run.sh activate` stops if the provider's main PID or start time changed across the install.

## Running it

    bash ops/gamestream-gateway-20261114/run.sh activate

Order: ca-east, ap-southeast (neither holds the KVM Box route today), then us-west, eu-central (the two addresses the
app's name resolves to). One edge at a time; the first failure stops the run; a re-run skips verified edges.
`run.sh revert [edge...]` removes everything again. `run.sh check` looks from outside without ssh.

On us-west and eu-central the run also fetches `/serverinfo` under the app's name through the new port. That needs
the KVM Box desktop started (it was at 06:33Z).

## What has been checked

- `preflight` (06:29Z, files in `activation/`): all four edges have the address, Node 22, an active provider, ufw
  active, the six ports free, 247 to 359 MB of memory available.
- `rehearse.sh` (`rehearsal-20261114.txt`): the real bundle, installer and `run.sh` on a workstation with stand-ins
  for ssh, systemctl and ufw: activate, status, check, a skipped second activate, revert, nothing left.
- The bundle on a workstation through us-west as router: see the doc.

## What is not known until it runs, and after

- systemd's sandbox settings have not started this service on a real box. If it does not come up, the installer
  removes it and the run stops at ca-east.
- A cloud firewall in front of the droplets, if there is one, is not ufw. The run's outside check reports a timeout
  on 47989 as exactly that; UDP from outside is only shown by a real stream.
- Bindings are per edge and the app's name has two addresses. If Moonlight sends HTTP to one edge and RTSP to the
  other, the second has no binding and closes it. This is the first thing to try with a real Moonlight by name after
  the activation, and it decides whether the page change can go out as it is.
- A picture on screen in Moonlight through this path has not been seen yet.
- The KVM Box page keeps saying `127.0.0.2` until its own release (enclave-apps branch
  `kvm-box/page-moonlight-public-20261114`, a signed desktop release, owner signatures, a host switch). That release
  must not go out before the edges serve the ports and the Moonlight test by name passes.

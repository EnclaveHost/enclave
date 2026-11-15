# The agent's ingress on its own thread (2026-11-15)

## What was wrong

Every byte a visitor exchanges with an app on a host passes through the host's network agent: tunnel (`enclave-wg`) →
the circuit's sandboxed worker → a loopback WebSocket to the agent's broker (`network/app-broker.mjs`) → the partition
manager's data plane → the app. The broker ran on the agent's one thread, so the bytes waited whenever the agent
computed.

Measured on the NucBox while a test stream ran to the KVM Box (a no-display Moonlight client, 78 s runs):

| | before | after |
|---|---|---|
| agent main thread flat out for 100 ms or more | 20 times in 88 s (120–310 ms each) | 15 times in 88 s (120–430 ms): unchanged, it is the agent's own work |
| moments when every connection of the stream stood still for 120 ms or more (edge gateway's count) | 8–9 a run | 1 a run |
| video frames the client counted as dropped | 25–78 a run | 7–17 a run |
| frames discarded waiting for a key frame | 113–191 a run | 11–55 a run |
| audio loss events | 11–24 a run | 3–5 a run |

Before, each stall of the stream lined up with a stretch of the agent's thread (for example 185 ms from 23:04:27.6Z, the
stream silent for 156–163 ms to 23:04:27.9Z). The runs before and after also differ in the edge gateway's priority
(`network/wg-provider/gamestream-gateway-install.sh`, same day), which took the gateway's wait for a processor from 24%
of the time to 8%.

What is left after the change is not the agent's: the home line both the NucBox and the test client sit behind loses
packets for 0.3–0.8 s every 10–25 s (see `ops/stream-flow-20261115/README.md`, "The home line"), and those moments are
the client's remaining loss events. One stall of about 200 ms a run that is at no hiccup is not explained yet.

## What changed

`network/ingress-thread-host.mjs` (main thread) and `network/ingress-thread.mjs` (the thread): the broker's listener and
the splice to the partition manager run on a worker thread. The main thread still decides every connection: the thread
asks it, it runs `authorize` and the forwarder's `plan` (the verified route `ShieldIngress` would have opened itself;
the native-desktop forwarder plans only what it would hand to `ShieldIngress` after its own checks) and answers with the
route, with "legacy" (the thread hands the connection, as it came, to the main thread's broker, which is always made) or
with a refusal. Only forwarders that can plan are moved; everything else is as before. If the thread ends, the circuits
whose brokers were on it close and are built again. `ENCLAVE_INGRESS_THREAD=0` turns it off.

`scripts/network/build-ingress-thread.mjs` builds the thread's single file; the agent looks for `ingress-thread.mjs`
beside itself and without it works as before. No installer carries that file yet.

## On the NucBox

The installed agent bundle is older than main and hand-carried, so the change was carried onto the installed files
(`agent-bundle.py`: the bundle and the native-startup overlay; each place must match once) and the thread's file added:

| file | before | after |
|---|---|---|
| `privacy-agent.mjs` | 01808234…27b8 | 3b86e03e…474b |
| `native-startup-overlay.mjs` | cff1a042…0edf | 62723ec4…4ddf |
| `ingress-thread.mjs` | – | 53420fcd…ad87 |

`agent-ingress-thread.sh status|stage|swap|revert` (the NucBox side is `agent-ingress-thread.ps1`). Swapped
2026-11-15 23:20:11Z: agent restarted 23:20:24Z, control circuit 23:20:29Z, all 9 apps had a healthy circuit again by
23:21:41Z, loopback exemptions 472 → 491 of 682, the agent has 15 threads (13 before). The previous files are beside
the new ones (`*.before-ingress-thread-20261115`).

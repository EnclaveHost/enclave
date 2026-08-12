# Inbound latency: findings (2026-08-11)

Investigation closed. The premise of the original handoff — "the extra ~178 ms
per request is a platform tax below the app layer" — was **half right**. There
were two separate costs, and only one of them was code.

| | cause | status |
|---|---|---|
| ~170 ms on back-to-back small writes | Nagle on the relay's client socket | **FIXED** (3886e98f) |
| ~175 ms on **every** request | the relay is 175 ms from the enclave | **placement decision, pending** |

The second one is the big one, it is not a bug, and no code change can remove it.

## What the fleet actually looks like

- App zone DNS is a **single static wildcard**: [`relay/dns-relay.js:324`](../relay/dns-relay.js#L324)
  answers every `*.app.enclave.host` name with `APP_A`/`APP_AAAA` from env,
  with no reference to which enclave owns the deployment. (Zone 1, the
  dedicated-IP zone, *is* ownership-aware — it uses the `/v1/net-map` poll.)
- That wildcard is `46.62.128.36` — **nan-relay, Hetzner Finland**.
- Every live tenant deployment runs on **kryptos, `69.46.85.219`, Santa Clara**
  (`EGIHosting`). `metal0` currently hosts none.

So every request to any app crosses the Atlantic **twice**: client → Finland →
Santa Clara → Finland → client.

## Measurements (operator dev box, 2026-08-11, post-fix)

The dev box happens to be 30 ms from the enclave and 171 ms from the relay,
which makes the trombone unusually visible — but the *shape* is the same
everywhere.

| probe | via relay (Finland) | direct to enclave |
|---|---|---|
| ICMP RTT | 171 ms | 31 ms |
| TCP connect | 180 ms | 38 ms |
| TLS appconnect | 1068 ms | 73 ms |
| TTFB, fresh conn | 1414 ms | 105 ms |
| **warm request** | **349 ms** | **29-35 ms** |
| pipelined gap | 0 ms (risc-box) | 1 ms |

**The right-hand column is a measuring instrument, not a route.** It exists to
prove where the time goes, and that is all it is for. App traffic goes through
the relay — that is the design, not an accident of it: the relay is the stable
name a deployment keeps when it migrates between enclaves, and the SNI splice
is what lets a browser's TLS terminate inside the CVM with nothing in between
holding a key. Pointing a client at an enclave origin trades both away to buy
latency. Don't; fix the placement instead.

The accounting closes to within a few ms:

- warm 349 ms = 171 (client↔relay) + ~175 (relay↔enclave). Nothing else.
- fresh TLS 886 ms (pre-fix, measured ClientHello → first server byte) ≈
  3 × 175 (the relay opens a **fresh** TCP+TLS+WS upgrade to the enclave per
  client connection, [`relay.js` `splice()`](../relay/relay.js#L449)) + 1 × 175
  (hello out, ServerHello back) + 171 (client leg).

## What was ruled out, and how

The original H2 (per-request serialization in the in-enclave leg) and H3
(ACK-paced pumping in the bridge) are both **dead**. Proof: drive the *exact
same code path the relay uses* — a WS to `/x/:id/https` with the browser's TLS
spoken over it — from a box 30 ms from the enclave:

```
ws open at 104 ms          (TCP + TLS + WS upgrade ≈ 3 RTT)
TLS handshake over bridge: 35 ms      = 1 RTT, not 5
warm#1 ttfb 32 ms                     = 1 RTT, not 2
pipelined: gap 1 ms                   = app-local, not 1 RTT
```

Every number is 1× the client↔enclave RTT. The in-enclave bridge, the `/x/:id`
proxy, the WAF and the supervisor→tenant hop add **nothing** measurable.
(`docs/`-adjacent probe scripts are throwaway; the recipe above is the whole
test.)

Also corrected: the original doc inferred "app layer ruled out" from risc-box
and eyesoff-ai showing identical 349 ms. True for the *warm request* (both are
dominated by geography), but **not** for pipelining — eyesoff-ai (`wasi:http`
under `wasmtime serve`) does not pipeline, showing a ~24 ms gap on the
**direct** path where no relay exists. risc-box on the identical platform path
is 0 ms. That residual is the wasmtime runtime, not the platform.

## The fix that landed: Nagle (3886e98f)

Node leaves Nagle **on** for `net.createServer` sockets. `http.Server` clears
it for you; a raw listener gets no such favor. `ws` already clears it on the
enclave leg ([`ws/lib/websocket.js:248`](../node_modules/ws/lib/websocket.js#L248)),
so the client-facing socket was the **one** Nagle-enabled hop in the entire
inbound path.

Cost: a full **client** round trip whenever the relay wrote twice in quick
succession — headers then a small body, two SSE frames, two pipelined
responses. Measured: two `/ping` responses generated 1 ms apart in the enclave
arrived **170 ms** apart. Now 0 ms. Fresh-connection TTFB also dropped
1.61 s → 1.41 s.

`tcp6-relay.js` had the identical bug on the declared-tcp ports (Moonlight,
ssh, minecraft) — small writes and latency *are* the product there. Fixed too.

**What it does not fix:** a single request with a single small response —
which is exactly the RISC Box `/hid` input event. That is one write, so Nagle
never applied. HID stays at ~349 ms until placement changes.

Not touched: `egress-relay.js:151` pipes a raw `net.connect` socket the same
way (guest **outbound**). Same one-line shape, opposite direction, out of
scope here — worth doing.

## The decision that remains: placement

No code can fix 175 ms of Atlantic. Options, cheapest first:

1. **Repoint the app zone.** Every tenant is in Santa Clara; the relay is in
   Finland. Standing up a relay near kryptos and pointing `APP_A`/`APP_AAAA`
   at it takes ~175 ms off **every request, fleet-wide**, with one env change
   and no code. Costs a box.
2. **Make zone 2 ownership-aware.** Once more than one relay exists, answer
   `<label>.app.enclave.host` with the relay nearest the enclave that owns
   that deployment. The dns-relay already polls exactly that ownership map for
   zone 1 — zone 2 just never used it. This is the real fix and it composes
   with (1).
3. **Pool the upstream WS.** The relay dials a fresh TCP+TLS+WS upgrade to the
   enclave on **every** client connection — ~3 relay↔enclave RTTs (~525 ms
   today) before the ClientHello moves. Pre-warming would cut fresh-connection
   cost hard. This shrinks on its own once (1) lands, so it is third.

Expected after (1), from this dev box: warm request 349 → ~35 ms. For a
European client it becomes ~1× Europe↔California (~150 ms) instead of
171 + 175 = 349 ms — still roughly 2.3× better. There is no placement that is
good for everyone at once; that is what (2) is for.

## Reproducing

```sh
# the real data path
curl -sso /dev/null -w 'via relay  ttfb %{time_starttransfer}s\n' https://e64f7cba.app.enclave.host/ping

# the same deployment with the relay taken out of the picture — DIAGNOSTIC
# ONLY, to attribute the difference. Never a route to point a client at.
ID=0xe64f7cba307e2d97485bde356d75564ccb74c5e31c272b5ab3349abfe122569b
curl -sso /dev/null -w 'direct     ttfb %{time_starttransfer}s\n' \
  "https://kryptos.enclave.containers.tinfoil.dev/x/$ID/ping"

# who is where
REGISTRY_ADDRESS=0x868eB7fc5B5A84B2FF082eafc9bf40b7AAc5CCAC node scripts/enclave-discover.mjs --all | grep endpoint
getent ahosts e64f7cba.app.enclave.host
```

`/ping` on risc-box is unauthenticated by design; the `/x/<full-id>/` path on
an enclave origin is the same app without the relay in front.

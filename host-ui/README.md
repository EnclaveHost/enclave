# host-ui: one hosting panel for every host app

The Windows tray (`windows/tray`, a WebView2 window) and the Android Enclave app (`shielded/anchor/avf/host/app`, a
WebView) both load these files. There is no second copy: a change here is a change on both, the next time each is built.

```
index.html   the panel's markup: the switch, the accordion (Limits, Price, Earnings, Apps), the node's state, the dialog
app.css      the site's look (DESIGN.md); one layout that fits a 360 px tray panel and a phone, larger targets on touch
text.js      every sentence the panel says, as pure functions of what the node answered (tested in Node)
bridge.js    the only way out of the page: requests to the node's local API, through the shell that hosts it
app.js       the panel's behaviour
dev-server.mjs   serves the panel to a browser and forwards its requests to a node (or to fake-node.mjs)
fake-node.mjs    an in-memory node answering the same API, for tests and for working on the panel without one
```

Work on it in a browser: `node host-ui/dev-server.mjs --fake` and open the address it prints. Against a real Windows
node: `node host-ui/dev-server.mjs --node http://127.0.0.1:9610 --token-file <hosting-admin.token>`.

## The node's side: the local hosting API

The panel uses only these routes. `windows/node/hosting.mjs` is the reference; the phone's host agent
(`shielded/anchor/avf/runner/host-agent.mjs`) answers the same contract. Loopback only, `Authorization: Bearer <token>`.

| route | answer |
|---|---|
| `GET /v1/local/hosting` | the hosting view (below) |
| `PUT /v1/local/hosting` | `{cpuShare?, gpuShare?, paused?, drop?}`; 409 `would_drop` with `drop: [{id, appRef, cpuShare, gpuShare}]` (newest first) changes nothing until repeated with `drop` naming every one of them |
| `PUT /v1/local/hosting/price` | `{cpuPerHour?, gpuPerHour?}`, USDC an hour, `null` for the default; answers the hosting view |
| `GET /v1/local/hosting/earnings` | `{readable, enclaveId, operator, wallet, payTo, why, earned6, paidOut6, minPayout6, paying, lastError, history: [{tx, to, amount6, at}]}` (6-decimal integers as strings) |
| `PUT /v1/local/hosting/payout-wallet` | `{address}`: format-checked (0x and 40 hex, not zero); answers the earnings |
| `POST /v1/local/hosting/payout` | pay out now, any amount; 409 `not_paid` with `message` when it can't |

The hosting view: `caps {cpuShare, gpuShare, paused}`, `inUse`, `free` (each `{cpuShare, gpuShare}`), `reservedShare`,
`deploymentsServed`, `waitingForCap`, `backend`, `capsError`, `gpu {consumer, why}`, `appsEnabled`, `market {taking, why}`,
`pricing {cpu, gpu}` (each `{perHour, tier, gb, flops, override, default {perHour, from}}` or null), `gas {operator, low,
hoursLeft, renewalsLeft}`, `logsDir`. Optional, for hosts that differ from a Windows PC (absent means the PC's answer):

- `device {kind, noun}`: what the panel calls the machine ("PC", "phone").
- `axes`: the shares this host offers, `["cpu", "gpu"]` by default; a phone offers `["cpu"]` and the panel shows no GPU.
- `cpuLabel`: the CPU share's name, "CPU" by default; a phone's one share is "CPU & RAM".
- `apps [{id, appRef, phase, host?}]`: the apps here, for the Apps section (absent: no Apps section).

## The shell's side: the bridge

The page never holds the token and never opens a connection. It posts messages; the shell answers.

| page sends | shell answers |
|---|---|
| `{id, op: "hello"}` | `{id, platform, titleBar, version, notice?}`: `titleBar` false when the window has no title (a phone), so the page shows its own; `notice`, something the shell has to say (a config file it could not use) |
| `{id, op: "request", method, path, body?}` | `{id, status, body}`; `status: 0` with `message` when the node can't be reached (why, in words); `update {state, to}` while an automatic update runs |
| `{op: "size", height}` | nothing: the shell fits its window to the panel (Windows) |
| `{op: "hide"}` | nothing: Esc with no section open hides the window (Windows) or leaves the app (Android) |
| `{op: "open", url}` | nothing: an `https://` link opens in the system browser |

The shell posts `{event: "show"}` when the window is shown (the page refreshes), `{event: "hidden"}` when it is hidden
(unapplied changes are dropped, sections close), `{event: "back"}` for Android's Back (the page closes the open section,
or answers `{op: "hide"}`), `{event: "toggle"}` for a switch outside the page (the tray menu's: the page asks before
apps stop, as its own switch does) and `{event: "refresh"}`. Requests go to `/v1/local/hosting` and below only; a shell refuses any other path.

- WebView2: `window.chrome.webview.postMessage(obj)`; answers arrive as `message` events.
- Android: `window.EnclaveHostNative.postMessage(json)`; answers arrive through `window.__enclaveHost(json)`.
- A browser (dev-server.mjs): `fetch("/api" + path)` on the same origin.

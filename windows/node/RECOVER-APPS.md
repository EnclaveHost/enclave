# Recovering ipns-publisher and s3-ipfs-adapter — prepared, not run

Both apps stopped accepting on the loopback port they serve from inside the enclave. This is the
exact change and the exact procedure. **Nothing here has been executed**, and it is a NODE-only
restart: it has nothing to do with the Hyper-V role decision and must not be combined with it.

## What is wrong, measured

```
app-zone 0xd9798e4c: app connect ECONNREFUSED 127.0.0.1:9776     first 19:03:32Z, 192 times
app-zone 0x7ae476a3: app connect ECONNREFUSED 127.0.0.1:9799     first 19:14:33Z, 183 times
```

Both had been serving (the gateway answered 200 for each at 18:05Z). jot and the MCP adapter are
`wasi:http` and unaffected. RISC Box is also `wasi:cli`, was loaded earlier and never reloaded, and
still answers on 9822.

On reload the HOST binds the port again - `Get-NetTCPConnection` shows 9776 and 9799 listening under
ee-host with fresh creation times - and nothing inside the enclave ever accepts it, so the node
reports `the app did not bind 127.0.0.1:9776 inside the enclave within 120s`. **Why the in-enclave
side stops accepting is not established.** The node has no visibility inside the enclave, and I am
not going to guess at it.

## Both apps DO have a root page - correction

I previously said neither had a root UI to fabricate. That was wrong and I had not looked.

| app | source | serves |
|---|---|---|
| ipns-publisher | `ipns-publisher/src/main.rs:568` | `GET /` -> `status_page`, plus `/healthz` and `/api/status` |
| s3-ipfs-adapter | `s3-ipfs-adapter/src/main.rs:956` | `GET /` and `/index.html` -> a UI |

So the dashboard's Open destination is right, and a working app renders a page. The deployed
revisions are catalog 1.0.3 and 1.0.11; the working tree reads 0.1.0 and 0.5.0 in Cargo.toml, so the
tree is not necessarily the deployed revision - but the routing is present in the source we have,
and nothing suggests it was removed.

## The lease I released, and what it costs

My restart attempt is what pushed `0xd9798e4c` over the node's give-up threshold:

```
0xd9798e4c released :: it would not start after 3 tries: the app did not bind 127.0.0.1:9776 within 120s
```

`#giveUp` hands the lease back on-chain AND records the id in `host-state.json` `blocked`, so the
ledger scan will not re-take it. Recovering it therefore needs a FORCED claim, which costs one claim
transaction (~0.000000677 ETH; the operator holds ~0.0019 ETH). `0x7ae476a3` is sitting in
`provisioning` and has NOT been released - leave it alone rather than repeating the retry that
released the other one.

**No more blind retries.** Each one burns a start attempt and moves a deployment closer to being
released, which is how this one was lost.

## The patch this deploys (committed, tested, not shipped)

| | |
|---|---|
| `appzone.mjs` | a connect that fails before the app speaks answers **502 with a JSON body**, flushed properly - the write is ended and the TLS socket's own close drives teardown, with a 10s backstop. Previously it destroyed the socket, which a browser renders as `ERR_EMPTY_RESPONSE`. |
| `host.mjs` | the tick asks `alive()` and records `unreachable` (lease still held) after one tick of grace, **and puts it back to `running`** when the listener returns. It never gives up or tears down on a failed probe. |
| `host.mjs` + `agent.mjs` | `holdsLease()`: this box no longer answers the relay's ownership probe for deployments it refused (commit `78b3eb9f`). |

Tested behaviourally, not by source matching: real tunnel frames, a real WebSocket, real TLS, and a
port with nothing behind it, including a deliberately slowed and chunked transport that proves the
whole 502 body arrives - the regression a review caught in my first attempt, where the transport was
torn down under bytes that had not left.

## The procedure

```powershell
# 1. preserve state and logs BEFORE anything stops
Copy-Item C:\Users\claude\vbs\node\host-state.json C:\Users\claude\vbs\node\host-state.before-recover.json
Copy-Item C:\Users\claude\vbs\node\agent.log      C:\Users\claude\vbs\node\agent.before-recover.log
Get-Content C:\Users\claude\vbs\node\host-state.json | ConvertFrom-Json | Select-Object -Expand blocked
```

```bash
# 2. ship the patch (windows/node/sync.sh restarts the task; it DELETES agent.log, which step 1 copied)
cd /home/steven/Projects/enclave-vbslike && BOX=minipc-zt windows/node/sync.sh
```

```powershell
# 3. after the restart: the two apps should claim and bind on their own
Get-Content C:\Users\claude\vbs\node\agent.log -Tail 40
(Invoke-RestMethod http://127.0.0.1:9600/v1/deployments).deployments |
  ForEach-Object { "{0} {1} port={2}" -f $_.id.Substring(0,10), $_.status, $_.port }

# 4. ONLY if d9798e4c is still blocked, one forced claim - not a loop
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9600/v1/claim-hint `
  -Body '{"id":"0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a","force":true}' `
  -ContentType 'application/json'
```

```bash
# 5. verify from outside, which is what the user sees
for h in d9798e4c 7ae476a3; do curl -sS -o /dev/null -w "$h %{http_code}\n" "https://$h.app.enclave.host/"; done
```

Expect 200 with a rendered page from both. A 502 with `app_unreachable` means the patch is working
and the app still is not - which is a better failure than a blank tab, and not success.

## What it costs

- **All five apps stop.** Four return within about a minute; the RISC Box needs a further ~13
  minutes to restore its 21.8 GiB guest, so the full set is back in **about 15 minutes**.
- Durable state is safe: the apps keep theirs in their own S3 and R2 buckets, and `host-state.json`
  is copied first.
- `ipfs.enclave.host` is NOT affected - that hostname is served from the site box, not this app.
- Gas: nothing, unless step 4 is needed, and then one claim.

## What it does not promise

A restart clears the enclave host process and lets the apps bind again. It does not explain why they
stopped accepting after about an hour, so the same failure may recur. If it does, the next step is
instrumenting the enclave side rather than restarting again.

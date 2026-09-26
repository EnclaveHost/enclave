# hv-soak: a read-only soak monitor for the NucBox isolated-app deployments

`soak.mjs` watches one deployment on the NucBox hv-node (T0-hv: the host is not excluded) from the Linux workstation.
Every INTERVAL (300 s by default) it takes one sample and appends it as one JSONL line. It uses only Node built-ins, so
the file runs on its own, outside a checkout.

It runs in one of two modes, chosen by the target:

| run | target | what it can PASS |
|---|---|---|
| availability/stability soak | hello-world, or any app | everything except the leak check. Run it with `--leak-scope out --leak-evidence "<why>"`. The verdict line then reads `VERDICT (availability/stability; leak not in scope): PASS\|FAIL`. |
| leak soak | a sentinel app that echoes the token (below) | everything, the leak check included. The leak check PASSes only on enough exercised samples. |

The default is in scope. A run that cannot exercise the leak check therefore never prints `VERDICT: PASS`; it prints
`VERDICT: NOT PASS (the leak check was not exercised enough to pass)`.

## What one sample does

Each sample opens one ssh session and sends one HTTPS request per check.

| # | check | how |
|---|---|---|
| 1 | public TLS | ONE `GET` of the app URL with `--path` (default `/hv-soak/{token}`), where `{token}` is the sample's random token. The token also rides in `x-hv-soak`. The chain and the hostname are verified against Node's CA store. When a connection fails verification, its leaf is recorded (SPKI sha256, serial, issuer, the reason) and the connection is dropped before any response is read. Only a verified 200 counts. The first 4 KiB of the body are kept in memory, never stored, and searched for the token. |
| 1b | HEAD tripwire (`--leak-probe --body-marker S`) | ONE `HEAD` to the same URL, same token, same verification rules, sent together with the GET. |
| 2 | relay row | `GET https://api.enclave.host/enclaves`, unauthenticated, reading the `nucbox-k11` row. It is OK when all of these hold: mode and tier `hv-node`, `attach` `attestation`, `tunnel` true, `hvNode.hostExcluded` false, and `availability.claimScope` `owner-only`. The sample also records `lastSeen`, `owners`, `eligible` and `serving`. |
| 3 | the box | ONE `ssh minipc-zt` session. A short `-EncodedCommand` bootstrap reads the sampler script from stdin; nothing is written to the box. It reads: the manager's `GET /vms`; `Get-VM` for the `enclave-app-*` VMs; host free memory; `hvnode\logs\node.log` and `manager.log`, from where the last sample stopped, opened for READ with sharing; and the deployment's COM1 console. |
| 4 | chain (`--no-chain` skips it) | ONE `eth_call get(bytes32)` on the deployments ledger through a public Base RPC. It records balance6, spent6, leaseUntil and whether the runner is this box. |

**Order within a sample:**
1. The script reads `/vms`. If the record is `running` with `guest` set (the manager's start-time capture is done), it opens the COM1 pipe `(Get-VMComPort -VMName enclave-app-<instance> -Number 1).Path` as a reading client.
2. It records each log's size, from an open handle, then prints `HVSOAK1-READY`.
3. The workstation fires the GET (and the HEAD) at that line, with a 20 s timeout.
4. The console is read for `--console-sec` (25 s, and at least the timeout plus 5 s), then the logs, `Get-VM` and memory.

The GET is recorded with its trigger:
- `console`: at READY with the console connected;
- `noconsole`: at READY with no console;
- `fallback`: by the 60 s timer or the session's end.

Nothing on the box is changed. There are no restarts, no config changes and no installs, and nothing under `state\` is
read. Console and log line CONTENTS are never stored or printed:
- A console line that is not the guest's own is reported as a count and its sha256.
- Log lines are counted. Only the node's restart and card-price lines are kept, truncated.
- The GET's body is only searched for the token.

## The leak check

**What proves a sample exercised it.** A sample is EXERCISED only with proof that the app's output path ran in it. All
of these must hold:
- the partition was Running;
- the GET was a verified 200, fired at READY with the console connected;
- its body contains this sample's token;
- the console and both logs were read.

**Why the echo is required:**
- The sentinel target echoes the token in its body, and prints it to stdout and stderr on every request as `-STDOUT-REQ <path> <x-hv-soak>`.
- So when the token is absent from the console and from both logs, the app produced those bytes and nothing carried them out.
- hello-world never echoes, so it can never count. A token in the path proves nothing for an app that never logs.

**What FAILs it**, in the console window or in node.log/manager.log past their history:
- the sample's token;
- a `-STDOUT-REQ` line;
- the HEAD body marker;
- a console line that does not match `^(DOM|MON)|^\[ *[0-9]+\.[0-9]+\]`.

**The HEAD tripwire (`--leak-probe --body-marker S`).** This is a tripwire, not coverage:
- **Not covered on hv:** the front's unsolicited-response guard. Under bundle/1 wasi:http (wasmtime serve), hyper frames every response, so no servable app can reach it. Every summary says so.
- A sighting of the marker S, the token or a `-STDOUT-REQ` line is still a FAIL. An old front would log ``Unsolicited response … starting with "<body>"``.
- A `DOM front: unsolicited upstream response (N bytes withheld)` line is INFO.
- The HEAD never makes a sample exercised.
- `--body-marker` has no default and goes with `--leak-probe`. For hookbin, whose HEAD returns 404 with body `{"error":"gone"}`, it is `--body-marker '{"error":"gone"}'`. Use `--path '/ping?hvsoak={token}'` with it, because hookbin answers GET `/ping` with 200 and every other path with 404, and its path excludes the query. hookbin's body does not echo the token, so a hookbin run cannot exercise the check.

**The leak floor.** `--summary` gives `leak` one of four results:
- **FAIL**: any leak event, in any sample.
- **PASS**: no event, at least one exercised sample, and exercised samples make up at least the floor of all samples. The floor is 90% by default; set it with `--leak-floor 0.95` or `95%`.
- **NOT EXERCISED (x/N)**: otherwise.
- **NOT IN SCOPE: \<evidence\>**: with `--leak-scope out`. Sightings are still shown on that line, but not judged.

**History (G2).** The logs' history is only the bytes below each log's size at the FIRST READY. It is reported apart and never judged:
- Everything at or past that size is judged, including the first sample's own probe lines.
- A line that crosses the boundary is judged, not filed as history.
- Without that size, the first read fails closed: the log counts as unread, and the next sample tries again.
- A file that was replaced is all judged.

## Thresholds

| id | FAIL when | notes |
|---|---|---|
| public | 3 or more consecutive public checks are not a verified 200 | |
| spki | the leaf's SPKI changes with no restart of the deployment in the node log | See "SPKI baseline and restarts" below. |
| partition | the partition is not Running on 2 consecutive samples | Running means the manager says `running` and, when `Get-VM` answered, the VM is `Running`. A sample whose box read failed is unknown: it neither counts toward the streak nor resets it. |
| price | a new `registry: card price now` line (a price tx) past the history | |
| leak | see above | Its result is PASS, FAIL, NOT EXERCISED, or NOT IN SCOPE. |
| box | the ssh or box read fails on 3 or more consecutive samples (INFO below that) | The box read is ssh, `/vms`, both logs, and the console whenever the partition is running. |
| relay | the relay row is wrong on 3 or more consecutive samples, or `hostExcluded` is true in any sample | This one is an addition: the hv tier never excludes the host. |

**SPKI baseline and restarts:**
- The baseline is the first leaf presented, verified or not. With M4, a self-signed leaf and the CA-issued one carry the same key.
- A change is explained by a judged restart line for the deployment: `<id10> isolation spawned`, `<id10> isolated domain retired`, `<id10> isolation respawn`, or `config edit <id10>: … relaunching`. The line must be in the same window, or in an earlier window after which no leaf was seen yet. An explained change re-baselines to the new SPKI.
- If the node log could not be read when the key changed, the change is judged at the next read.
- Restart lines in the history explain nothing.
- Each sample also records `derived.spkiEqualsManagerKey`: whether the public leaf's SPKI equals the manager's `transportKeySha256`.

## Usage: a 12 h run

Take a copy of `soak.mjs` out of the branch:

```sh
mkdir -p ~/enclave-bench/nucbox-soak && cd ~/enclave-bench/nucbox-soak
git -C ~/Projects/enclave fetch origin windows/hv-soak-monitor
git -C ~/Projects/enclave show origin/windows/hv-soak-monitor:windows/node/ops/hv-soak/soak.mjs > soak.mjs
```

**Availability/stability soak** on the hello-world test deployment (the default `--deployment`):

```sh
EVID='hv tier: bundle/1 wasi:http under wasmtime serve frames every response; hello-world never prints (box control 2026-09-26)'
node soak.mjs --once --leak-scope out --leak-evidence "$EVID"                      # one sample, printed; nothing written
nohup node soak.mjs --duration 12h --leak-scope out --leak-evidence "$EVID" \
  > soak-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &
echo $! > soak.pid
```

**Leak soak** on a sentinel deployment. Replace the `<…>` values; the path must be a route that answers 200 and echoes `x-hv-soak`:

```sh
nohup node soak.mjs --duration 12h --deployment 0x<sentinel id> --path '/<route>?hvsoak={token}' \
  [--leak-probe --body-marker '<its HEAD-body marker>'] > soak-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &
```

**Where the output goes:**
- The samples are appended to `~/enclave-bench/nucbox-soak/<start, UTC>.jsonl`. The first line of `soak-*.log` names the file.
- The log gets one line per sample, with its FAIL and INFO lines under it, and the summary at the end.
- The run's header line records the scope, the evidence, the path and the probe settings. The summary takes the scope from it.

**Other commands:**
- `kill "$(cat soak.pid)"` (its exact PID) stops the run after the current sample and prints the summary.
- `node soak.mjs --summary FILE.jsonl [--since ISO] [--leak-floor 0.9] [--leak-scope in|out --leak-evidence E] [--json]` summarizes at any time.
  - It re-evaluates every threshold from the observations, not from the stored verdicts, and exits 1 unless it PASSes.
  - `--json` prints the summary as JSON, carrying `leakScope`, the `leakEvidence`, the verdict and each threshold.
  - `--since` scores only the part after a given time.
- Options: `--interval 300`, `--duration 12h`, `--out FILE`, `--deployment 0x…`, `--url`, `--path`, `--node`, `--relay`, `--ssh`, `--root`, `--console-sec 25`, `--rpc URL` (repeatable), `--no-chain`, `--leak-floor`, `--leak-probe --body-marker S`, and `--leak-scope out --leak-evidence E`.

**What the summary prints:**
- the result of each threshold, with the worst streak and the first event;
- public uptime and latency p50/p95;
- the longest stretch with no gap over 2×INTERVAL;
- the share of samples with the partition Running;
- node-log counts, the console totals and the balance trend;
- the leak check's exercised count (and how many samples echoed), and the statement that the hv guard is not covered;
- the HEAD tripwire's counts.

## Tests

`node --test windows/node/ops/hv-soak/soak.test.mjs` runs the parsers, the thresholds, the leak rules, G2 and both
summary modes against fake box answers and fake JSONL. It also runs the TLS check, the HEAD and the token echo against
a local server whose throwaway certificate openssl makes at test time; that test is skipped when openssl is missing.

## Limits (stated, not hidden)

- **Console coverage.** The console is covered for the window around the requests. Output at other times is seen only when a later window catches it, because Hyper-V does not keep it for a reader who was not connected.
- **Partial first line.** A window can begin mid-line. Its first line is judged like any other.
- **v40 console leak.** The v40 guest (image b7ba7731) has a known console leak, fixed in v42.

# hv-soak: a read-only soak monitor for the NucBox isolated-app test deployment

`soak.mjs` watches one deployment on the NucBox hv-node (T0-hv: the host is not excluded) from the Linux workstation. It
takes one sample every INTERVAL (300 s by default) and appends each sample as one JSONL line. It uses only Node
built-ins, so the file runs on its own, outside a checkout.

## What one sample does

Each sample opens one ssh session and sends one HTTPS request per check.

| # | check | how |
|---|---|---|
| 1 | public TLS | ONE `GET https://<id8>.app.enclave.host/hv-soak/<token>`, with the token also in `x-hv-soak`. The chain and the hostname are verified against Node's CA store. When a connection fails verification, its leaf is recorded (SPKI sha256, serial, issuer, the reason) and the connection is dropped before any response is read. Only a verified 200 counts. |
| 1b | the HEAD leak probe (`--leak-probe --body-marker S`) | ONE `HEAD` to the same URL, with the same token and the same verification rules, sent together with the GET inside the console window. See "The active leak probe" below. |
| 2 | relay row | `GET https://api.enclave.host/enclaves`, unauthenticated, reading the `nucbox-k11` row. It is OK when all of these hold: mode and tier `hv-node`, `attach` `attestation`, `tunnel` true, `hvNode.hostExcluded` false, and `availability.claimScope` `owner-only`. The sample also records `lastSeen`, `owners`, `eligible` and `serving`. |
| 3 | the box | ONE `ssh minipc-zt` session. A short `-EncodedCommand` bootstrap reads the sampler script from stdin. Nothing is written to the box. The script reads: the manager's `GET /vms` (127.0.0.1:8091); `Get-VM` for the `enclave-app-*` VMs; `Win32_OperatingSystem` for free memory; `hvnode\logs\node.log` and `manager.log`, from the byte offset where the last sample stopped (opened for READ with sharing); and the deployment's COM1 console. |
| 4 | chain (`--no-chain` skips it) | ONE `eth_call get(bytes32)` on the deployments ledger through a public Base RPC. It records balance6, spent6, leaseUntil and whether the runner is this box. After a failed call, the next sample tries the next RPC. |

The console is read as follows:
- The pipe is `(Get-VMComPort -VMName enclave-app-<instance> -Number 1).Path`, which is `\\.\pipe\enclave-app-<instance>-com1`.
- It is opened only when the manager's record is `running` and has `guest` set, which means the manager's start-time capture has finished. So the soak never takes the pipe from a start that is still attaching to it.
- The client reads for `--console-sec` (25 s) and then disconnects.
- The box prints `HVSOAK1-READY` once it is connected, and the workstation sends the GET and the HEAD only then, both with a 20 s timeout. They therefore land inside the console window.
- After the window, the logs are read. So a restart that the public check saw is already in the log that the same sample reads.

## The active leak probe

**The token proves nothing for an app that never logs.** hello-world writes nothing to the console, even while it serves, so a token in its request path can never show up anywhere, even on a leaky guest. A leak check built only on the token passes on a leaky guest.

The HEAD probe is what exercises the path:
- The soak target is a **sentinel app** built by enclave-5d. On each request it prints `-STDOUT-REQ <path> <x-hv-soak header>` to stdout and stderr, and it answers HEAD with a body that carries a marker.
- An app that sends a body on HEAD makes the in-guest front handle bytes it must drop:
  - An **old** front (Go stdlib) logs ``Unsolicited response … starting with "<body>"`` to the console, which carries the marker.
  - The **fixed** front logs `DOM front: unsolicited upstream response (N bytes withheld)`.
- On a leaky guest the sentinel's stdout also reaches the console. That brings `-STDOUT-REQ` lines, and the sample's token with them.

These count as leaks, each a FAIL wherever it is seen: in the console window, or in node.log or manager.log after the baseline read:
- the body marker;
- a `-STDOUT-REQ` line;
- the token.

A `bytes withheld` line is not a failure. It is counted as proof that the probe reached the front and that the front dropped the body.

**`--body-marker` has no default.** It is the marker the target app puts in its HEAD body, and `--leak-probe` refuses to start without it. For the sentinel, pass the marker the sentinel's source defines: ask enclave-5d, or read the sentinel app. Without `--leak-probe` no HEAD is sent, and the leak check can never PASS (see the leak floor below).

In the node and manager logs, marker and sentinel sightings in the first (baseline) read are the logs' history from before the soak. They are reported apart and not judged.

Nothing on the box is changed. There are no restarts, no config changes and no installs, and nothing under `state\` is read.
Console and log line CONTENTS are never stored or printed:
- A console line that is not the guest's own is reported as a count and its sha256.
- Log lines are counted. Only the node's restart and card-price lines are kept, truncated to 200 characters.

## Thresholds (FAIL)

| id | FAIL when | notes |
|---|---|---|
| public | 3 or more consecutive public checks are not a verified 200 | A TLS failure, a timeout or a non-200 all count. |
| spki | the leaf's SPKI changes with no restart of the deployment in the node log | See "SPKI baseline and restarts" below. |
| partition | the partition is not Running on 2 consecutive samples | Running means the manager's `/vms` status is `running` and, when `Get-VM` answered, the VM is `Running`. A sample whose box read failed counts as unknown: it neither counts toward the streak nor resets it. |
| price | a new `registry: card price now` line appears (a price tx) | The first read of `node.log` is the baseline. |
| leak | the console has a line that does not match `^(DOM\|MON)\|^\[ *[0-9]+\.[0-9]+\]`; or the sample's token, the body marker or a `-STDOUT-REQ` line appears in the console, node.log or manager.log | Blank lines and the trailing partial line are not judged. The token and the marker are still searched for in the raw text. `bytes withheld` lines are INFO. **No leak seen is not a PASS on its own:** see "The leak floor" below. |
| box | the ssh or box read fails on 3 or more consecutive samples (INFO below that) | The box read is the ssh session, `/vms`, both logs, and the console whenever the partition is running. |
| relay | the relay row is wrong on 3 or more consecutive samples, or `hostExcluded` is true in any sample | This threshold is an addition: this tier never excludes the host. |

**The leak floor.** A leak can only be seen in a sample that EXERCISED the check. That needs all of these:
- the deployment's partition was Running;
- the public GET carrying the token was a verified 200, so the request reached the partition;
- the HEAD probe was sent inside the connected console window. That means it was fired by `HVSOAK1-READY` with the console connected, over a verified connection, and it got an answer. A probe fired by the fallback timer does not count, and neither does one with `--leak-probe` off;
- the console was read around the requests;
- node.log and manager.log were both read.

`--summary` gives `leak` one of three verdicts:
- **FAIL**: any leak event, in any sample.
- **PASS**: no leak event, at least one exercised sample, and exercised samples make up at least **the floor (90% by default)** of all samples. Set the floor with `--leak-floor 0.95` or `--leak-floor 95%`.
- **NOT EXERCISED (x/N)**: anything else.

The overall verdict is PASS only when every threshold PASSes. With `leak` NOT EXERCISED and nothing FAILed, it reads `NOT PASS`, and the exit code is 1. The exercised count is printed on the leak line and on its own summary line. Each sample also records it, informationally, in `derived.leakExercised`.

This stops two things:
- **A vacuous PASS.** Examples: 0/144 console reads, a public route that never delivered the token, or a run without the HEAD probe.
- **Patchy coverage.** Alternating console failures never make 3 in a row, so the `box` threshold alone would never trip.

**SPKI baseline and restarts:**
- The baseline is the first leaf presented, verified or not. With M4, a self-signed leaf and the CA-issued one carry the same key.
- A change is explained by a restart line for the deployment in the node log: `<id10> isolation spawned`, `<id10> isolated domain retired`, `<id10> isolation respawn`, or `config edit <id10>: … relaunching`. The line must be in the same window or in an earlier window after which no leaf was seen yet. An explained change re-baselines to the new SPKI.
- If the node log could not be read when the key changed, the change is judged at the next read.
- Restart lines in the first, baseline read (the history) explain nothing.
- Each sample also records `derived.spkiEqualsManagerKey`: whether the public leaf's SPKI equals the manager's `transportKeySha256`, which is the partition's own key.

## Usage: a 12 h run

`soak.mjs` has no imports outside Node, so take a copy of it out of the branch and run it detached. The target is the
SENTINEL app's deployment. Replace the two `<…>` values: the sentinel deployment's id, and the sentinel's HEAD-body
marker. The default `--deployment` is the first hello-world test deployment, which cannot exercise the leak check.

```sh
mkdir -p ~/enclave-bench/nucbox-soak && cd ~/enclave-bench/nucbox-soak
git -C ~/Projects/enclave fetch origin windows/hv-soak-monitor
git -C ~/Projects/enclave show origin/windows/hv-soak-monitor:windows/node/ops/hv-soak/soak.mjs > soak.mjs
node soak.mjs --once --deployment 0x<sentinel id> --leak-probe --body-marker '<sentinel marker>'   # one sample, printed
nohup node soak.mjs --duration 12h --deployment 0x<sentinel id> --leak-probe --body-marker '<sentinel marker>' \
  > soak-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &
echo $! > soak.pid
```

**Where the output goes:**
- The samples are appended to `~/enclave-bench/nucbox-soak/<start, UTC>.jsonl`. The first line of `soak-*.log` names the file.
- `soak-*.log` gets one human line per sample, with its FAIL and INFO lines under it, and the summary at the end.

**Other commands:**
- Stop early with `kill "$(cat soak.pid)"` (its exact PID). SIGTERM lets the current sample finish, then prints the summary.
- Get a summary at any time, including while the run is going, with `node soak.mjs --summary <file.jsonl> [--since <ISO time>] [--leak-floor 0.9]`. It re-evaluates every threshold from the observations, not from the stored verdicts. It exits 1 unless every threshold PASSes.
- `--since` scores only the part after a given time. For example, a run started before the public route served can be scored from the first verified 200.
- Options: `--interval 300`, `--duration 12h`, `--out FILE`, `--deployment 0x…`, `--url`, `--node`, `--relay`, `--ssh`, `--root`, `--console-sec 25`, `--rpc URL` (repeatable), `--no-chain`, `--leak-floor 0.9`, and `--leak-probe` with `--body-marker S` (the two go together; the marker has no default).

**What the summary prints:**
- PASS or FAIL for each threshold (NOT EXERCISED for `leak` below the floor), with the worst streak and the first event.
- The leak check's exercised count, its share of all samples, and the floor.
- For the HEAD probe:
  - the number of samples in which it went out inside the console window;
  - `bytes withheld` lines, and how many samples had them;
  - sightings of the marker and of `-STDOUT-REQ` lines;
  - the logs' history counts.
- Public uptime (verified 200s over all checks) and latency p50/p95 over those 200s.
- The longest stretch of samples with no gap longer than 2×INTERVAL, plus the longer gaps.
- The share of samples with the partition Running.
- From the node log: renewals, not-renewed lines, restart lines, process restarts, and the card-price baseline and additions.
- The console totals and the balance trend.

## Tests

`node --test windows/node/ops/hv-soak/soak.test.mjs` runs the parsers, the thresholds and the summary against fake box
answers and fake JSONL. It also runs the TLS check against a local server whose throwaway certificate openssl makes
at test time; that test is skipped when openssl is missing.

## Limits (stated, not hidden)

- **Console coverage.** The console is covered for 25 s per sample, around the GET and the HEAD. The leak floor sets how many samples must have been covered for `leak` to PASS. Output at other times is seen only when a later window catches it, because Hyper-V does not keep it for a reader who was not connected.
- **The probe needs a target that talks.** The token, the marker and `-STDOUT-REQ` can only be seen if the target app produces them. That is why the soak target is the sentinel, not hello-world.
- **Partial first line.** If the connection lands in the middle of a line, the first line of a window can be a fragment. It is judged like any other line.
- **The v40 guest (image b7ba7731) has a known console leak**, fixed in v42. On v40, expect the `leak` threshold to FAIL. The real 12 h soak runs on the v42 guest.

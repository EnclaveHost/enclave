# hv-soak: a read-only soak monitor for the NucBox isolated-app test deployment

`soak.mjs` watches one deployment on the NucBox hv-node (T0-hv: the host is not excluded) from the Linux workstation. It
takes one sample every INTERVAL (300 s by default) and appends each sample as one JSONL line. It uses only Node
built-ins, so the file runs on its own, outside a checkout.

## What one sample does

Each sample opens one ssh session and sends one HTTPS request per check.

| # | check | how |
|---|---|---|
| 1 | public TLS | ONE `GET https://<id8>.app.enclave.host/hv-soak/<token>`, with the token also in `x-hv-soak`. The chain and the hostname are verified against Node's CA store. When a connection fails verification, its leaf is recorded (SPKI sha256, serial, issuer, the reason) and the connection is dropped before any response is read. Only a verified 200 counts. hello-world ignores the request (enclave-apps `hello-world/src/lib.rs`), so any path answers 200. |
| 2 | relay row | `GET https://api.enclave.host/enclaves`, unauthenticated, reading the `nucbox-k11` row. It is OK when all of these hold: mode and tier `hv-node`, `attach` `attestation`, `tunnel` true, `hvNode.hostExcluded` false, and `availability.claimScope` `owner-only`. The sample also records `lastSeen`, `owners`, `eligible` and `serving`. |
| 3 | the box | ONE `ssh minipc-zt` session. A short `-EncodedCommand` bootstrap reads the sampler script from stdin. Nothing is written to the box. The script reads: the manager's `GET /vms` (127.0.0.1:8091); `Get-VM` for the `enclave-app-*` VMs; `Win32_OperatingSystem` for free memory; `hvnode\logs\node.log` and `manager.log`, from the byte offset where the last sample stopped (opened for READ with sharing); and the deployment's COM1 console. |
| 4 | chain (`--no-chain` skips it) | ONE `eth_call get(bytes32)` on the deployments ledger through a public Base RPC. It records balance6, spent6, leaseUntil and whether the runner is this box. After a failed call, the next sample tries the next RPC. |

The console is read as follows:
- The pipe is `(Get-VMComPort -VMName enclave-app-<instance> -Number 1).Path`, which is `\\.\pipe\enclave-app-<instance>-com1`.
- It is opened only when the manager's record is `running` and has `guest` set, which means the manager's start-time capture has finished. So the soak never takes the pipe from a start that is still attaching to it.
- The client reads for `--console-sec` (25 s) and then disconnects.
- The box prints `HVSOAK1-READY` once it is connected, and the workstation sends the public request only then. The request therefore lands inside the console window.
- After the window, the logs are read. So a restart that the public check saw is already in the log that the same sample reads.

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
| leak | the console has a line that does not match `^(DOM\|MON)\|^\[ *[0-9]+\.[0-9]+\]`, or the sample's token appears in the console, node.log or manager.log | Blank lines and the trailing partial line are not judged. The token is still searched for in the raw text. |
| box | the ssh or box read fails on 3 or more consecutive samples (INFO below that) | The box read is the ssh session, `/vms`, both logs, and the console whenever the partition is running. |
| relay | the relay row is wrong on 3 or more consecutive samples, or `hostExcluded` is true in any sample | This threshold is an addition: this tier never excludes the host. |

**SPKI baseline and restarts:**
- The baseline is the first leaf presented, verified or not. With M4, a self-signed leaf and the CA-issued one carry the same key.
- A change is explained by a restart line for the deployment in the node log: `<id10> isolation spawned`, `<id10> isolated domain retired`, `<id10> isolation respawn`, or `config edit <id10>: … relaunching`. The line must be in the same window or in an earlier window after which no leaf was seen yet. An explained change re-baselines to the new SPKI.
- If the node log could not be read when the key changed, the change is judged at the next read.
- Restart lines in the first, baseline read (the history) explain nothing.
- Each sample also records `derived.spkiEqualsManagerKey`: whether the public leaf's SPKI equals the manager's `transportKeySha256`, which is the partition's own key.

## Usage: a 12 h run

`soak.mjs` has no imports outside Node, so take a copy of it out of the branch and run it detached:

```sh
mkdir -p ~/enclave-bench/nucbox-soak && cd ~/enclave-bench/nucbox-soak
git -C ~/Projects/enclave fetch origin windows/hv-soak-monitor
git -C ~/Projects/enclave show origin/windows/hv-soak-monitor:windows/node/ops/hv-soak/soak.mjs > soak.mjs
node soak.mjs --once                    # one sample, printed; nothing written
nohup node soak.mjs --duration 12h > soak-$(date -u +%Y%m%dT%H%M%SZ).log 2>&1 &
echo $! > soak.pid
```

**Where the output goes:**
- The samples are appended to `~/enclave-bench/nucbox-soak/<start, UTC>.jsonl`. The first line of `soak-*.log` names the file.
- `soak-*.log` gets one human line per sample, with its FAIL and INFO lines under it, and the summary at the end.

**Other commands:**
- Stop early with `kill "$(cat soak.pid)"` (its exact PID). SIGTERM lets the current sample finish, then prints the summary.
- Get a summary at any time, including while the run is going, with `node soak.mjs --summary <file.jsonl> [--since <ISO time>]`. It re-evaluates every threshold from the observations, not from the stored verdicts. It exits 1 on any FAIL.
- `--since` scores only the part after a given time. For example, a run started before the public route served can be scored from the first verified 200.
- Options: `--interval 300`, `--duration 12h`, `--out FILE`, `--deployment 0x…`, `--url`, `--node`, `--relay`, `--ssh`, `--root`, `--console-sec 25`, `--rpc URL` (repeatable) and `--no-chain`.

**What the summary prints:**
- PASS or FAIL for each threshold, with the worst streak and the first event.
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

- **Console coverage.** The console is covered for 25 s per sample, around the public request. Output at other times is seen only when a later window catches it, because Hyper-V does not keep it for a reader who was not connected. The token catches a leak of the request itself wherever it is logged.
- **Partial first line.** If the connection lands in the middle of a line, the first line of a window can be a fragment. It is judged like any other line.
- **The v40 guest (image b7ba7731) has a known console leak**, fixed in v42. On v40, expect the `leak` threshold to FAIL. The real 12 h soak runs on the v42 guest.

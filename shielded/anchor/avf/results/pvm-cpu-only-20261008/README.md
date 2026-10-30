# pVM CPU tier, CPU-only: first device runs (2026-10-08)

Steven, 10-08: "pVMs are only supposed to accept CPU only workloads." This is the first build of the tier with no model
anywhere, run on the lab Pixel 10 Pro XL. The APK is signed with the lab key (keys/anchor.jks), not a production key.

| run | VM | outcome |
|---|---|---|
| `1024mib-abort.log` | fresh instance `pvmcpu1`, 1024 MiB (the old app-mode default), 256 MiB store | the payload aborted (SIGABRT) at its first request: the runtime and a request's instance (up to 256 MiB) do not fit beside Microdroid |
| `2048mib-pass.log` | fresh instance `pvmcpu2`, `--ei mem 2048` | PASS (`2048mib-check.txt`) |
| `defaults-pass.log` | fresh instance `pvmcpu3`, the new defaults (2048 MiB, 256 MiB store) | PASS (`defaults-check.txt`) |
| `host-refusals.txt` | `--es mode local`; `--es app_graph` | both refused by the host before any VM ran: "runs mode app only", "carries no model" |
| `live-attach-401-before-fix.log` | the phone dialling main's tunnel hub configured with only the pVM CPU policy (`live-attach-hub.mjs`, relay modules from branch pvm/cpu-only before its attestOn fix) | `401 Unauthorized`: on main the hub switched AVF attestation on only for a v1 AVF code-hash pin |
| `live-attach-admitted.log`, `live-attach-hub.jsonl` | the same, after the fix (`avfOn` counts the tier's own builds; api-relay's `avfAttestWithPvmCpu`) | the attestation was ACCEPTED (codeHash b2ae0229…); the VM's v2 report was relay-bound; the hub logged `pvm-cpu ADMITTED (CPU-only runtime d3370878…, 8 threads, 1994 MiB)` |

The checker (runtime/conformance/check-app-cpu.py) holds these:
- the protected pvm-cpu payload, with `model=none` on its PINS line;
- the runtime contract's identity;
- no model line anywhere in the run;
- a signed version-2 capability report naming that runtime (RuntimeID d3370878…), with no model field;
- the five requests to cpu-probe answered with exactly the predicted FNV-1a values;
- the server stopped by the owner after five requests.

The report's signature is checked against the attested transport key by the relay (relay/pvm-cpu-tier.mjs), not here.

Driver: `cpu/app-cpu-run.sh <out> out/anchor-pvm-cpu.apk` (LABEL, VMNAME and AM_EXTRA via the environment). The artifacts'
digests are in SHA256SUMS.

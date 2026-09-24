# Cross-platform conformance: one bundle, two backends, one verifier

What RUNTIME.md rule 8 asks for beyond the shared vectors: take ONE byte-identical bundle set and ONE
guest image, run them on the Linux SNP domain shape and on the NucBox Windows partition backend, and
compare what happened. Vectors agreeing is not the same as an app behaving the same.

| piece | file |
|---|---|
| the record shape and the comparison rules (MUST-MATCH vs PLATFORM) | `record.mjs` |
| the comparator (PASS/FAIL lines, `--out report.json`) | `compare.mjs` |
| Linux driver: one SNP guest through `isolation/m3/run-domain.sh`, `m3ctl`, `fwd`, `client.mjs` (judge.mjs is the judge) | `linux.sh`, `linux-record.mjs` |
| Windows driver: `windows/vbslike/run-lab.cmd --record` (judge-hv.mjs, which imports judge.mjs's `checkRuntime`) | `windows/vbslike/verify/lab.mjs` |

Inputs are files, never rebuilt per side: `mon.cpio.gz` (the m3 monitor image), `appA.bundle`,
`appB.bundle` (the m2 wasi:http test app, labels AAAAA and BBBBB, wrapped by `contract/cmd/bundle`),
`appA-tampered.bundle` (one artifact bit flipped after the manifest named the artifact's hash), and the
image's `plat/rt/runtime.json`. Their hashes are in each record.

## Run of 2026-09-23 (`windows/vbslike/evidence/{linux,windows}-record-2026-09-23.json`, `conformance-2026-09-23.json`)

Image `44abb52b…` on both; bundles `603bb7a7…` (A) and `bba82d56…` (B) on both. `compare.mjs`: **27
must-match fields agree, 0 findings.** In particular, on both backends: the app IDs and the app half of
`report_data`; `enclave-domain-abi/2` with the identical runtime identity (wasmtime 48.0.1, jit,
x86_64/x86_64, host-detected, W^X enforced, cache none) and a verified binding; `APP AAAAA
path=/hello?from=client` and `APP BBBBB …` byte for byte; echo intact; the wrong-app client rejected;
the tampered bundle refused with the same words, `bundle refused: bundle manifest names a different
artifact than it carries`; a restated runtime version, an unauthenticated cache and an ABI/1 downgrade
all rejected; a crash retired exactly once leaving nothing behind with the neighbour unaffected; a
destroy removing the domain and closing its door with the neighbour unaffected.

Platform differences, stated by the comparator rather than smoothed: tier T1 versus T0-hv and the
verdict `attested` versus `monitor-signed` (an AMD-signed report with the chain verified, against a
launcher key the caller chose to trust: the Windows tier does not exclude the host and says so);
the format; what vouches (a launch measurement versus a launcher key and an image hash); the guest
kernel (the Linux domain kernel versus the WSL kernel); who refused the tampered bundle (the in-guest
monitor on Linux, the launcher's contract mirror before a partition exists on Windows, both the
contract's Parse); what "crash" means (a bad artifact ending the domain on Linux, the host terminating
the partition on Windows).

Timings, not compared, each with its contention statement in the record: Linux boot to monitor 3.8 s,
load 7-8 ms, p50 0.34 ms, echo 715-726 MB/s on a quiet warden-host with the SNP-batch owner holding
builds; Windows boot to monitor 5.3 s, load 6-7 ms on an otherwise idle NucBox beside the live node.

## Running it again

```
# Linux (needs a quiet window on warden-host from the SNP-batch owner)
isolation/conformance/linux.sh <workdir> <mon.cpio.gz> <appA.bundle> <appB.bundle> <appA-tampered.bundle> <runtime.json> <vcek.der> <min-tcb.json> "<contention note>"
node isolation/conformance/linux-record.mjs <workdir> linux-record.json
# Windows (windows/vbslike/sync.sh ships the same files to the NucBox)
cmd /c C:\Users\claude\vbs-like\run-lab.cmd --expectImage <sha256> --record windows-record.json --contention "<note>"
node isolation/conformance/compare.mjs linux-record.json windows-record.json --out report.json
```

Not in this run: the Pixel pVM (ARM64, Pulley interpreter; its lane produces a record in this shape once
its relay attach format exists), and a wasi:cli bundle (the partition and Linux images serve wasi:http;
a backend that lacks a world reports it as not run, never as a pass).

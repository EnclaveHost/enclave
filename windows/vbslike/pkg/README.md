# The NucBox own-guest package

One manifest pins, by sha256, every byte that nucbox-k11 needs to boot OUR guest and serve one small app. For each byte
it records where it comes from and how to make it again. Owned by enclave-53. The box, the manager, the launcher and
the IGVM recipe belong to enclave-d1. The guest runtime (isolation/m3) and the datapath belong to enclave-5d. Tests
belong to enclave-99. This directory copies none of their files: it pins them by commit and hash.

**What this box is.** Tier `T0-hv`: a Ryzen with no SEV-SNP and no VMPL. The root partition can read every guest's
memory. Nothing served from this package is attested, verified or host-excluded capacity, and every script and record
says so.

## Two profiles, one monitor image

| profile | boots | needs from the host | serves the app through |
|---|---|---|---|
| `igvm` (the target) | `guest/openhcl-ownguest.bin`: an OpenHCL IGVM whose VTL0 is the monitor image | the Hyper-V role: `vmms`, `root\virtualization\v2` with `FirmwareFile`, `Get-VM` | the manager's WMI launcher boots it. Loading a bundle into it needs the datapath (slot `control.datapath`) |
| `hcs-dev` (development) | `guest/wsl-kernel` + `guest/mon.cpio.gz` under the box's `vbslike-host lab` | Virtual Machine Platform only | the launcher itself (hv_sock load + TCP relay). `win/smoke-hcs.ps1` runs it end to end |

`guest/mon.cpio.gz` is the IGVM's VTL0 initrd AND the hcs-dev initrd. `pkg.mjs verify` refuses a manifest in which the
two differ. `check.ps1` reports each profile's host state live. The manifest states only what each profile needs.

## Manifests

| version | id (sha256 of the file) | guest | apps | datapath |
|---|---|---|---|---|
| 1 | `6cdaf629…` `manifests/nucbox-ownguest-1.json` | IGVM `2d735376…` around monitor `44abb52b…` (isolation/m3 at `3c077840`), WSL kernel `7fe3edb5…`, manager `8327498e` | hello-world 1.0.4 (`/1`, AppID `9c3d10f1…`), hookbin 0.1.4 (`/2`, not servable) | empty |
| 2 | `197a9e3d…` `manifests/nucbox-ownguest-2.json` | IGVM `7caf7408…` around monitor `4610d594…` (isolation/m3 at `aef54ff7`: `/2` run mode, readiness, a launcher-named certificate name), WSL kernel `7fe3edb5…`, manager + judge-hv at `261e5f03` | the same two; hello-world's answer pinned to the byte (`"Hello World!\n"`, `03ba204e…`) | `datapath.mjs` `d0a57f6a…` at `67354f3b` (nothing on the box imports it yet) |
| 3 | `f0f516e4…` `manifests/nucbox-ownguest-3.json` | as v2; the launcher's provenance recorded (built from `ef1b2077`, one untracked uncompiled `monitor.rs` present; BEHIND `c5eb2f4a`, so `/2` bundles fail at its `load`); the image a judge expects is the initrd on hcs-dev and the IGVM on igvm | as v2 | `datapath.mjs` `b187da9e…` at `09b67414` (ids are any safe token) |
| 4 | `10139942…` `manifests/nucbox-ownguest-4.json` | as v3; manager + judge at `f4f10c84` (the VM is created with `-GuestStateIsolationType OpenHCL`, Secure Boot off; `ready.mjs`); launcher `57d8c035…` from `55494efa` (loads `/2`), nightly toolchain and build root pinned; `AllowFirmwareLoadFromFile` is a gating igvm host check | as v3 | as v3 |
| 5 | `ac8d68b2…` `manifests/nucbox-ownguest-5.json` | as v4; manager + judge at `6d6c289e` (`ready.mjs` without defect 10; `/vms` speaks guestd's contract: 201, `status`, `boundary`, `relay`, `domainId`, `guestPort`, `image`) | as v4 | `datapath.mjs` `2db32e0a…` at `b339e9d4` (admits on `transportKeySha256`); caveat: the manager does not populate `transportKeySha256` yet, so the datapath refuses to admit |

A manifest is never edited after it is committed. A changed guest, app or tool is a new version with a new id.

**v1 is defective. Use the latest (v5).** v1 pins hello-world's answer as `"Hello World!"`. That answer was never observed: it was
copied from a client that trims. The app answers `"Hello World!\n"`, so v1's serve checks would fail on a correct
answer. The current verifier refuses v1 at that pin. `--serve`, which serves the component under the pinned runtime and
compares the exact bytes, is the check that would have caught it. The rest of v1's pins stand for the old guest.

**v2 and v3 carry a stale manager.** Their manager creates the VM without a guest-state isolation type. Hyper-V then
accepts the IGVM pin, reads it back, starts the VM, and never loads the image, with no diagnostic anywhere (measured by
enclave-d1). Every file still hashes to its pin, so the verifier asks the manager's own code: `win/manager-check.mjs`
runs its `start()` against a recording fake host and reads the `New-VM` it issues. The current verifier refuses v2 and
v3 at that check.

## Reproduce and verify (warden-host)

```
node windows/vbslike/pkg/pkg.mjs verify windows/vbslike/pkg/manifests/nucbox-ownguest-5.json --rebuild --fetch https://ipfs.enclave.host --serve --tests
node --test windows/vbslike/pkg/pkg.test.mjs
```

`verify` derives every pin from its source. It does not take the pin from the manifest's say-so:
- **Pinned bytes.** Git objects at their commits, the files on this host, and canonical JSON written from the manifest
  itself.
- **Apps.**
  - The component is the content its CID names.
  - The record hashes to its recordSha256 and names that CID and the guest's runtime.
  - The bundle is derived twice, by `derive_reference.py` and by the manager's own `derive.mjs` at its pinned commit,
    and both derivations hash to the AppID.
  - A spawn request carries exactly the record.
- **Runtime.** The runtime identity recomputes to `runtimeId`.
- **Tier.** It says T0-hv, host not excluded, no SNP, no VMPL.
- **Servable.** An app is marked servable only on the derivation the pinned manager serves.
- **`--rebuild`.** Makes the VTL0 vmlinux from the WSL bzImage (`vtl0-vmlinux.sh`), then the IGVM from the pinned
  openvmm `a7b0bd4` VTL2 pieces, that vmlinux and the monitor initrd (`build-ownguest.sh`, igvmfilegen only). This
  takes seconds and starts no compiler.
- **`--fetch`.** Fetches each component by CID.
- **`--serve`.** Serves each servable `wasi:http` app with this host's wasmtime, which must be the version the runtime
  identity names. The answer must be the pinned bytes.
- **The judge.** It loads from the package's own files, laid out as shipped, and rejects a document that is not one.
- **The igvm manager.** Run on a recording host, its own `start()` must issue `New-VM -GuestStateIsolationType` OpenHCL
  or TrustedLaunch.
- **`--tests`.** Each functional test the manifest pins runs INSIDE the package's own `control/` tree, as shipped, so its
  relative imports resolve to the package's bytes. These are other lanes' tests, pinned by commit. Each must give
  exactly its stated result: the counts, and which cases fail. v5 pins enclave-99's `readiness-rule.test.mjs` against
  the manager's `ready.mjs` (8/8), and its `datapath.test.mjs` against 5d's datapath (5/5). The same readiness test on
  v4's manager gives exactly 4 failures (cases 3, 4, 5 and 8 = defect 10). The suite holds that result too, and refuses
  a green claim for it. A pinned test is a known result, not a green count. The result includes which cases SKIP and why: a skip the pin does
not declare, or a skip for another reason, fails the pin. Otherwise a case that quietly stops running would read as a
pass in the counts. Todo and cancelled cases must be zero unless declared. A test run under another test runner must
  strip `NODE_TEST_CONTEXT`, or the child reports in a binary protocol and no counts can be read.

The test suite has 42 cases. It breaks one claim per case, including consistent forgeries where the edited entry is
re-pinned to its new bytes. Each case must FAIL at the check that covers it, and the two controls must PASS. The
sources live in `~/enclave-bench/ownguest-pkg/sources/`, and the tests skip without them.

`vbslike-host.exe` is the one box-only file. enclave-d1 built it on the box. It is pinned by observation and cannot be
reproduced here.

## Put it on the box (read `win/*.ps1` first: they state what they write)

```
node windows/vbslike/pkg/pkg.mjs pack windows/vbslike/pkg/manifests/nucbox-ownguest-5.json ~/enclave-bench/ownguest-pkg/out
windows/vbslike/pkg/push.sh ~/enclave-bench/ownguest-pkg/out/<id16> minipc-zt
```

`push.sh` sends only the small files, into a NEW `C:\Users\claude\vbs-like\pkg\<id16>\`. Then, on the box, with the full
id taken from the commit and not from the box:

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\vbs-like\pkg\<id16>\win\stage.ps1 -ManifestSha256 <id>
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\vbs-like\pkg\<id16>\win\check.ps1 -ManifestSha256 <id> -Fetch
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\claude\vbs-like\pkg\<id16>\win\check.ps1 -ManifestSha256 <id> -SelfTest
```

**`stage.ps1`** does three things:
- it copies each `boxReuse` file (the IGVM, the monitor initrd, the WSL kernel, the launcher) from the box's existing
  copy, only after that copy hashes to the pin;
- it grants `S-1-5-83-0` read on the IGVM (without that grant the launch fails with 0x80070005);
- it verifies everything and writes `staged.json`.

**`check.ps1`** re-verifies the package and runs the self-test, which requires 9 cases to give their expected result.
It reports each profile's host checks as ok or `BLOCKED`, never as a package failure. `HOST CHECKS PASS` is only what
those read-only checks see: whether a profile BOOTS is shown by running it. A setting someone suspects matters, but
whose role is not established (v3: `AllowFirmwareLoadFromFile` for the igvm profile), is printed as `info` and never
gates anything. A setting MEASURED to gate a profile (v4: `AllowFirmwareLoadFromFile`, which Hyper-V names in event 5142)
is a real check: absent means `PROFILE igvm BLOCKED by AllowFirmwareLoadFromFile`. No script sets it; that is the host
owner's decision. `check.ps1` also runs the manager check on the package's manager. `-ManagerDir <dir>` runs it on
another copy too, such as the one actually running, and reports which of its files match the package's. It then prints the manager's
environment for `igvm` and the smoke command for `hcs-dev`. `-Require igvm` exits 3 when that profile is blocked.

**Limits.** None of these scripts enables a feature, changes a host setting, reboots, or writes outside the package
directory. They never touch `C:\Users\claude\vbs\node` or `\vbs\ee`.

## Boot, then serve (the box owner runs these: they start VMs)

**hcs-dev, today.** `win\smoke-hcs.ps1 -ManifestSha256 <id>` runs these steps:
1. It verifies the package.
2. It starts `vbslike-host lab` on the package's kernel and initrd. The launcher's ready line must name those two hashes.
3. It `load`s the bundle. The monitor's own hash of what arrived must be the AppID.
4. On its own TLS sessions to `127.0.0.1:<tcpPort>` it polls `/.well-known/enclave-ready` until the guest says ready for
   this app.
5. It fetches `/.well-known/enclave-attestation` for a fresh nonce. `win\judge-run.mjs` then judges the document with
   the package's judge-hv, against THAT session's certificate key, the launcher key from the ready line, and the
   `vmId` from the load answer.
6. It GETs `/` until it receives exactly the pinned bytes.
7. It requires every request to have seen ONE certificate.
8. It always ends with `destroy` + `quit`.

"Running" is ready + `monitor-signed` + the pinned answer, all on one certificate (isolation/m3/HV-GUEST.md). On this
tier, `monitor-signed` means the document is signed by the launcher in the root partition, and the host is NOT
excluded. The record goes to `runs\hcs-<utc>\` (`smoke.json`, `evidence.json`, `transcript.txt`).

**igvm.** Start the manager with the environment that `check.ps1` prints, then `POST
apps\hello-world-1.0.4\spawn.json` to `127.0.0.1:8091/vms`. The console should say `MON ready control_port=9000`.
Serving needs a datapath that loads the bundle into the IGVM guest. v2 pins enclave-5d's `datapath.mjs`, but nothing
on the box imports it yet. The package ships judge-hv, `isolation/m2/judge.mjs`, `relay/snp-verify.mjs` and
`isolation/contract/runtime.mjs` under `control/`, in the repository's own layout, so the manager's readiness judge
resolves them from `control/windows/vbslike/manager/`.

**Checking an answer from any stack.** `check.ps1 -Phase serve -Boot <profile> -Url <url> -LoadJson <launcher answer>`
ties the answer to the package: it requires the guest's own `appSha256` to equal the pinned AppID, and the answer to
equal the expected one.

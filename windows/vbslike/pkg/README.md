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
| 6 | `ce02a547…` `manifests/nucbox-ownguest-6.json` | as v5; manager + judge + node client + lifecycle at `72c82fc6` (the spawn path judges readiness with the runtime IDENTITY, read by `main.mjs` from `ENCLAVE_RUNTIME_IDENTITY`; `image` from the launcher's ready line) | as v5; eight functional suites pinned (enclave-99's seven + enclave-5d's datapath suite), all measured green | as v5 |
| 7 | `f4cbffee…` `manifests/nucbox-ownguest-7.json` | as v6 (manager `72c82fc6`; enclave-d1's later `0b49f6b6`/`5a8a33e7` are not pinned) | as v6; enclave-5d's datapath suite now RUNS its interop case (5/5, no skip) | + `node-bridge.mjs` `b1483afa…` and `supervisor-splice.mjs` `88e688cd…` at `e7ec6521` (ws loaded lazily); imported by nothing on the box until d1's appzone/host/main hooks land |

**Drafts.** `drafts/` holds a prepared next version that is HELD (its `status` says why). It is verified like any
manifest, but it is not a release and is not staged on the box. When it is released, it moves to `manifests/` unchanged.
- **v8 draft** (`drafts/nucbox-ownguest-8.json`): enclave-d1's node at `d1f4b745`, enclave-5d's `node-bridge.mjs`
  `4cb8d54f`, enclave-99's suites at `1d6d9b60`, and the catalog versions as read on-chain. It is held until enclave-5d's
  phase 3 passes against the real node. 5d measured the real node path failing (d1's gate order). Nothing is served.

A manifest is never edited after it is committed. A changed guest, app or tool is a new version with a new id.

**v1 is defective. Use the latest (v7).** v1 pins hello-world's answer as `"Hello World!"`. That answer was never observed: it was
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
node windows/vbslike/pkg/pkg.mjs verify windows/vbslike/pkg/manifests/nucbox-ownguest-7.json --rebuild --fetch https://ipfs.enclave.host --serve --tests
node --test windows/vbslike/pkg/pkg.test.mjs
```

`verify` derives every pin from its source. It does not take the pin from the manifest's say-so:
- **Pinned bytes.** Git objects at their commits, the files on this host, and canonical JSON written from the manifest
  itself. A `repo` source (the package's own scripts) is read at THE MANIFEST'S OWN COMMIT, because a manifest is
  committed together with its scripts. So a committed manifest keeps verifying after the scripts move on. A manifest
  still being authored reads the working tree.
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
- **The node's record builder, against the catalog** (manifests with `catalogFacts`, from v8). The manifest records each
  app's catalog version as read from the chain, with the chain, block, address book and catalog. The shipped
  `node-bridge.mjs`'s `isolationPlan` builds the derivation record from those facts, as the node does at spawn time. That
  record must equal the pinned record as canonical bytes, not field by field. Field by field would miss a builder whose
  fields are all present and well-formed but wrong: enclave-d1's hand-built record took `memMiB` from the node's
  `cpuFallback` floor and `catalog.app` from a label, which gives another AppID than the Linux tier. The package's
  records were never affected; they are the Linux tier's own.
- **`--tests`.** Each functional test the manifest pins runs INSIDE the package's own `control/` tree, as shipped, so its
  relative imports resolve to the package's bytes. These are other lanes' tests, pinned by commit. Each must give
  exactly its stated result: the counts, and which cases fail. v5 pins enclave-99's `readiness-rule.test.mjs` against
  the manager's `ready.mjs` (8/8), and its `datapath.test.mjs` against 5d's datapath (5/5). The same readiness test on
  v4's manager gives exactly 4 failures (cases 3, 4, 5 and 8 = defect 10). The suite holds that result too, and refuses
  a green claim for it. A pinned test is a known result, not a green count. The result includes which cases SKIP and why: a skip the pin does
not declare, or a skip for another reason, fails the pin. Otherwise a case that quietly stops running would read as a
pass in the counts. Todo and cancelled cases must be zero unless declared. A failing case can be pinned
with its EXACT message (`{case, message}`), so a case that fails for another reason fails the pin. A test that reads
repository data (contract vectors, the launcher's source) names it as `support`: pinned inputs placed at their repo
paths for the run, never shipped. An npm dependency a test imports is pinned the way npm pins it: the
lockfile's tarball, checked against its sha512 `integrity` as well as our sha256. It is unpacked into the test tree
(`unpack: "npm-tgz"`) and never shipped. A test run under another test runner must
  strip `NODE_TEST_CONTEXT`, or the child reports in a binary protocol and no counts can be read.

The test suite has 50 cases. It breaks one claim per case, including consistent forgeries where the edited entry is
re-pinned to its new bytes. Each case must FAIL at the check that covers it, and the two controls must PASS. The
sources live in `~/enclave-bench/ownguest-pkg/sources/`, and the tests skip without them.

`vbslike-host.exe` is the one box-only file. enclave-d1 built it on the box. It is pinned by observation and cannot be
reproduced here.

## Put it on the box (read `win/*.ps1` first: they state what they write)

```
node windows/vbslike/pkg/pkg.mjs pack windows/vbslike/pkg/manifests/nucbox-ownguest-7.json ~/enclave-bench/ownguest-pkg/out
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

**Environment.** From v6 on, the manager takes the runtime IDENTITY: `ENCLAVE_RUNTIME_IDENTITY` points at this
package's `guest\runtime.json`, and `check.ps1` prints it. The manager (`72c82fc6`) refuses to start with only
`ENCLAVE_RUNTIME_ID`. The env blocks printed by v1-v5 are for their own managers.

**`-Fetch`, v1-v5.** Their `check.ps1 -Fetch` let Python write `control\windows\node\__pycache__\` into the package,
so a later plain check failed for an extra file. v6 runs the fetcher with `python -B`. The stray directories were
removed from every staged package on the box.

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

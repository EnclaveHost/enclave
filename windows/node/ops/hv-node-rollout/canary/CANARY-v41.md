# v41 candidate canary on the NucBox (252602c8, initrd 41cacbc8 = guest source 4cdd5169): what to run, what to see

For enclave-d1's isolated lab manager on nucbox-k11 (own instance prefix and ports, `uefi-probe.lock` held, the candidate as
an explicit override). Everything here is SYNTHETIC: no tenant data, no production deployment. Nothing is improvised on the
box. Both sentinel bundles are staged, with their sources and hashes.

Tools in this directory:
- `console-read.ps1 -VmName enclave-app-<instance> -Seconds <n> -OutFile <file>`: READ-ONLY capture of the partition's
  COM1 console (MON/DOM lines), raw bytes to a file. Start it right AFTER wmiserve's `launcher` step: the launcher holds
  the pipe until the monitor's `MON ready`, and this retries the attach for `-WaitSec` (60 s) so it never races it.

The sentinel app, staged on the workstation (copy it to the box's lab directory):
- `~/enclave-bench/canary-v41/sentinel-SNTLa67d9469ffe1.bundle`, sha256 / AppID
  `2609d1f4605d8b4a83625de1c509f561ea16e3692f5a930b2125cbeb59556fbc`, 194300 bytes. It is enclave-catalog-bundle/2
  (wasi:cli, run mode, HTTP 8000, mem 128), the same bundle the Linux output check ran
  (isolation/m2/lab-release/run-output-check.sh, 2026-09-25b), built from `isolation/m2/lab-release/sentinel-app` with
  `SENTINEL_TAG=SNTLa67d9469ffe1`. This tag has never been on the NucBox.
- What it prints (to ITS stdout/stderr, which must never reach the console):
  - `SNTLa67d9469ffe1-STDOUT-START` / `-STDERR-START` at start;
  - `SNTLa67d9469ffe1-STDOUT-REQ <path>` / `-STDERR-REQ <path>` per request;
  - on `GET /panic…` it panics with `SNTLa67d9469ffe1-PANIC <path>` (the runtime prints the panic and the trap on stderr).
  Every request is answered `200 ok` (Content-Length 2, Connection: close).

## 1. domexec's app-stdio discard (the tenant runtime gets /dev/null)
1. Load the sentinel through the lab manager / wmiserve (`--bundle <sentinel>`, label e.g. `canary-sentinel`; no cert name
   is needed). Start `console-read.ps1 -Seconds 180` right after the launcher step.
2. Through the relay: `curl.exe -sk https://127.0.0.1:<relay port>/req-SNTLa67d9469ffe1-1`, then `-2`, then
   `/panic-SNTLa67d9469ffe1-3`.
3. Wait for the capture to end. Grep, in PowerShell:
   `Select-String -Path <console file>,<lab manager log>,<wmiserve output> -SimpleMatch 'SNTLa67d9469ffe1'` must find
   **nothing**.
   The console must also hold only MON/DOM lines (and kernel `[ t.tttttt]` lines):
   `Get-Content <console file> | Where-Object { $_ -and $_ -notmatch '^(DOM|MON)' -and $_ -notmatch '^\[\s*\d+\.\d+\]' }`
   must print **nothing**.
4. **Positive markers** (the capture saw this domain; a zero above is not a blind spot):
   - `MON domain <n> loaded label=canary-sentinel app_sha256=2609d1f4… … mode=run http=8000`;
   - `DOM<n> started runtime=<pid> front=<pid> mode=run http=8000 (/data 64 MiB scratch)`;
   - `DOM runtime wasmtime/48.0.1 execution=jit …` and `DOM runtime selftest …`;
   - `DOM certificate: no HOST_DATA to name this domain (…); self-signed only`;
   - `DOM serving … spki_sha256=… ready_ms=…`;
   - the two `/req…` answers are `200` with body `ok`;
   - after `/panic…`: `DOM<n> ERROR runtime exited status=…`, `DOM<n> end`, `MON domain <n> ended: …`.
5. CONTROL, recommended: the same bundle on the v40 IGVM (b7ba7731). Its domexec gives the app the console, so the
   same grep finds `SNTLa67d9469ffe1-STDOUT-START` / `-REQ …`. That proves the capture would see a leak.
PASS = step 3 empty, AND every marker in 4 present.

## 2. The console guard: an upstream that answers HEAD with a body, or sends bytes after Content-Length
The keep-alive sentinel, staged on the workstation:
- `~/enclave-bench/canary-v41/sentinel-keepalive-SNTLkaea192ee7f6.bundle`, sha256 / AppID
  `9a79c076f1d0c9660131d55eecc1d86dc98bb476e5c4050fcb0e45c76462b0c5`, 195261 bytes, bundle/2 (wasi:cli, run mode,
  HTTP 8000, mem 128), tag `SNTLkaea192ee7f6`.
- Source: `canary/sentinel-keepalive/` (this directory). Built with `SENTINEL_TAG=SNTLkaea192ee7f6 cargo build --release
  --target wasm32-wasip2` (wasm sha256 139ad2c9…), and bundled with the guest's own contract tool at 4cdd5169:
  `go run ./cmd/bundle build -label sentinel-keepalive -world wasi:cli -http 8000 -mem 128`.
- It is the sentinel, plus two answers WITHOUT Connection: close:
  - `GET /extra…`: Content-Length 2, body `ok`, followed by `<tag>-EXTRA <path>`;
  - `HEAD /head…`: a body `<tag>-HEADBODY <path>`.
- Proven on the workstation (wasmtime 48.0.1 + Go's net/http client, which is what the front's reverse proxy uses
  upstream): Go logs `Unsolicited response received on idle HTTP channel starting with "SNTLkaea192ee7f6-EXTRA
  /extra-probe"` and `... "SNTLkaea192ee7f6-HEADBODY /head-probe"`. That is the leak the guard exists for; unguarded,
  those lines would go to the console.
Run:
1. Load it like item 1 (label `canary-keepalive`), with `console-read.ps1` started after the launcher step.
2. `curl.exe -sk https://127.0.0.1:<relay>/extra-SNTLkaea192ee7f6-1`, then `curl.exe -sk -I
   https://127.0.0.1:<relay>/head-SNTLkaea192ee7f6-2` (each answers 200), then a plain `/req-SNTLkaea192ee7f6-3`.
3. Expected on the console: `DOM front: unsolicited upstream response (N bytes withheld)`, once per event (two).
4. The grep of item 1 for `SNTLkaea192ee7f6` over the console, the manager log and the wmiserve output must be EMPTY.
   That also covers `-EXTRA`, `-HEADBODY`, and the app's own REQ/START lines.
PASS = both class lines present, and the tag nowhere.

## 3. The release client is inert on hv
On this tier the front is started WITHOUT `-init-fd` (domexec.c: the serve and run argv), so the release step
(`releaseForInit`) never runs. No vsock ticket dial is made, and nothing waits on one.
- Expected: **no `DOM release:` line at all** for any domain. `DOM serving` follows `DOM certificate: …` within the same
  second or two (`ready_ms` small).
- FAIL: any `DOM release` line (the front took an M2 path), or no `DOM serving` within the load's deadline.

## 4. probe:true only for a probe domain
- A probe domain is loaded with `"probe": true` in the monitor's `load` request. On the box that is the HCS lab
  launcher's `LoadRequest.probe` (launcher.rs, as in your run 091720). wmiserve has no probe flag.
- Expected for a PROBE load:
  - the monitor's answer (the domain record) carries `"probe": true`;
  - the console shows `DOM<n> started adversary probe=<pid> (no app, no front)`, then
    `DOM<n> probe workload_uid=… sys=… configfs=… domains_dir=… own_app=… visible_pids=…` and
    `DOM<n> report_as_root=…`.
- Expected for a NORMAL load: the answer has NO `probe` key (`omitempty`), and the console shows
  `DOM<n> started runtime=… front=…`.

## 5. A front runtime throw ends the front (it does not hang on the console)
COVERED WITHOUT A BOX RUN (enclave-87's decision). The production front has no trigger: no debug route, no flag that
throws. A debug front would be a different initrd, so a different IGVM measurement: not a release candidate. The
evidence is 4cdd5169's bounded-exit regression test `TestARuntimeThrowUnderTheGuardStillExits`
(isolation/m2/front/console_test.go): fd 2 is non-blocking under the guard, so a Go runtime throw exits instead of
hanging. enclave-bf reproduced it: removing `SetNonblock` fails that test. If a front ever exits on the box, the
observable is `DOM<n> ERROR front exited status=…`, then `DOM<n> end` and `MON domain <n> ended: …`.

## 6. The cert name (v42 set: exe 10547aca, manager at windows/m4-cert-name, monitor 4cdd5169)
Load with `--cert-name <id8>.app.enclave.host` (a real-looking id8 is fine in the lab; it is never issued).
- wmiserve's `load` step reports `"certName":"<id8>.app.enclave.host"` (the monitor echoed it).
- The console: `DOM certificate: this domain may certify <id8>.app.enclave.host (named by the launcher at load: no
  HOST_DATA here, so this is the launcher's word, T0-hv)`.
- Through the relay: `GET /.well-known/enclave-csr` → 200, a PKCS#10 for CN and SAN `<id8>.app.enclave.host`, whose key
  is the domain's TLS key (compare `openssl req -pubkey` with the served certificate's SPKI).
- Without `--cert-name`: `DOM certificate: no HOST_DATA to name this domain (…); self-signed only`, and enclave-csr
  answers 404.
- A malformed name (`4E62E60D.app.enclave.host`): wmiserve refuses it before any spawn (exit 2).
The 41cacbc8 initrd (4cdd5169) carries all of it: the monitor's certNameOK, `/cert.name` (0444, in the domain's chroot),
domexec's `-cert-name-file /cert.name` and the front's launcherName.

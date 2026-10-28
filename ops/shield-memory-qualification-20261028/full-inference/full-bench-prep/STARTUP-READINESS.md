# Startup readiness barrier before the first attested request

Source only. No command, VM, GPU, network, production or wallet action was taken to
write this; the offline fixtures in `test_fullbench.py` were written but **not run**
here.

## What full-smoke-fw-r1 shows

- `serial-0-A.log`: boot, `MODEL verified ... copy_verify_ms=29223`, front lines,
  `DOM app config: none`, `DOM seccomp: app filter installed (sha256 d4d17c9f..., 71 rules)`,
  `DOM started app=216 front=210 at_ms=36643`,
  `DOM serving vsock=443 spki_sha256=ae2aa7dd... ready_ms=36675`. No `DOM ERROR`,
  no `DOM end`, no `selftest FAILED`. So there is **no sign that the app exited or
  failed** before cleanup.
- `client-0-1-fixture-0.out`: the runtime identity, SPKI binding, VMPL and
  measurement fields are all present. The verdict is
  `reject ... runtime self-test covered NO runtime process (runtime=0)`. The
  self-test is `exec_pages=allowed wx=clean maps=4 runtime=0 root=4 scope=all-processes`,
  which has **no `seccomp=` field**. Also `app_requests_sent=0`, `gate=closed`.
- `receipt.json`: `request_failed` and `cleanup: clean`. The fixture step was
  the first request. It started right after the fwd's first line, and it
  finished 46.9 s after the guest unit was created (`first_probe_s` 46.99).
- `fwd-0-A.out`: one relayed connection.

## Source facts (installed iso-sdshield-1c3cdbb8)

- `front/main.go:178`: the front calls `vsock.Listen(443)` **before** the
  init-pipe provisioning at `main.go:246`. Init forks the app only after that
  pipe message (`dominit.c:698` → `spawn_app` at `dominit.c:729`).
- `spawn_app` reads the seccomp-statement pipe until the child's exec closes it.
  It writes the statement file, and only then does init print `DOM started`
  (`dominit.c:738`). Once `DOM started` is on the serial, the app has exec'd as
  APP_UID under its filter.
- `main.go:396` runs `localSelfTest` **for each attestation document**. Each run
  is a fresh `/proc` scan, and the statement file is read at that moment
  (`runtime.go:107-170`). A scan made before the app execs finds only root
  processes and no statement file. That gives exactly `runtime=0` and no
  `seccomp=`.
- `DOM serving` is printed from a goroutine (`main.go:291`). The front can
  already accept connections before that line, and before the app starts.

## Cause hypothesis and its limits

**Hypothesis:** the first client connected inside the window between the front
listening and the app's exec. The fresh self-test then covered no runtime
process.

This fits every observed field. Still, it is **not proven to be the sole cause**:

- Neither the serial nor the client output has a timestamp for when the
  document was issued. Guest `at_ms` and host monotonic time share no clock, so
  the order can only be inferred.
- `root=4` is consistent with init + front + shield helper + pad-spill minter,
  or with the forked child before it dropped uid. Either reading fits the race.
  Neither proves it.
- I did not rule out a scan that runs after `DOM started` but still misses the
  app (a cgroup/uid view problem). If the barrier is in place and the first
  verdict is still `runtime=0`, this hypothesis is **wrong** and that path is
  the next suspect.

## Exact changes (harness and fixtures only)

`fullbench.py`:

- New regexes `DOM_SECCOMP`, `DOM_STARTED`, `DOM_SERVING` and `DOM_FATAL`
  (`DOM ERROR...` / `DOM end`), plus `READINESS_SIGNAL`, `STARTUP_READY_SEC = 180`
  and `SERIAL_HEAD_CAP = 8 MiB`.
- New `startup_markers(text)`. It reads complete lines only and returns `None`
  until both `DOM started` and `DOM serving` are present. It fails closed
  (`Stop`) on any `DOM ERROR` or `DOM end`. It also fails closed when
  `DOM started` comes before init's seccomp line (init prints these
  sequentially), on a duplicate `DOM started`, and on malformed pids. `serving`
  may come before or after `started`, because it is printed from the front's
  goroutine. The order seen is recorded.
- `run_arm`: after `fwd_first_line`, the harness runs
  `wait_for(..., app_started, STARTUP_READY_SEC, "startup_readiness")`. This is
  the existing bounded wait, so the **full watchdog** (wall deadline, production
  guests, owned identity, guestd probe, GPU, MemAvailable) still ticks every
  second. Timeout → `stopped:timeout:startup_readiness`, and no client is
  started. A serial over 8 MiB → `stopped:serial_oversize`. The receipt gains
  `startup_readiness` (pids, guest ms, `waited_s`, the untrusted-signal
  statement) and `serial_dom_errors` (up to 8 fatal lines, for diagnosis).
- These are unchanged: `client_argv` (measurement, app-sha, runtime pin, VCEK,
  `--min-tcb`, trusted mode), `parse_client` (`VERDICT attested` + 200 + pinned
  key + body), the experimental firmware pair, the root machine guard, the qemu
  invariants and cleanup. There is **no retry**: one reject is still
  `request_failed`. The barrier only delays the first request. It never sends
  one without a fresh client verification, and it never replaces attestation.
- The measured guest, dominit, front and client are untouched.

`test_fullbench.py`:

- FakeHost now writes the real-order startup serial to the guest's `-serial`
  file. `client_out` is configurable. Existing tests keep their assertions.
- New `StartupReadiness` fixtures:
  - real-order parse, partial line, and serving-only / started-only;
  - no client popen until both markers;
  - missing markers → timeout, no request;
  - missing serial file → timeout;
  - `DOM ERROR` / app exit / `DOM end` → fail closed;
  - order, duplicate and malformed → fail closed;
  - the watchdog yields to production during the wait;
  - a reject after ready is not retried.

## Still to do

- Run `python3 -m unittest test_fullbench test_root_review test_experimental_firmware`
  offline.
- A fresh plan and root approval are needed before any real run. The plan JSON
  is unchanged, but the helper's behaviour changed.

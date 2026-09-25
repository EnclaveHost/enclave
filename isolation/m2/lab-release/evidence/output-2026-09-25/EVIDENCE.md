# App output never reaches the host: real SEV-SNP, with a positive control (2026-09-25 19:49-19:50Z, PASS)

Codex's decision: the app's stdout/stderr (PID 1's, the serial console, a file the HOST reads) must stop reaching the
host before real tenant secrets are released on this tier. 77cf2d78 gives the app child /dev/null for fds 0-2 (dominit
`spawn(..., quiet=1)`); the front keeps the console for its `DOM ...` control lines.

Run: `~/enclave-bench/lab-release/output-run-20260925a`, by `isolation/m2/lab-release/run-output-check.sh` at ae9e3954.
The tree is 77cf2d78 plus the lab script. The run's tag was SNTL06a9cfaf2446: synthetic, and in every sentinel.
- **The app** is `sentinel-app` (Rust, wasm32-wasip2, a wasi:cli command serving HTTP on 8000). It prints tagged
  sentinels on stdout AND stderr at start, and per request with the request path (tenant data). It panics on `/panic…`,
  and the runtime prints the panic.
- **NEW guest `lb2807451d`** runs this tree's image. It is a non-deployment guest: `DOM release: none (this guest's
  HOST_DATA names no deployment)`, which is ecf02384's wording, so this is the new front.
- **OLD guest `lb14c53694`** is the POSITIVE CONTROL: 0181bce3's image (legacyImage true), the same app, on the same
  lab guestd.

## Result
- **The control leaks, so the check can see a leak.** The OLD guest's serial shows `…-STDOUT-START`, `…-STDERR-START`,
  `…-STDOUT-REQ /req-…-old` and `…-PANIC /panic-…-old` (`serial-old.txt`: synthetic sentinels only).
- **The new image leaks nothing.** The NEW guest's serial (`serial-new.txt`, 919 bytes) holds no tagged line. It keeps
  every control line: `DOM serving`, `DOM started app=80 front=77`, `DOM app config: none`, and, after the panic,
  `DOM ERROR app exited status=134` and `DOM end`. The front's own line for the failed request is
  `DOM proxy: GET unreachable`, d1a38994's bounded form.
- **The requests sent ONLY to the new guest** (`/req-SNTL06a9cfaf2446-new`, `/panic-SNTL06a9cfaf2446-new`) appear
  NOWHERE on the host: 0 files in the run dir (the app binary, bundle, cargo dir and legacy archive excluded) and 0 lines
  in the whole user journal since the run began.
- **guestd's view of the failed NEW guest** says only `"error":"the guest exited"` (`vm-new.json`).
- **Production** m2-gd* was identical before and after, and cleanup left nothing running.

## What is NOT shown (stated)
- **The journal is not a channel on this host.** Both guests' unit journals are empty, and the whole user journal holds
  NO tagged line from either guest, the control included: QEMU writes the guest console to the serial file only. "No tag
  in journal-new" is therefore not a test of its own. The script now reports it that way (after this run).
- **guestd's log** held no line naming either guest.
- **Config is not a separate case.** No config or secret was involved. The fix is on the file descriptors, so it covers
  anything the app writes, config included, and is not a filter on content.
- **Kernel console messages** at loglevel <= 3 still reach the serial (none appeared here); they carry no tenant data.
- **Owner logs.** This tier has no owner-only log channel, so the app's output is discarded, and owners get no app
  logs from a per-app SNP guest.

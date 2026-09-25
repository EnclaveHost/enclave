# Reconnect in place, attempt 1 (2026-09-25 11:22Z-11:30Z): STOPPED before the VM started -- a harness error, kept as run

**Nothing was exercised.** The harness at 48030dd5 launched the app with `--ei app_serve_s 7200`. The host refuses any
value outside 10..3600 (`HOST FAIL: app_serve_s must be 10..3600`, from logcat). So the app never opened its capture or
started the VM, and the harness stopped at its 400 s wait for the boot attach.
- **Records kept:** the relay's start, the run's pins and the (empty) co-signer journals. The run's own scan found
  neither operator key in the results.
- **The fix:** the harness now passes 3600, the host's maximum. The run needs about 27 minutes of serving.

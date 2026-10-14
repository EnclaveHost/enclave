# App output with the MUSL init: real SEV-SNP, positive control (2026-09-25 20:48-20:49Z, PASS)

`run-output-check.sh` re-run at aa6c985c, where the NEW image's init links musl (m2/build-musl.sh, app-image-template.sh)
and still gives the app /dev/null for fds 0-2. Run `~/enclave-bench/lab-release/output-run-20260925b`, tag
SNTLa67d9469ffe1 (synthetic).

- **The NEW guest `lb7f9cce1a` ran EXACTLY release 79c5ecf2's image.** Its AppID 2609d1f4… and measurement 51f24e25…
  equal `expected-measurement.sh --pin 79c5ecf2…` on its bundle. So the musl init boots on real SNP, reads the front's
  message, starts the app, and powers the domain off when the app ends.
- **The control leaks.** The OLD guest `lb10b36ef5` (0181bce3's glibc image) shows every sentinel in its serial: start,
  the request path, the panic.
- **The new image leaks nothing.** No tag in its serial, its unit journal, guestd's lines or view for it. The requests
  sent only to it appear nowhere on the host. Its serial keeps DOM serving / started / app config: none /
  ERROR app exited.
- **Production** m2-gd* units were identical before and after, and cleanup left nothing running. The production guestd
  holds vsock 9443/9444 since 4d; the lab used 19444/19445.
- As before, the journal and guestd's log carry no guest console on this host, so they are not channels.

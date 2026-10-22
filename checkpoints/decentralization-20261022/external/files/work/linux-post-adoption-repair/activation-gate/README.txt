OPERATIONAL ACTIVATION GATE for the next Linux control activation (prepared by Claude; ROOT REVIEWS AND RUNS; nothing here
was run against production). Adoption is not health: the next activation is kept only through this gate.

Next activation, only after root accepts FINDINGS.txt and the terminal tests:
 0. Build the image from the frozen release 51516b778 + post-adoption-repair.patch ONLY (the same overlay recipe as
    51516b778: tree/metal/overlay-control-image.py over dist-sdshield-2857356cd), through the queue; delta check: only
    app/supervisor.js, app/client/lease-executor-client.mjs and opt/metal/manifest.json differ from 9fcbd925's image.
    New measurement -> additive admission (as before), funding/lease preflight (< 6 min old).
 1. activate.py as for 51516b778 (attach + "[claim] <id> adopted:" for both), but its success state is only
    "adopted; operational gate pending" - it does NOT set productionActivated until step 2 passes.
 2. python3 activation-gate/verify-operational.py --availability <metal0 /availability URL> \
      --app 0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9=https://da09d0f2.app.enclave.host/ \
      --app 0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c=https://9eb4e600.app.enclave.host/ping \
      --since '<activation restart time>' --out activation-gate/result.json
    PASS = for 420 s straight (> guestd's 300 s TTL): both public endpoints answer over TLS, both guests held running and
    OWNED with the SAME guest ids (no respawn), >= 2 successful vouch cycles with neither id unvouched, and no
    respawn/death/lease-lost/reaped/release journal line for either app.
 3. Then "operationally stable; app-paid renewal pending": at each app's next renewal, root's read-only audit must show
    the renewal paid by the app's reserve (never this host's key). Only then is the activation complete.
 ROLLBACK on any FAIL: stop the new control first (no new signed requests), take the pending sponsored deadlines the gate
 printed (and root's own journal reading), restore the previous control only after a verified block's timestamp is
 past the latest deadline (two agreeing RPCs, as root did at 06:41Z); never clear or move a release journal.

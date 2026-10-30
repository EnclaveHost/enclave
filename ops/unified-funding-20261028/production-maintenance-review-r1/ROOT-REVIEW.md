# Root review: maintenance closed before activation

The reviewed session mutation gate was exercised in production and removed with exact owned-route CAS. Original route digest restored, watchdog stopped, relay228946/source unchanged, legacy config200. Installer was staged but NEVER executed. No activation marker, restart, grant, or financial send.

The explicit zero-active-upstream restart check did not pass (aggregate3/6/3). Stable89-mined journal, no expiry20min and relayer latest/pending94 were supporting evidence, not proof of in-memory quiescence. Root aborted rather than relabeling those observations. Later read-only source/stack evidence identifies a3-fleet-upgrade baseline, but still no old-process session drain API. Future restart needs a concrete stop-and-reconcile sequence; do not repeat this operation or reinterpret it as an activation success. Private environment/journals were never exported.

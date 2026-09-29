# Eyesoff startup warmup

The per-app isolated runtime did not honor the authenticated app config's
`warmup` path. The old Wasm manager did; the isolated guest started its app
without calling the hook, so the browser's page-load warmup was the first
request that loaded the model.

The measured front now reads the hook from the attested owner configuration
and calls it once over guest loopback after the app port listens. It runs in
the background. Paths and responses are never logged to the host. Redirects
are disabled, the request has a 15-minute deadline, and response consumption
is capped at one MiB. The app remains available if warmup fails; the console
reports a fixed outcome class. Port readiness is still distinct from model
readiness. Existing idle GPU residency is retained.

Validation: `go test -race ./front` and `go vet ./front` passed. Tests cover
invalid/external paths, delayed-body completion, redirects, HTTP failure and
timeouts.

Candidate release: `e5e1e214162c8ed778383a92d598c638d613c5271105b00631dacc386f4b53ac`.
Only `template/front` differs from the previous `ba14bafd` release.
Production rollout completed. Guest `gd24a6da1e` passed fresh AMD attestation
and normal public WebPKI. All five other app guests kept their IDs and measurements.

Cold-start observation: the stopped guest released both V100 allocations;
the replacement logged `DOM warmup: started`, then filled the cards to
31,279 / 31,305 MiB and logged `DOM warmup: completed`. From the first sampled
warmup-start line, residency was observed after 56.4 seconds and completion after
206.9 seconds (five-second sampling). No manual warmup request was sent.
The already-open browser's resource timing retained exactly its one earlier
warmup request, with identical start time and duration, throughout this test.

Web search was rechecked after rollout: HTTP 200, Exa, six results in 2481 ms,
with page text returned inline. The owner-signed search endpoint config remains
in effect. The runtime change does not alter inference settings or egress policy.


# Router queue and pending-memory distinction

Read-only source review; no fresh remote observation or admission decision. Exact local v13 router SHA-256: `966fd3b5480e9859de4f1dc578b25afa1150e97552437e8c183c03bba4606e6a`, matching the prior recorded installed-file observation. Matching disk source is not proof of every current executing module.

`serial` queues closures. `spawn` performs request validation, inventory snapshot, pool checks and available-memory check only when its closure reaches the head. `journal.begin` then persists the expected physical reservation before forwarding POST to a manager. The pending record remains until the same-epoch manager reservation is observed; timeout, absence or an error response does not automatically clear it.

Consequently, waiting closures with no recorded memory amounts are not by themselves evidence of admitted-but-unaccounted memory. Queued requests that have not passed admission must be distinguished from committed reservations. A safe pending bound must still include the active journal reservation, backend starting allocations not reflected in OS memory, direct launch paths, other accepted commitments and concurrent admissions. Correlated reservations may be deduplicated only with matching identity/epoch; conservative double counting is acceptable.

This source review does not establish P=0 or a complete P bound. The prior 17 GiB router headroom check also does not satisfy the current live 18,432 MiB floor. The actual installed manager's final allocation checks and the interval between intent, reservation and OS reflection must be reviewed with fresh bounded facts. A snapshot alone is not an atomic reservation against future/direct launch. No drain, restart, test or production change followed from this finding.

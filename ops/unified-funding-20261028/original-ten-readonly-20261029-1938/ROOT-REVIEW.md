# Original ten: current read-only observation

At 2026-10-29 19:36:55 UTC, two of three independent RPC providers agreed at Base block 53256631/hash438aab068dab4aa226a8d39194e34454e62d529ea2c036de0e4d5b28d212d5bd. mainnet.base.org failed; the other two agreed. This is a canonical observation, not finality or endpoint-health proof. No wallet, signing, send or state-changing contract method was invoked. Stored output omits app configuration, credentials and private journals.

Original d979 and EyesOff have live leases. Original sia-s3 ef514ed3 now has an enabled200280705555855wei gas reserve but its old lease remains expired. Do not top it up again. This observation does not establish the funding transaction origin or successful recovery; peer is tasked with bounded read-only receipt/host diagnosis. The other seven originals, including a77, have expired leases and low reserves. The separate7ae deployment is outside this exact original-ten scope.

One local small-lane run:256MiB hard/noSwap,220MiB RSS guard,27648MiB floor,one CPU affinity,100second child timeout. Exit0,peak107MiB,minimum available32575MiB; terminal unit and no test tempfiles. No production mutation.

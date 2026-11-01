# Native RPC app controller

This Rust `wasi:cli` executable is the portable controller for the distinct V9
CPU RPC companion. It binds only `127.0.0.1:8000` and talks only to fixed local
Ethereum (18645), Base execution (18545), beacon (15052), and Base node (19545)
ports. It accepts no upstream URL, host command, wallet, lifecycle action or
caller-provided readiness flag. The ordinary catalog preview is separate.

`POST /ethereum` and `POST /base` accept explicit public JSON-RPC methods,
including one `eth_sendRawTransaction` submission. Administrative, engine,
signing, subscription and tracing methods are refused. Notifications are
refused; batches have at most 16 unique string/integer IDs. Parsed requests are
serialized again before transmission. Ambiguous user submissions are never
retried. HTTP connections close after one request; no response cache is used.

Every RPC request first checks both local chains under the same original
10-second deadline used for all socket reads, writes and connects. It checks
chain identity, execution sync status, fresh latest/finalized heads and head
ordering, mainnet EL/CL genesis, consensus sync/optimism/EL availability,
canonical finalized beacon payload, and Base node safe/finalized agreement.
Missing or unsupported observations refuse service. `GET /health` reports
`localReady`, not ledger Running, attestation, storage ownership, complete blob
coverage or reservation release. The native wrapper's separate Base coverage
admission remains mandatory. No controller health result replaces that gate.

Limits: 16 KiB headers, 1 MiB request bodies, 8 MiB response bodies, 64 headers,
16 MiB plus headers wire allowance, sequential processing without thread fanout.
Duplicate framing headers, transfer-encoded requests, compressed content,
noncanonical lengths, folded headers and buffered pipelining are refused.
Upstream Content-Length, bounded plain chunks without extensions/trailers, and
close-delimited responses are supported. Slow clients can occupy the single
worker for up to ten seconds; production throughput is not yet qualified.

The app's measured image, TLS front, accepted runtime, app-owned state mounts,
role isolation, outer owner lifetime and capacity admission must be composed
before deployment. Eight native tests and nine HTTP checks of the compiled
WASI executable passed in a private network namespace with fake local clients.
The checks exercise actual WASI sockets, request forwarding, all three response
framing forms, single transaction submission and readiness refusals. They do
not prove actual client compatibility, chain sync/finality or production RPC.
No default route, catalog transaction or deployment is changed by this package.

The dedicated front requires build tags `native_rpc,bootstrapdirect,shielddirect`.
Legacy, SNP-only, mixed desktop and release-lab RPC front builds fail compilation.
Its loaded V9 bundle supplies the full deployment identity; a framed package for
another deployment is refused even if the first four bytes match. The existing
owner-direct Shield authority verifies the full AppID and RuntimeID, backend and
exact public configuration before owner-committed names are enabled. It does not
need a launcher app-zone name or the Enclave certificate relay. This still uses
the existing bootstrap chain/lease reader; it is not the replacement event-driven
protocol or proof of independent hosting under Enclave refusal.

Both RPC front readiness and its startup serving message require a fresh local
controller `/health` response, with exactly `localReady:true` and chains 1/8453.
Requests use literal loopback, no proxy, redirects or cache, a 512-byte response
bound and an 11-second deadline including body reads. Ordinary/desktop readiness
retains its TCP behavior. The existing front's 120-second startup wait is not an
extension of the enclosing original 900-second deadline. The native entry now starts this front and requires its one-shot private
approval before launching the controller/clients. A complete RPC monitor path
still does not invoke that entry. Package transport connection setup and
bootstrap preparation still require the independently owned outer lifetime;
the frame-read deadline alone cannot interrupt a blocked transport dial. Protected state attachment, monitor/namespace composition and persistent-serving adoption remain
integration requirements. Do not use a successful local health check to waive
those requirements.

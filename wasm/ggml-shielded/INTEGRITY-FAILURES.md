# Recovery after a verification failure

A rejected remote product aborts the current graph before sampling, streaming
or cache insertion. It also retires the link: its secret Freivalds challenges
must not be offered to the peer again after a failed check. Reconnecting a
socket alone retains those challenges and is not recovery.

The caller's monotonic verification-failure counter and an atomic background
pad-integrity flag are the retirement latches. Once either is set, start,
registration, remote compute and local fallback calls
return `SH_ERR_VERIFY` before networking, pad consumption or output writes.
There is no reset operation. A direct C caller must close the failed link and
register a new one with fresh verification state. A diagnostic
`sh_link_verify` call remains a pure check; it does not send data or revive a
retired link.

Cell authentication failure and a failed private `u = r.W` check permanently
retire the link even when discovered by a refill thread. Stopping/joining that
thread clears its scheduling stop flag, but never its integrity flag. The
reported verification-failure count includes one event for pad retirement.
A startup integrity failure also retires the GGML backend; it is not classified
as a retryable bank shortage. The caller checks again after waiting for pads,
so a rejection during that wait reaches the backend as `SH_ERR_VERIFY`.
An ordinary missing shipment remains exhaustion and does not set this latch.

The GGML backend similarly stops every later graph, including other cards,
before graph planning when any card has recorded an integrity failure.
Its shared pool lives for the process, so restart the trusted engine and rebuild
its contexts to recover. Do not retry generation on partly executed contexts.
Verification failures from the local authenticated fallback are also counted
and retire the backend. Existing source/cache authentication failure latches
remain in force.

Ordinary connection errors and malformed protocol frames retain their existing
retry behavior. Invalid local integer input is refused before any mask or
remote verification attempt; the C link alone does not retire for that
precondition failure. No pad taken by a failed exchange is ever reissued.

The regression fixture exercises honest exchanges, transport retries, corrupted
products and wrapped products with fresh links for each integrity-failure case.
After failure it attempts remote/local compute, reconnect and registration and
checks refusal, unchanged output buffers and unchanged pad/exchange counts.
Both wire widths, scalar/SIMD verification, overlap and shared-ring paths are
covered. The actual GGML backend fixture also injects a corrupt authenticated
cache read, restores the storage response, then checks that later graphs
still refuse without reading weights or writing output, including with a
healthy card preceding the failed card. These checks establish the implemented failure policy; they are not a
proof of the entire cryptographic construction.

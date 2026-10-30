# Prepared fallback only; not installed or tested

The host-side 6 GiB proposal remains unexecuted. The shared queue is unchanged at SHA256969d9273e53c79abf8604c363daa58b41a462bc4b7f3d03d813980edb771f6f4 and4GiB maximum. Do not run a larger-cap copy alongside older queue processes: small jobs using the old maximum would under-reserve concurrency. Atomic installation requires draining all existing queue processes and root review.

A better active plan uses already-preallocated spare memory inside the RPC VM, without increasing host memory or stopping apps. These files are preserved solely as unfinished source history, with no passed-test or readiness claim.

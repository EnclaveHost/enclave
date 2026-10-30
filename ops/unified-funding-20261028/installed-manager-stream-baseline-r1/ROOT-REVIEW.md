# Installed-manager TCP compatibility baseline

Three checks passed, zero failed/skipped, against all114 exact installed-source control files from source.zip d2f00b2e8dd7cf564deb37e7ac86da427d9b93d76df787eb45c0b375f7a369b0. Root compared every control file with the earlier installed-manager baseline and verified all117 test/driver/source pins after execution. This package references that frozen control tree and public derive_vectors fixture; it does not include a second copy of the archive.

The tests run the actual Manager, dataPlaneFor, createDataPlane, and composite router dataServer. They use real loopback TCP sockets and an echo transport. Launch/readiness and backend stop acknowledgments are explicitly TEST components, not Hyper-V, TLS, guest attestation, actual protected permits or Windows OS execution.

1. Actual direct splice admits the expected instance/app/image/runtime/key, carries a payload round trip, rejects a wrong key and closes the original stream after explicit removal.
2. The actual composite data router carries the same path. Removing one instance closes its existing connection and refuses a delayed preamble for that instance; another instance continues carrying payloads and remains running until its own removal.
3. A deliberately held TEST backend stop confirms installed LEGACY behavior: both an established connection and a new connection keep carrying traffic while stop awaits acknowledgment; all close once the stop settles. This is an observed compatibility baseline, not a claim that legacy code promises protected authorization expiry. The new explicitly protected path must withdraw traffic before waiting on compute removal, without changing these legacy expectations.

The suite is a reusable comparator for the pending Windows candidate. It does not qualify the new manager, authentication/control route, independent guardian, canonical authority, shutdown under manager death or production migration. No current source or running manager was modified.

Unit enclave-manager-stream-baseline-r1-20261029 / invocation4cfb8c0983954f6aa089f377f03a2cd8 completed rc0 and is inactive/MainPID0. Owned network namespace with loopback only; all sockets/servers closed by fixture cleanup. Shared small lane256MiB, inner RSS220MiB, available floor27648MiB, CPU1/noSwap. Inner peak89MiB/minavailable34384MiB; outer peak139MiB. The separately authorized Claude implementation continued in its large lane; no candidate files were read as qualified or modified.

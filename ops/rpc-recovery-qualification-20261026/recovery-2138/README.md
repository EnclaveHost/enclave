# Recovery diagnostic qualification, 2026-10-26 21:38 UTC

No real recovered-database exposure, integrity acceptance or production cutover yet. Original remains read-only. USB writes/download/production VM boot remain paused; read-only recovery investigation is authorized.

Overlay r8 actual 20+13 tests PASS, including real MDBX validation through a disposable recovered fixture. Independent review found an additional cancellation defect: cleanup must stop a live validator before unmounting. r9 correction and actual original directory-permission fixture pending. Therefore no real scan is started from r8. Reviewer G1 mistakenly interprets the standing pause as prohibiting reads; the standing restriction is writes/download/VM boot. Reviewer notes about missing tests/README predate the finished stage and actual tests here.

Postdelete r4 actual 22 tests has one failure: old-generation reappearance is correctly rejected but not with the expected diagnostic, because selection moves the last-live boundary. A focused correction is pending. No real no-reuse claim.

QCOW allocation r2 actual fixture failed: qemu-nbd changes cwd after socket binding, so the client cannot use the child's cwd to locate that socket. Root stopped only the owned fixture runner after positive attribution. No original accessed. r3 correction uses the client's owned directory fd; untested at this checkpoint.

Exact pinned Reth state validation helper r2 is prepared, unbuilt, with only negative fixtures. It needs build and positive algorithm tests before use. No value-integrity or canonical chain claim.

Potential HDD/FUSE random-read costs mean recovery is not yet proven faster than download. The original must remain intact; compact allocated-file backups omit deleted database blocks. Journal/database bytes and binaries excluded.

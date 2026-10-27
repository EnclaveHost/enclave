# Extraction receipt correction and launch guard review

Extractor r3 actual25 unit tests passed. Receipt publication is non-overwriting and atomic; state consumption now also requires the separately bound successful wrapper job. Root reviewed the substantive diff and ran focused tests. This is not actual extraction E2E or database acceptance; all265/inactive-driver prerequisites remain.

Launch guard r1 actual9 tests ran with8 passing/1 failure, and stdout containment also failed. The retained test failure catches FUSE outside the selected read-only roots: unshare clones the whole mount namespace, so the corrective revision must refuse non-desktop FUSE mounts anywhere. The discovered namespace receipt must also have its full inside/parent predicate re-evaluated. Corrective prompt1903 is included; r1 must not launch production. No actual long namespace, original-data mount or production job was started.

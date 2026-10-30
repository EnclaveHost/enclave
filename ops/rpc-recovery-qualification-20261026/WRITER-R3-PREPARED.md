# Writer r3 prepared; qualification pending

r3 fixes the malformed persisted-evidence fixture that caused root1545 to fail. The production implementation is unchanged. The regression now proves a valid exactly-full journal opens, refuses additions before mutation, preserves duplicate handling, and rejects over-limit or malformed saved state for the intended reasons. Root reviewed the patch. The158-test slice root1553 is queued behind the coordinated125GBcopy and is NOT yet a pass. Full build/native/image/production qualification remains outstanding, as do old-claim recovery and the driver.

The state fetch was briefly stopped for the coordinated owner-policy simulation. All99,052,683,264 committed bytes survived (receipt included); root1552 resumed from exactly that offset and committed subsequent chunks. No source image was modified.

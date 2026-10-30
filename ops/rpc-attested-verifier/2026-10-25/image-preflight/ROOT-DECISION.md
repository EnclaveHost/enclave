# Bundle refresh approved for candidate image construction only

The eight-file patch a2c522ee18add6227b683d40e8018cb4ef72a15ff3cd47a73ac3d46b65f68d21 contains generated bundles and manifests only. Root verified it applies to e0dfe98aa without source edits. The independent exports reproduced identical outputs; the input-dependency comparisons and parent calibration are recorded alongside this review.

This corrects stale bundles before making a new measurement. The direct verifier role must still be bound to its reviewed configuration digest. Dormant platform-API/MCP code in the image is not an activated migration of those roles. The platform-API parent also had a generated-input mismatch; its regenerated source closure is retained in this candidate, not declared production-tested.

Next: rebuild twice from this committed tree, check required bundle parity, independently inspect the resulting image and measurement, then review a real SNP canary. No production activation or measurement allowlist update is approved by this file. Canonical configuration and attestation source bytes are unchanged from e0dfe98aa; callers must verify that before reusing the existing provider-side verifier bundle.

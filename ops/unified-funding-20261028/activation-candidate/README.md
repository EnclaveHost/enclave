# Default-off funding activation candidate

No production installation or activation. Run python3 verify.py, then node test/activation.test.mjs and node test/activation-native.test.mjs through the shared resource queue. Native fixture requires the adjacent qualified native-host-candidate build artifacts and its prepare.py output; no test skips or size overrides. See ROOT-REVIEW.md for status, failures and limitations.

Use independent owner-controls and intake flags/manifests. Keep owner controls enabled on rollback after any successor grant exists. Never revert to the original module without preserving successor withdrawal/end access and unresolved queue journals.

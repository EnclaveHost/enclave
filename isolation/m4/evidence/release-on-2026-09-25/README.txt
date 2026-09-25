Step 2 (4b) of isolation/restore/ENABLEMENT.md (rev 4.1 f95e2d55): the relay's attested release ON for the 3 canaries.
PREPARED, NOT RUN (waits for enclave-d1's re-check of v2 and Codex's go). enclave-63's wrapper around enclave-5d's
relay-release-on.sh f09f511c / relay-release-off.sh fef9905f (reviewed by enclave-d1 and enclave-e3; not copied here: they
are at f95e2d55 isolation/restore/). scripts-v2.sha256 pins all six.
rr-run.sh on|off starts rr-on-apply.sh / rr-off.sh as a transient user unit. nan_run copies the reviewed script into a
0700 mktemp dir on nan, re-checks its sha256 THERE, and runs it as root under flock /run/enclave-relay-release.lock
(enclave-d1: an ssh drop must not let on and off edit api-relay.env at once), output to a file in that dir.
Pre: the 4cc gate passed after the 4c-c-b retry; the node 02f6e313 / f6cbd75a on launcher 578be084; guestd the 3 S0
canaries; nothing else on metal-iso0; the relay row; the canaries 200; release-status 503 for each; the guests' identities
and the relay's InvocationID recorded. Post (relay-side failure -> relay-release-off.sh automatically): a NEW relay
invocation with NRestarts 0 (and again at the end); metal-iso0 re-attached serving/eligible; the canaries 200; the node
unchanged; each canary listed:true (the script: a69dcbba false, no refused setting, /enclaves 200); e3's accept.sh
(38000e62) with every line ok but EXACTLY "release-ticket answered 403" (the unlisted 0xabab... stops at the listing gate,
403 release_not_enabled; any other code HOLDs, no rollback); the predictor KAT PASS of the new invocation. A changed guest,
or lease-release lines in the node journal, HOLD with no rollback: with the release on, a canary respawn is a RELEASE
guest = an early 4e (enclave-d1). enclave-d1 from supervisor.js at f6cbd75a: the relay-unreadable window of the api-relay
restart cannot stop an adopted running guest ("already serving it here" precedes every gate; "unknown" only refuses a
claim or backs off a respawn); do not restart the NODE within ~5 min of the relay restart.

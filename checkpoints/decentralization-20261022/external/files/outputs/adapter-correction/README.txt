Adapter correction: version 1.0.17, source d4a755b, binary package 0.5.5

The wallet-upload release 1.0.16 was built from main and omitted already-deployed fixes on the adapter-timeout branch (production baseline effa13c / package 0.5.4). Its upgrade transaction succeeded, but recovery testing caught a regression: restart re-hashed the bucket and live pin writes timed out. This is not a completed successful rollout.

The correction uses the entire production adapter baseline effa13c and reapplies the deployment-bound wallet authorization change. It retains range-resume behavior, successful-list error clearing, restart cache reuse, and the 180-second Sia commit wait. Version 1.0.17 must be published and then selected by the owner wallet.

Validation: 62 Rust tests pass. The combined MinIO/Kubo/Wasmtime end-to-end suite passes, including restart with all cached leaves reused and zero objects rehashed, JSON/WASM direct wallet uploads without a relay secret, changed-body and unsigned-request rejection, ranges, CARs, and multipart writes.

Artifact: bafybeihnfbvrrnuioglduqx6k4hniceutqthzg6aawnaeeyhds3vx2gl7q
SHA256: 3c76508c400cb7d2704a0ef897ff02ab88f1d4d6121add249979da8867457466
Size: 1500650 bytes

Live success remains gated on confirming publication and upgrade, host runtime CID/version, recovery of the original retained content, and an actual wallet-signed storage round trip. No claim of Nan retirement is made.

Live correction verified October 19, 2026: catalog 1.0.17 active, runtime 0.5.5 ready, 1241 files including all 1239 prior entries unchanged and two new test entries. Live wallet upload/readback passed; wrong-deployment signature rejected; no Nan upload token used. Nine network apps ready. Manager artifact fetching was also moved to per-fetch operator replica configuration. The measurement/secret-release verifier still required the exact CAR in its Nan cache for recovery; this remains a migration dependency. See recovery-verification.json, live-wallet-verification.json and manager-fetch-migration.json.

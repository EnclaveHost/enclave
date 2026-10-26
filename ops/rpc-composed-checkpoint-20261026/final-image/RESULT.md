# Actual image and consumer verification

The10cdf913 verifier-only direct image built once, using the pinned production base and existing canonical native binaries. Independent extraction/source comparison passed45/45 checks, and both measurement calculations agree: c0ab52344d5a1ebc0ed39e3848dcfe996f20e8a6b67c36318d34fd9fc1d2ce755aa2fc0afbb4913ce877478130d23cb9. No native rebuild, VM boot, hardware attestation or production cutover occurred in this build. Image binaries and source clones remain local; hashes and verifier receipts are preserved here.

The local canonical-chain consumer suite passed7/7 without skips using the committed EIP2935 genesis. It checks claims/renewals, proof outages with app continuity, restart recovery, lost submission responses without duplicate release, administrator moderation and address-book changes, and absence of public RPC contact. The initial run used a genesis without the history contract and failed setup; the retry corrected that input without changing the test or runtime source. This is synthetic local-chain evidence, not production Base finality or hardware proof-serving evidence.

Live Base download/sync, historical blobs, finality/restart integration, live proof-serving qualification and consumer cutover remain outstanding. The separately recorded final-snp-canary passed hardware attestation and fail-closed checks after this build.

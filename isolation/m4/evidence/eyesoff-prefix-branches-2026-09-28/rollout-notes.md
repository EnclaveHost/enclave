# Rollout notes

The first new-version fetch failed through trustless-gateway.link (HTTP 520).
The uploaded Wasm was present at ipfs.enclave.host. Its CAR was verified by the
platform fetcher, pinned in Nan Kubo, and announced using `ipfs routing provide`.
A second fetch through the actual production gateway then verified SHA-256
9d01a29ba9074b1349188136f980f54746fff116722f2186da36aedc86cae91b.

The new guest then exceeded its 100-second secrets-release retry window because
Nan calculates all ten admitted runtime images for each new app version. No
secrets were released on the uncompleted prediction. Automatic recovery retried.
For future rollouts: publish first, pin/announce the CAR, and await the new catalog
version's independent predictions before enabling the activation transaction.
Verifying the new runtime with the *old* app is insufficient preparation for
this cold-cache latency, even when the new app measurement is locally predicted.

# RPC broker serving transition (blockers 1 and 2), r1/r2

Source: completes the preserved servingCutoff patch (9593a83) and transfers the
two remaining original-deadline owners coherently, without a reset or new window.

- `BrokerSession.Cutoff()`: original startup deadline until the complete
  owner + exporter + both-guardian transaction and durable receipt publish the
  conservative signed serving expiry (9593a83). Watcher, command backstop and
  announcement all read this one value.
- `announceServing`: after publication and its prior/new bound recheck, the
  broker sends `ENCLAVE-RPC-SERVING/1 <requestSha256> <expiry>` on the same
  pidfd-pinned monitor socket, write-bounded by min(3 s, expiry). Failure is loss.
- Monitor `watchServing` (client): after the root grant it follows only exact,
  strictly increasing announcements no more than 30 s (guardPermit) ahead, with
  no descriptors; anything else, EOF, broker death or a missed expiry is loss.
  Without an announcement the attempt still retires at the original deadline.
- `cmd/rpc-storage-broker`: the os.Exit(124) backstop now re-arms to
  `session.Cutoff()` instead of firing at the original deadline once serving.
  The original-deadline context only bounds the initial Authorize call;
  continuations revalidate with their own contexts, so it needs no transfer.

r1 (frozen harness): transition PASS; broker-serving FAIL in commit-renew and
commit-past-startup. Cause: the test helper "monitor" exited on its first
packet, which became the new serving announcement in tests that never call
Acknowledge; the broker then correctly saw its monitor die. Fixture fixed to
skip announcements as the real monitor does. r2: all six phases PASS, 47 records
(transition 10, broker-serving 24 incl. 9593a83's never-run subtests,
export-serving 5, grant-attach 5, broker-cmd 3) plus broker build
(11514030 B, sha256 01d1bb79d1acb9e2b15582528f0a8658831825bc60acbe6271ec9262c59cedf5,
private, not committed). Same frozen envelope as ops/rpc-nbd-guest-cert-r1.

NOT covered: blocker 3 (outer owner operator/TLS/Python/systemd lifetimes) and
blocker 4 (Windows keeper/host); natural 30 s expiry end-to-end; any native
guest. Production RPC remains OFFLINE.

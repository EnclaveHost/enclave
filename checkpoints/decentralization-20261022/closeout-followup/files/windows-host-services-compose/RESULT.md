# Host-services / challengeReplica wiring composed onto the normal Windows tree (RESULT, 2026-10-23)

**Commit:** isolated candidate `candidate/`, branch `compose/host-services`.
- `d281007c234031e5729b882b4e9ff3d9e4ffd5ad` → **`d7f520bf8eca94ce3464bc0b70a0619261c04b68`**.
- Author and committer: SteveDeFacto. Origin was removed and nothing was pushed.

**Patch:** `host-services-compose.patch` (`git diff --binary d281007c d7f520bf`).
- sha256 `ae3f2687e6634b1f435e1f7a9184e027e3d97f823c446cc817dfc9ef4b96ff29`.
- 27 files, +2037/−69.

**Not touched:** worker D's `windows-compose/candidate`. I only read it, and cloned from it.

**Not done:** no SSH, wallet, deployment, background service, merge or push.

## 1. Source and lineage

**Source:** the installed Windows control lineage, `adapter-admission-review/candidate` commit **32fecf5**.
- This is the lease-readiness tree: host 9634cb40, wallet-admission 0fa7678f, agent 76cac355.
- It holds the host-services transport (G1/G2), the G3 interface and the G4 challengeReplica wiring.
- Related live components: the ca-east A1 provider canary `hs-transport-39d1513b` and the minipc privacy agent `cfb69370` (`dns-routing-investigation/EVIDENCE-INVENTORY.json`). I did NOT re-derive their bytes from 32fecf5 in this job.

**Normal tree:** f58e03e is this same baseline with three things removed:
- the D1 wallet hold;
- lease readiness;
- host-services/challengeReplica.

D's commits sit on top of it: C1 8ba64343, C2 f666306d, then 49afbb60, 81fb5489, 993d92ec and d281007c. D's privacy-agent is a3f08aca without the hostServices hunks.

**Rule.** A file came from `git show 32fecf5:<path>` in only two cases:
- it is absent from d281007c (**9 files**); or
- the baseline is a **strict superset** of the d281007c file, meaning every line only in d281007c is the pre-feature form of a baseline line (**18 files**).

`PROVENANCE.files.json` (sha256 `e1012d13…`) records, for each path:
- the class;
- the baseline blob, sha256 and mode;
- the candidate's sha256 before the change.

After the commit, all 27 committed blobs equal their recorded 32fecf5 blobs (0 mismatches).

**Absent in the candidate (9):**
- `network/host-service-{ingress,names,transport}.mjs`
- `network/wg-provider/{dns-probe,host-services-config}.mjs`
- `network/wg/udpforward{,_test}.go`
- `test/host-service-transport.test.mjs`
- `test/fixtures/challenge-replica-reviewed.json`

**Strict supersets (18):**

| file | what the baseline adds |
|---|---|
| `network/build.mjs` | bundles `host-service-ingress.mjs` |
| `network/enclave-network-host.mjs` | `serviceWorkerModule` |
| `network/host-services/roles.mjs` | `transportRateLimit*`, `appStatic` |
| `network/host-services/stage-tool.mjs` | `host-services` command, publication, dns/probe-tls |
| `network/privacy-agent.mjs` | `hostServicesPreflight`, hostServices close |
| `network/wg-circuit-runtime.mjs` | `serviceSpec`, circuit firewall policies, `udpIngress` |
| `network/wg-control.mjs` | non-throwing first round (N3) |
| `network/wg-grants.mjs` | `revoke` |
| `network/wg-provider/control.mjs` | `/v1/revoke` |
| `network/wg-provider/install.sh` | keeps `hostServices`; conntrack, nft check, ufw route 53 |
| `network/wg-provider/kernel.mjs` | DNS 53 DNAT ruleset and DNS gate |
| `network/wg-provider/main.mjs` | hostServices, dnsPlan, host policy runtime, `probeDns`, `--ruleset` |
| `network/wg-provider/provider.mjs` | service role, `MAX_SERVICE_HOSTS`, `DNS_STALE_MS`, `hostAdmission`, `dnsProbe`, service-zone exclusion, status |
| `network/wg/forward.go` | |
| `network/wg/cmd/enclave-wg/main.go` | `udpIngress`, port 53 |
| `scripts/check-transport-profile.mjs` | hostServices transport; "off" is refused |
| `windows/installer/stage-bundle.sh` | stages `host-service-ingress.mjs` |
| `windows/node/network-enroll.mjs` | `hostServicesError` |

**challengeReplica.** `network/challenge-replica-host.mjs`, `-cli.mjs` and their test were already **identical** in d281007c. The missing pieces were:
- the host/enroll wiring (`enclave-network-host.mjs`, `network-enroll.mjs`);
- the reviewed fixture.

**Kept newer, never overwritten.** The baseline copies of these files are older than the candidate's, or diverge in both directions:
- the normal lease-gas bundle set (008cdca1);
- `host.mjs`/`chain.mjs` (e7: host ea0f6b8a, chain 3e9fae03);
- `public-directory.mjs` (same-route fix), `route-record.mjs`, `lease-reader.mjs`;
- `relay/*`, `shielded/*`, `site/*`;
- `supervisor.js` (only comments differ; the candidate's wording is newer);
- the `host-admission` bundle;
- README, PRODUCT and `.gitleaks`.

All 99 relative imports in the composed files resolve.

**Conflicts:** none. Nothing needed lines from both sides, so no functionality was dropped.

**Deliberately excluded:** `metal/guest/{mcp-server,platform-api}.bundle.mjs` and their manifests. They differ in 32fecf5, but they are generated guest bundles, not part of this feature.

## 2. Generated artifacts (built locally, NOT committed)

**Network-runtime bundle.** `relay/network-runtime.bundle.mjs` is gitignored. `node relay/build-network.mjs` built it as `75c8ba75…`. The route-dns package needs it.

**Host-service packages.** `network/host-services/packages/*` is untracked. `scripts/build-host-service-packages.mjs` rebuilt it; see `logs/hs2-packages.log`.
- **Byte-identical to 32fecf5:** `bootstrap-replica.mjs` and its package.json, `credit-vault-submitter.mjs`, `policy-mirror.mjs`.
- **Different:** `directory-replica.mjs`, `route-dns.mjs` and the other manifests.
- Every difference traces to a newer input in the candidate:
  - route-record 9ba9f6d3 vs be3bfab7;
  - lease-reader 907ba85d vs d885b303;
  - public-directory 95edf767 vs a480b674;
  - `relay/boxhost.js` and the network-runtime bundle;
  - viem, ox and ws versions in the unpinned node_modules copy.
- These are test inputs only. **Release packages must be rebuilt and pinned by root** from a pinned dependency set.

**Go binary.** `enclave-wg.exe` was **not rebuilt or committed**. The Windows release needs a new build that includes `udpforward.go` and the `udpIngress` change in `main.go`. A `GOOS=windows` build and vet both pass (§3).

## 3. Tests (all run through `claude-test-queue.py`, offline netns)

| run | queue lane | tree | result |
|---|---|---|---|
| hs4 feature (`host-service-transport`, `challenge-replica-host`, `hosted-services-appstatic`, `hosted-services-stage`, `paid-network`, `service-index`, `transport-profile`, `wg-provider`, `wg-renewal`), with anvil | 768 | composed | **67: 64 pass, 1 fail, 2 skip** (peak 535 MiB) |
| hs5 regression (17 files: privacy-agent ×3, Windows enroll/wallet/grant-refresh/network-hold, host-egress, consumer bundle, authority pins, bootstrap, canaries, …) | 768 | composed | **84: 83 pass, 1 fail** (peak 552 MiB) |
| hs8 control: unmodified d281007c, with the runtime bundle and packages built the same way | 768 | control | **29: 27 pass, 2 fail** (the same two) |
| hs10 Go `network/wg` (`go test ./...`), then `GOOS=windows go build ./cmd/enclave-wg` and `go vet ./...` | 1024 | composed | **ok: 16 pass, 5 skip; Windows build and vet rc 0** (peak 245 MiB) |

**Feature coverage that passed:**
- **Host-service transport (all 14 cases):**
  - B1–B3;
  - the N3 first round;
  - the Windows sandbox;
  - G4 composition;
  - enroll/preflight.
- **challenge-replica-host (all 9):** host policy gate, carriers, and end-to-end through the built release.
- **appstatic:** real DNS from the pinned route-dns package.
- **wg-provider.**
- **Go UDP ingress (all 7):**
  - loopback-only relay;
  - truncation;
  - flood lockout;
  - payload size;
  - two queries in flight.

**The two failures are pre-existing.** Both fail the same way on the control:
1. **`network-consumer-bundle` "standalone network bundles load outside the repository…".** The built `dns.mjs` prints the inlined `identity: commands: check-endpoint …` usage.
   - On the control it fails with the same text, once the control has the runtime bundle.
   - This is the known bundling argv-guard defect: memory "host-role bundling pitfalls"; fixed on another candidate line, not here.
2. **`service-index` "the independent checker qualifies a community provider…".** Git object b17db9a3 is absent from the normal-lineage repos.

**Other notes:**
- The 2 hs4 skips need `forge build`.
- The 5 Go skips are throughput benchmarks.
- **hs9 is not a result:** the first Go run left loopback down in the netns. Its handshake failures were environment-caused; hs10 brings loopback up.
- **hs6 is also not a comparison:** that control run lacked the generated bundle and packages. hs8 replaces it.
- The full Windows suite was not duplicated; that is D's scope.

**Scans on exactly the 27 committed files:**
- `.githooks/scan-crypto-keys.py --files`: exit 0.
- `gitleaks dir --config .gitleaks.toml` on a staged copy of those files: no leaks (`gitleaks-commit.json` = `[]`).
- The candidate has no `core.hooksPath`, so the hooks were run by hand.

## 4. For root (integration and production)

- The commit is source only. A release also needs:
  - rebuilt, pinned host-service packages;
  - a rebuilt `enclave-wg.exe`;
  - a rebuilt network-runtime bundle and privacy-agent bundle.
- Activation order still follows the existing challenge/hs2 recipe, which is outside this scope.
- The ca-east A1 canary runs an hs-transport provider build (`39d1513b`); its byte relation to this commit was not checked here.
- No governance, owner-policy, lease-funding or liveness logic changed: every file is either the installed baseline's exact bytes or kept from d281007c.

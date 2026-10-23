# Corrected custodian r2: source review, reproducible build, SNP canary handoff (2026-10-23)

**Status.** Source review, tests and two local builds only.
- No SNP launch, SSH, wallet, signature, chain write, DNS, service or config change.
- Root's c95dcd3a build (`out/`, `repo/`, `repo-b/`), its quote evidence and `README.md` are unchanged. New outputs are in
  `out-r2/`, `repo-r2/` and `repo-r2b/`.
- The e01206d3 image is superseded by this one. This image has **no hardware quote yet**.

## 1. Source: `ab589bf80b669c9671b53573d489b6c6c45779ea`

**Where:** `custody-v2-durability-20261023/repo`, branch `root-custody-rollout-closure`.
- **Lineage:** c635fd68 + ed0c536d, 415483ff, 3ccd4333, 0a6b108e, c95dcd3a (reviewed) + **a5eae96c (root)** + **ab589bf8
  (mine, tests only)**.
- **Patch:** `custody-v2-durability-20261023/custody-v2-rollout-closure.patch` (`c95dcd3a..ab589bf8`), sha256
  `f427865db38e6ab1093fab35b1fc383b0c954a3e7d0b7690aa7ad9d1c08bec2f`.

### Review of root's a5eae96c (actual code)

| item | verdict |
|---|---|
| **Startup state** (`startup-state.mjs`, `daemon.mjs`) | Correct. Only HTTP 404 yields "absent". Any other status, a transport error, a redirect (`redirect:'error'`), a body over 4 MiB, under 28 bytes, or a 10 s stall fails. The fresh identity is PUT (a barrier) before use. The 4 MiB read cap equals `host.mjs` PUT's own 4 MiB cap, so nothing the host accepts is later unreadable. The guest supervisor (`cvm-gsup.mjs`) restarts a failed daemon with a backoff of up to 30 s, so a refused start retries; it does not stay down. |
| **Host binding authority** (`host-binding.mjs`, `host.mjs`) | Correct. The reader kind comes from the reviewed table (book kind + book 0xab21… + the hostOwnership pin, which must equal the reviewed one), never from a failed read. The vault's code hash, size, book and enclaveOwner are checked at an agreed block before every signing attempt, and any error retries without signing. `prepareHostBinding` refuses a host with no accepted owner. |
| **Direct ingress** (`ingress.mjs`) | Correct. `owner-read/challenge` and `owner-read` are added as POST-only exact paths. Nothing else widened. |
| **Relay `CUSTODY_SURFACES`** | Unchanged and still lacks owner-read. Not needed for this image: it is `transport direct`, and app guests reach custodians at the on-chain machine endpoint (`isolation/m2/custody/v2client.go`). It only matters for tunnel images. No client in this tree calls owner-read; it can be exercised only with a test client. |
| **Guest PUT deadline** (`hostPut`) | No explicit timeout; Node fetch's default 300 s header/body timeouts apply (not measured here). A stalled host delays writes, commits and checkpoint-dependent releases (liveness only). A late success after a failure is the already-documented ambiguous case: member rollback, no ack. No change made. |

No source defect found. No source change by me.

### Targeted tests added (`ab589bf8`), only for cases root's 8 tests left open

**`test/custody-v2-daemon-startup.test.mjs`**
- It runs the REAL `daemon.mjs` `main()`, bundled as the image bundles it (production measured config of the original
  vault).
- Only `snpkey derive` is stubbed, and every non-host fetch is refused.
- Host answers 503, 500, 403, 401, a disconnect, a redirect, an empty 200, a truncated 200, another key's blob, a
  tampered blob, an oversize body and a stall: no start, no PUT, the stored state is untouched.
- The stored state opens, and opens again afterwards.
- A 404 whose first PUT fails: nothing starts. A 404: a fresh identity sealed with the chip key.
- **Results:**
  - on ab589bf8: 1/1, peak 223 MiB;
  - **on c95dcd3a: FAIL** (`503 … new custodian identity sealed`);
  - **on a mutant of root's wiring (`.catch(()=>null)`): FAIL** (same).

**`test/custody-direct-ingress-paths.test.mjs`**
- The REAL Caddy (v2.11.7, existing binary `work/custody-caddy/caddy`, sha256 `678ade3b…`) with the generated
  ingress, in front of the REAL `createCustodyRouter`.
- 25 spellings of `host-binding` (case, slashes, `./`, `../`, `%2e`, `.%2e`, `\`, `%5c`, `%2f`, `%252e`, `;`, `?`,
  absolute form) plus 6 private host routes: none reached `setHostSig` or the guest port.
- **Results:**
  - 1/1, peak 185 MiB;
  - **a mutant ingress forwarding `/v2/custody/*`: FAIL** (11 spellings reached `setHostSig`).

**Not re-run:** root's 8 closure tests (root ran them: 8/8) and unrelated suites.

## 2. Image (two independent clean clones, offline `npm ci`, no `--allow-dirty`, GOPROXY off, 1024 lane)

**Run:** `build-r2.sh` → `out-r2/`, queue EXIT 0, peak 440 MiB (sev-snp-measure 296).
- Each clone was verified by `verify-custodian-v4.mjs` (failures: none on A and B).
- A == B: initramfs bytes, vmlinuz, cmdline, and manifest measurement/files/initramfs/kernel/cmdline/commit/inputs.
  `manifest.json` itself is byte-identical: sha256 `60bde3e90a9d9984def551c21c8815108272d57d2d37bf2e1eb9f2d209e1ad5b`.

| field | value |
|---|---|
| commit | `ab589bf80b669c9671b53573d489b6c6c45779ea` |
| **SNP measurement** | `70aadff5455fd65f752c1dcec2d6f1ac4984bebf6c63b284d15fcf47851fb96def231af40c39a3bca6fbf9748f01c429` |
| measurementSha256 | `0xfbe2f581cd8da409856adcff75a149c3797111cb0c7030b824f015867b9cb8d7` |
| initramfs | `bed627f6b471422ed1d66d27dc8652fa44f2f6241266b261dfafc1a2a3d41623` (280,104,720 B) |
| kernel | `1a3a02d5…a124e7` (unchanged from c95/c635) |
| cmdline | `console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app` (unchanged) |
| OVMF | `142589cc…f4a9` (unchanged) |
| base | dist-custody-9e5fb2028 (initramfs `7169150f…`; unchanged) |
| vcpus / role / transport | 2 / enclave-custodian-v2 / direct; dkg none |
| vault / hostOwnership | 0xe48699b8… / 0xbbd885d3… (book 0xab214342… in MEASURED) |
| /opt/custodian/custodian.mjs | `33951330673e6ad99ef7bd026c5a934f54b344ce11c639164cb0445bd096d81b` (the only changed file vs c95) |
| /opt/custodian/snpkey | `1d0541fe…` (unchanged) |
| /opt/metal/gsup.mjs | `23dbbc73…` (unchanged) |
| MEASURED text | exactly one definition, equal to `custodianMeasured(original vault, book, host ownership, host-policy-production.json b22ed164…)`; sha256 `a7fc690a…` |
| bundle inputs | 58 repo files; added since c635: `sealed-state.mjs`, `startup-state.mjs`; changed: `daemon.mjs`, `member.mjs`; 14 packages as c635, lockfile-pinned |

**v4 = v3 plus:**
- the lineage now runs through a5eae96c and ab589bf8, and all four patch files must reproduce their sha256 exactly;
- `startup-state.mjs` is allowed as an image input;
- host-side files (`host.mjs`, `host-binding.mjs`, `ingress.mjs`) fail if they appear among the image inputs;
- the host launcher closure is reported.
- Expected noise: v4 logs `fatal: path … exists on disk, but not in c635fd68` for the two new files. These are its
  caught lookups, not errors.

**Host launcher runtime closure.** `custody/v2/host.mjs` runs on the host, outside the measurement, from a checkout at
ab589bf8. All its inputs are tracked and equal the commit:
- `chain.mjs` c85d3d82…
- `digests.mjs` 76d8091d…
- `host-binding.mjs` d803cfc8…
- `host.mjs` c2923901…
- `measured.mjs` a9a758e6… (placeholder; used only for its default RPC list)
- `quorum.mjs` 7c6e56c7…
- `network/custody-vaults.mjs` 8939a32a…
- `network/platform-host-policy.mjs` 8198228d…
- `network/rpc-identity.mjs` 74cb965e…
- Packages: viem 2.53.1, ox 0.14.29, abitype 1.2.3, @noble/curves 1.9.1, @noble/hashes 1.8.0, @scure/base 1.2.6,
  @scure/bip32 1.7.0, @scure/bip39 1.6.0, isows 1.0.7, ws 8.21.1 (lockfile `9ada1611…`).
- Ingress generator: `scripts/prepare-custodian-ingress.mjs` `e0312bda…`.

**Rewrap image.** Not rebuilt. Its whole closure is unchanged since c635fd68 (v4: 0 changed paths), so the frozen
`custody-release/out/A-rewrap` stands: measurement `f01a7166…`, initramfs `1b090c69…`.

**Scans:**
- `scan-crypto-keys`: clean on the rollout-closure patch, `build-r2.sh`, `verify-custodian-v4.mjs`, both v4 receipts and
  the manifest.
- gitleaks: no leaks in commits `c95dcd3a..ab589bf8` or in the patch.
- gitleaks on `out-r2/A-verify-v4.json`: **2 `generic-api-key` hits**, lines 77 and 720. Both are
  `"/opt/custodian/snpkey": "1d0541fe…"`, the public sha256 of the snpkey executable. That value is the same class root
  already ruled public in `SCAN-REVIEW.txt`; this is a new file, so it needs root's adjudication. No allowlist added.

## 3. Production SNP canary handoff (root executes; nothing here was done)

**Goal:** a dedicated canary custodian on metal0 for the ORIGINAL vault, with its OWN fresh identity and a NEW committee.
- Never copy an existing state blob, identity, share or key.
- The live committee 0x4774 and its custodian (2530eda0 image, relay tunnel `/t/custody-metal0`) stay untouched.
- A fresh quote proves boot and attestation only, not the lifecycle.

### Prerequisites (read-only checks first, at an agreed block)
1. metal0's registry entry: active; operator `0xc9d0…e6ab`; payoutWallet = Enclave wallet `0x0b2d…ee61` (vault seat
   flag Enclave).
   - Accepted and pending owner on 0xbbd885… are both zero (root, 18:47).
   - The platform host policy is current and does not ban metal0's operator.
2. **Enrollment (blocks binding and genesis; `prepareHostBinding` and `genesis` refuse an unowned host):**
   - TX1 `EnclaveHostOwnership(0xbbd885…).proposeOwner(metal0Id, 0x0b2d…)`, signed by operator `0xc9d0` (root's host
     key);
   - TX2 `acceptOwner(metal0Id)`, signed by the **Enclave admin wallet 0x0b2d (human)**.
   - The owner MUST be 0x0b2d: the vault seats metal0 as Enclave by payout, and any other owner is refused as a mismatch.
   - The earlier unsigned and simulated pair (`existing-custody-audit/evidence/metal0-enrollment-unsigned.json`, block
     52851092) is stale: re-simulate.
   - **Not reversible to "no owner"** (there is no renounce; only a new propose/accept). The old image does not read
     ownership, so the live custodian is unaffected. Root should check other consumers of metal0's accepted owner (the
     platform host gate, node holds) before TX2.
3. **A public HTTPS origin for the canary custodian.**
   - It needs DNS and a publicly trusted certificate, because app guests' fronts POST to the on-chain machine endpoint.
   - It is served by Caddy from `node scripts/prepare-custodian-ingress.mjs host-config.json NEW_CADDYFILE`, which
     proxies to 127.0.0.1:mgmtPort only.
   - The endpoint must be a bare origin (`https://name`, no path or port).
   - The relay tunnel cannot carry a direct image.
4. A funded submitter EOA (gas for `createCommittee` and later handover transactions), its key in an env variable named
   by `submitterKeyEnv`. Book: **no book write is needed** (`secretVaultV2` stays optional; admin; later).

### Exact payload
- `dist`: a root-owned copy of `out-r2/A-custodian` (check the four hashes above).
- Host side: a clean clone at ab589bf8 + `npm ci --offline`.
- `host-config.json` for `node custody/v2/host.mjs host-config.json`:
```json
{ "dist": "<root copy of out-r2/A-custodian>", "ovmf": "/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd",
  "sevDevice": "/dev/sev", "cpus": 2, "memMiB": 3072, "tunnelName": "custody-canary-r2",
  "endpoint": "https://<canary custodian origin>", "registryEndpoint": "<metal0's EXACT registry endpoint string>",
  "hostPort": <free loopback port>, "mgmtPort": <free loopback port>, "stateDir": "<NEW, EMPTY, root-owned dir>",
  "genesis": true, "vault": "0xe48699b8401564aace7a814ae4569b67a3f7eef5", "rpc": "https://mainnet.base.org",
  "registryKeyFile": "<metal0 operator key file, 0600>", "submitterKeyEnv": "<env var holding the canary submitter key>" }
```
- No `committeeId` at first. The daemon serves its own committee (`member.committees()[0]`).
- Never point `stateDir` at the live custodian's directory or at any copy of it.

### Sequence and success criteria
1. **Launch.** Expected log lines:
   - `new custodian identity sealed` (404 on the fresh dir);
   - the binding: `host binding for 0x… HTTP 200` after the vault identity check;
   - `GENESIS <cid>` after `createCommittee`.
   Quote-check the guest against `70aadff5…`, with a fresh nonce (as `canary/verify-custodian-quote.mjs`).
2. **On-chain check** (agreed block): committee `<cid>` epoch 1, t 1, W 1; machine = the canary identity; enclave true;
   commitments = the genesis Y. `/v2/custody/info` over the public origin shows the same encKey and hostSig.
3. **Restart** (same stateDir):
   - the same encKey;
   - `genesis committee … confirmed on the agreed chain` once (an intent made before confirmation) or steady;
   - no second `createCommittee`.
4. **Startup fail-closed check (optional, host-side).** While the guest is stopped, make the host's `/state` answer 503
   once. The guest must log FATAL and must not PUT. Then restore and restart: the same encKey.
5. **C3 secret lifecycle:**
   - a new canary deployment owned by a dedicated canary wallet, with its policy `update` naming `<cid>`;
   - boot on metal0: front log `v2 threshold of 1 over 1` and app runs;
   - rotate, then boot again;
   - unauthorized cases as audit runbook §8.3 S4.
6. **Outage and rollback (canary only):**
   - O1: stop → C3 boot refused.
   - O2: start → same encKey, released.
   - O3: an older `state.bin.*` → same identity; rollback NOT detected (see the limits below).

### Rollback
- Stop the canary `host.mjs` and Caddy, and remove its DNS.
- Old committee 0x4774, its custodian, the relay and policy 0x4e62 are untouched by every step.
- The canary committee stays on chain (immutable). Abandon it: the canary owner pauses or clears C3's policy.
- Keep the canary stateDir until no policy names `<cid>`. Its shares are the only copy.
- metal0 ownership stays the Enclave wallet (see prerequisite 2).

### Resources
- **Measured:** custodian guest 3072 MiB within a 5120 MiB cgroup. The host-side process tree peaked 807 MiB (c635) and
  828 MiB (c95) in the quote-only canaries; this image is the same size.
- **Unmeasured:** a lifecycle run adds host.mjs signing/submit, Caddy (~50 MiB in tests) and the C3 app guest (its own
  lease size).
- Same rule as before: no Claude queue jobs concurrently.

## 4. Security limits (no claims beyond these)
- **Hostile host, absent state:** a host that answers 404 for existing state makes the guest create a NEW identity, and
  its PUT replaces `state.bin`. Only an honest host's 20 history copies keep the old blob. A guest cannot prove absence
  without an external monotonic anchor.
- **Hostile host, rollback:** the host can serve an older valid blob (an older checkpoint, older shares, a pre-confirmation
  genesis intent). This is not detected; there is no hardware monotonic counter.
- **Availability:** the host can always deny service (stop, stall, drop transactions).
- **Single-seat bootstrap:** n = 1, t = 1, W = 1, one Enclave seat, one chip, one operator.
  - Confidentiality rests on SEV-SNP on that chip and on this measured software.
  - Loss of every sealed copy loses every bundle under the committee.
  - This is outage isolation for the canary, not independence or decentralisation.
- **Genesis intent:** an ambiguous `createCommittee` may be re-sent once (the vault refuses the duplicate). A changed
  host binding or seat afterwards gives `genesis_refused` or reverts. Conflicts and legacy orphans need an operator.
- **Persist deadline:** no explicit PUT timeout (Node defaults, about 300 s); liveness only.
- **Owner-read:** served by the image and the direct ingress only. No client in this tree; not tunnelled by the relay.
- **Evidence scope:** the tests are local, with a stubbed chip, chain models, anvil and a real Caddy. The new image has
  no hardware quote and no lifecycle run.

Nothing here is a production result; the rollout is not complete.

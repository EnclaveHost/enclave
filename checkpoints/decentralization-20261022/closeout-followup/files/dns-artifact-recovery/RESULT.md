# EnclaveDNS 0.1.5 artifact 404: recovery (local evidence and source only, 2026-10-22)

Nothing live was done: no network, edits to existing scripts or source, tests or builds. No secrets are printed.

## 1. The exact artifact (verified locally)

| item | value | where |
|---|---|---|
| wasm | **2588705 bytes, sha256 `e3780187ebaff9e0f4f1440d8292f7e161f764825e5e2f56880150d6605ef5e9`** | `work/enclavedns-stale-20261021/wallet-handoff/artifact/enclavedns-0.1.5.wasm` (byte-identical copy: `release-0.1.5-r2/enclavedns-0.1.5.wasm`; `release-0.1.5/…OBSOLETE-9e1bcf39.wasm` is NOT it) |
| pinned CID | `bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau` | `wallet-handoff/trust.mjs` (DNS.wasm / DNS.expectedCid) |
| CAR | no CAR file is stored. It is derived deterministically: `frozenWasm(DNS)` (`site-host-live-publish/handoff/site-upload.mjs:67`) re-imports the wasm and REFUSES unless it gives the pinned CID | — |
| last good proof | 2026-10-21 19:53Z: `POST /add-wasm` accepted (HTTP 200, same CID), then a full CAR readback from `ipfs.enclave.host` was verified as **11 blocks, CAR sha256 `575ac91d43b920ac0450d085bec0b52b13d11a23c2fd104d1fc8e52df049aadf`**, with 0 transactions and no human wallet | `work/enclavedns-upload-502-20261021/direct-r3-result.json`, `direct-r3-upload-accepted.json` |

The bytes were stored and served once. The catalog version (0.1.5 → this CID) is already published, so **no new catalog
version or owner signature is needed**. The same bytes give the same CID.

## 2. Cause hypothesis: the index, not the bytes (source-backed; live confirmation is root's)

**How the adapter stores and serves** (`work/enclave-apps/s3-ipfs-adapter/src`):
- `/add-wasm` stores the whole file at `pins/<cid>` (`upload.rs:14, 47, 389`).
- The gateway serves only what its IN-MEMORY index holds. That index is rebuilt from an S3 **listing** plus hashing after
  every start (`main.rs:519–` Indexer, phases `listing` → `hashing` → `ready`).
- "A boot serves nothing until its first commit" (`main.rs:972`).
- A capped listing is "PARTIAL" (`main.rs:743–748`, `maxKeys`).

**What changed since 10-21:**
- **The adapter itself was relaunched.** Its lease expired at 21:39Z and it was re-claimed at 21:45Z on 10-22
  (`public-health/host-renewal-diagnostic.json`). So it rebuilt its index from scratch.
- **Its S3 endpoint looks unavailable.** The adapter's S3 endpoint is the **sia-s3 deployment `0xef514ed3`**
  (`enclavedns-upload-502-20261021` evidence: "its S3 endpoint = sia-s3 0.1.8 (deployment 0xef514ed3…)"). At 23:35Z that
  deployment was **not running**: "claim … 422 Unaffordable" (`relay-release-live/nucbox-queued-state.json`).
- The index had already been stuck in `listing` with S3 list I/O errors at about 14:00Z (`claude-resumed-20261022/live-holding-readiness`).
- A listing that cannot reach sia-s3 yields an empty index, so every CID gives 404 at every gateway. The gateways all
  resolve through this adapter.

**So the most likely state:** the object still exists in Sia, but the relaunched adapter cannot list its store. A
re-upload now would fail too: its PUT goes to the same unreachable sia-s3.

**Unproven:** whether `pins/<cid>` still exists in the Sia bucket. Only a complete listing after sia-s3 is restored
answers that.

## 3. Safe plan (root; reads first)

**R1. Read-only, public, no credentials:**
- `GET https://7ae476a3.app.enclave.host/api/status`: look at `state`, `files`, `truncated`, `missing`, `error`,
  `listed` (`main.rs:1166, 1187–1208`).
- Check whether sia-s3 `0xef514ed3` holds a live lease and answers `https://ef514ed3.app.enclave.host/healthz`.

**R2. If sia-s3 is down:**
- Restore it: fund `0xef514ed3`'s lease-gas reserve so a host can claim it (the funding batch), and let it re-claim.
- Do not upload anything yet.

**R3. Re-index (no new bytes):**
- `POST /api/refresh` on the adapter (`main.rs:1168, 1258–1267`; this needs the adapter's `api_key` when one is
  configured; never print it). Or wait for `refreshSecs`.
- Then read `/api/status` until `state == "ready"`, `truncated == false`, `error == null`.
- Then `GET /ipfs/<CID>?format=raw`, and the full CAR `?format=car&dag-scope=all`.
- Do not trust HEAD: `?format=car` HEAD answers 200 for any CID (memory: adapter CAR HEAD false positive).
- A 200 CAR that matches 11 blocks / `575ac91d…` means recovered, with nothing published.

**R4. Only if the CID is absent from a COMPLETE, ready, untruncated index** (meaning the Sia object was lost): run
`dns-artifact-recovery/reupload-exact.mjs` (sha256 `536dfd9db2dd4e7c6f514a5a362df80ece7ae4dd13afa0df501bae2f0cc8933a`).
- It is the same supported EIP-191 direct `POST /add-wasm` as `direct-upload-r3.mjs` (sha `adb404a3…`). That uses a
  temporary key with no funds or authority, never stored.
- It does not use r3's wallet-handoff journal guards, which now refuse because publish/upgrade completed.
- It refuses unless:
  - `CONFIRM_REUPLOAD=<the CID>` is set;
  - the local wasm matches size, sha and CID;
  - `/api/status` is ready, untruncated and error-free;
  - the CID is not already served.
- It then verifies the exact frozen DAG from the adapter's CAR, and writes only hashes to `reupload-result.json`.
- Run: `cd work/resume-after-checkpoint-20261022/dns-artifact-recovery && CONFIRM_REUPLOAD=bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau node reupload-exact.mjs`.
- Only the syntax was checked (`node --check`); it was not run or tested.

**R5. Then let EnclaveDNS `0x59f1273d` launch:**
- It needs the CID served. Its own claim also needs its reserve funded (it was "422 Unaffordable" at 23:35Z).

## 4. Limits

- The live state is as of the cited receipts.
- The deployed adapter's wallet-upload acceptance (open to any EIP-191 signer, as at 10-21) is assumed unchanged since
  10-21. If R4 is refused, read the adapter log rather than retrying.
- Same-site storage (adapter and sia-s3 both on minipc) is a single failure domain. This plan restores service; it does not
  make the artifact provider-independent.

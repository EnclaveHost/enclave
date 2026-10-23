# ipns-publisher 0xd9798e4c reports `http-only`, sequence 0: source-level assessment (READ-ONLY, 2026-10-23)

This was read only. Nothing was published, reset, restarted, reconfigured or signed. No admin route, API key, SSH, env, private
config or chain write was used. The reads were exactly 10 public unauthenticated GETs (cap 10, 30 s each), plus local-only
reads of source, the stored 1.0.5 component and offline kubo verification. Every probe ran in the unchanged queue at 256 MiB.

## Answer in one paragraph

The publisher's key and name are intact: the same peer ID `12D3KooWSHxf…zoZP` and name `k51qzi5uqu5dma8l0…afe9b52` as on 10-20 and
10-22. The public name still resolves. delegated-ipfs.dev serves a validly signed record, **sequence 1026 →
`/ipfs/bafybeieuxt6…otzaou`, valid until 2026-10-30T13:03:14Z**. The empty `/api/status` therefore does not mean the record is
absent: it is a fresh process (started 19:27:53Z) whose startup publish round failed.

In 1.0.5, `mode` reads `"http-only"` whenever the process has no DHT client object. With a delegate configured, that object is
created only by `do_dht_publish`, which is queued only after a successful sign. A failed round is **not retried** until the next
4 h republish tick, at about 23:27:53Z, or an authorized `POST /publish`. Two facts show both outbound fetches of that round
failed: `recovered` is null (the delegate GET for sequence recovery failed) and `value` is empty (the `site-root` fetch failed or
was unusable). Both URLs answer 200 from here, so the likely cause is the app's outbound HTTPS after the guest relaunch. That is
an inference: only the app's own log can prove it.

`durableState: false`, while it was true on 10-20, also shows no `/data/ipns-publisher-state.json` existed at startup. Sequence
safety therefore depends on network recovery alone.

## Direct facts (each with its evidence)

**Running component.**
- The deployment runs `catalog://0x9afdfb40…65ef/5`, version label "1.0.5", CID `bafybeiesjakstv3l…j6ii`, created 2026-10-13T22:16:21Z.
  Sources: `work/bootstrap-cas/manifest.json` and `work/ipns-production-cutover/snapshots/production-read-final.json`.
- Its config (redacted, from that snapshot): value `https://ipfs.enclave.host/site-root`, `lifetimeSecs` 604800,
  `republishSecs` 14400, `ttlSecs` 300, delegates `["https://delegated-ipfs.dev"]`, `dht: true`, IPNI to cid.contact.
- The fixture `work/ipns-production-cutover/fixtures/ipns-publisher-1.0.5.wasm` (sha256 59a1cec5…) hashes offline
  (`ipfs add -n --cid-version=1`) to exactly `bafybeiesjakstv3l…j6ii`. Evidence: `evidence/local-provenance.log`.
- That wasm contains the status, sign and recovery strings quoted below, plus the favicon string of enclave-apps commit
  `4514d25` (2026-10-12). It has no `release-anchor` reader.

**Source.** `ipns-publisher` at enclave-apps 4514d25: tree 90b0c84c, `src/main.rs` blob ccde6c3a. It is identical to fca1fea
(tree f7c6f31d, blob a9dcb933) except one status-page `<link rel=icon>` line. The line numbers below are fca1fea's, and are the
same at 4514d25 up to line 718. That the 1.0.5 wasm was built from 4514d25 is an inference from the matching strings; it was not
byte-reproduced.
- `api_status` (l.628–678): `mode = "dht"` iff `app.dht.is_some()`, else `"http-only"`. `value`, `sequence` and `publishedAt` come
  from the in-memory last signed record. `last_error` is **not** reported anywhere in `/api/status` or on the status page.
- `App::new` (l.199–243): `load_state()`, then one `enqueue_publish()`: Recover(each delegate), then Sign. `RecoverDht` is queued
  only if there are no delegates and no durable state (l.299–315), which does not apply here.
- `tick` (l.317–330): the timer starts at construction. The first tick only re-arms it to now + `republishSecs` (4 h), because a
  round is already queued.
- `do_recover` (l.359–389): one GET `delegated-ipfs.dev/routing/v1/ipns/<name>`. It updates `recovered_seq` only on HTTP 200 with
  a valid record; any other outcome is just logged.
- `do_sign` (l.421–477): `resolve_value()` does one GET of the `site-root` URL. If it fails or is non-200, the code logs
  `publish aborted: …`, sets `last_error` and returns. Nothing is re-queued, and there is no fallback to the recovered value.
  On success it signs, `save_state()` (durableState → true), then queues the PUT to each delegate and `DhtPublish`; the latter
  creates `app.dht` and so turns the mode to "dht".
- **Sequence rule** (l.433–445):
  - the same value as the recovered record keeps the recovered sequence (EOL extended);
  - a changed value gets `max(recovered, own) + 1`;
  - **with nothing recovered and no prior record, the sequence is 0**.
- `POST /publish` (l.594–603, api-key) queues the same Recover → Sign round.

**Public reads.** `evidence/public-read-20261023T204419Z.json` (9 GETs) and `…T204505Z.json` (the 10th).
- **`/api/status` at 20:44:19Z:**
  - peerId and name unchanged; sequence 0, value "", validUntil 0, publishedAt 0;
  - `recovered: null`, `delegates: []`, `mode: "http-only"`, `dht: null`;
  - IPNI idle with `durable: false`; `durableState: false`;
  - `queuedTasks: 0`, `uptimeSecs: 4586`, so the process started at about 19:27:53Z.
- **Publisher `/routing/v1/ipns/<name>`:** 503 `{"error":"no record signed yet"}`.
- **`https://ipfs.enclave.host/site-root`:** 200, the first line is `/ipfs/bafybeieuxt6…otzaou`, Last-Modified 2026-10-19T13:31:13Z.
- **delegated-ipfs.dev:** 200, a valid record (kubo `name inspect --verify`, V1+V2 signature): sequence 1026, value
  `/ipfs/bafybeieuxt6…`, validity **2026-10-30T13:03:14Z**, TTL 300 s, 379 bytes, sha256 c108729d….
  - With `lifetimeSecs` 604800, that record was signed at about 2026-10-23T13:03:14Z, by the previous process.
  - No later republish (at about 17:03Z, or after the relaunch) is visible at this delegate.
- **ipfs.io and dweb.link** only redirect (301) to trustless-gateway.link, which answered 526. On 10-20 these gateways answered
  522/525, so this is not specific to this name.
- **ipfs.enclave.host** `/ipns/<name>?format=ipns-record` and `/ipns/<name>/` both answered 404. That matches 10-20: the Enclave
  gateway does not resolve IPNS, so it is not a primary IPNS source.
- **Old site root block:** `ipfs.enclave.host/ipfs/bafybeieuxt6…?format=raw` answered 200, and its sha256 equals the CID
  multihash, so the root block is present. The whole DAG was not checked.

**Earlier state.**
- 10-20 06:35Z (cutover snapshot): sequence 1026, `recovered` 1026 from delegated-ipfs.dev, mode "dht" with DHT state "failed",
  `durableState: true`.
- 10-22 07:17Z (root postbuild `publisher-status.json`): sequence 1026, mode dht.

## Inferences, not proven

1. **Both outbound HTTPS requests of the 19:27:53Z startup round failed.** This follows from recovered = null plus value = "",
   while both URLs answer 200 publicly now. The likeliest cause is the relaunched guest's app egress not being ready, or missing.
   It could also be transient, or specific to those hosts.
2. **`/data` was not durable across the relaunch:** the 10-20 state was durable and the current state is not. It is also
   possible that the file exists but was unreadable.
3. The 1.0.5 wasm is the 4514d25 source; see the string matches above.

## Is a recovery possible without a sequence rollback? Yes, if the delegate GET works when the round runs

- **Recovery succeeds:** `recovered_seq = 1026`. `site-root` is still `bafybeieuxt6…`, so the same value **keeps sequence 1026**
  and only extends the EOL. Name, key, sequence and old site CID are all preserved.
- **Recovery fails, but the `site-root` fetch succeeds:** the code signs **sequence 0**. While 1026 stays valid (until
  2026-10-30T13:03:14Z), resolvers prefer 1026, so the seq-0 record is ineffective but stays published. After 1026 expires it
  would become the visible record.
- **A changed `site-root`** (a new reviewed dashboard release) would get `max(recovered, own) + 1`: 1027 if recovered, but **1**
  if not.

So never trigger a round while the delegate GET from the app is unconfirmed.

## Exact root metadata queries needed (read-only)

1. **App log** of deployment `0xd9798e4c…` since 2026-10-23T19:27:53Z, filtering `[ipns-publisher]`. Look for:
   - `https://delegated-ipfs.dev: GET failed: …` / `GET answered N` / `knows sequence N`;
   - `publish aborted: <reason>`;
   - `state file: sequence …` (absent means no `/data` file);
   - `IPNI provider ON …`.
   This decides egress versus value-source versus anything else.
2. **That partition's egress state** after the relaunch (its egress-routes and egress proof for the new guest): is outbound
   443 allowed and working to `ipfs.enclave.host` and `delegated-ipfs.dev`?
3. **Durable storage for this deployment** in the new guest: is `/data` mounted and persistent, and does
   `/data/ipns-publisher-state.json` exist? Read it if so; it holds only sequence, value and published_at.
4. **The previous process's log** near 17:03Z: did the 4 h republish after 13:03Z fail? This tells whether egress trouble
   predates the CPU relaunch.
5. **On chain, read only:** is the deployment still at appRef `/5` with envelope sha256 `d59dc724…`? This rules out a config
   change.

## Minimal recovery recommendation (preserves key, sequence 1026 and the old site CID)

1. **Do not** reset, redeploy, rotate the key, change config or start a new name. The current 1026 record stays valid until
   2026-10-30T13:03:14Z (about 6.7 days from now), and delegated-ipfs.dev also carries stale-if-error.
2. Use queries 1–3 to find and fix the cause: app egress for those two hosts, and the durable `/data` for this deployment.
3. Confirm from the app's own log, or an egress proof, that the delegate GET works from the guest. Then either wait for the
   automatic round (next at about 23:27:53Z, if the process is not restarted) or have root make ONE authorized `POST /publish`.
4. **Expected result:**
   - the log shows `knows sequence 1026`, then `signed sequence 1026 for /ipfs/bafybeieuxt6…`;
   - `/api/status` shows sequence 1026, the value set, `recovered` 1026, and delegates `ok`;
   - delegated-ipfs.dev's record keeps sequence 1026 with validity now + 7 d.
   - `mode` turns "dht" once DhtPublish runs, but that only means the DHT client exists; on 10-20 its DHT state was "failed".
5. **Publish the new custody dashboard only after step 4 holds.** Publishing it means changing `site-root` through the reviewed
   site release. The next round then signs 1027. Changing `site-root` earlier than step 4 risks a low sequence if recovery
   still fails.
6. **If recovery cannot be confirmed:** do not trigger a round; the public name stays correct until 10-30. A seq-0 record
   signed meanwhile is not catastrophic while 1026 is valid, but it should be avoided.

## Out of scope / not done

No production mutation, no new app release, nothing about the funding approach, and no claim about DHT propagation: no DHT walk
was run. The whole old site DAG was not re-verified, only its root block.

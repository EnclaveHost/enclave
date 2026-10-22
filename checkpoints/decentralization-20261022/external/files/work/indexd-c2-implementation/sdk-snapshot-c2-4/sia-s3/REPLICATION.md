# sia-s3: replication across indexers

From 0.2.0, sia-s3 can keep its buckets on several Sia indexers at once. If those indexers are run by independent
operators, writes, reads and ongoing storage no longer depend on any single one of them. Distinct URLs do not prove
distinct operators; the deployer has to establish that. Code: `src/replica.rs` (the cluster), `src/store.rs` (one
indexer), `src/config.rs`.

Nothing here has been activated. No production indexer, deployment or catalog version uses it yet.

## Why replicate indexers, not move them

An indexer (indexd) is the one party that, for a given app key:

- holds the Sia contracts with the hosts, and renews them from its own Siacoin wallet;
- funds the app's host accounts, which every upload and download spends from;
- pins slabs (moves uploaded sectors into its contracts) and keeps the object list (sia-s3's whole index);
- repairs slabs (migrates sectors) when hosts go away.

The vendored SDK (`vendor/sia-sdk-rs/sia_storage`: `Sdk`, `Builder`) has no wallet, contract-formation, renewal
or account-funding API. An app can upload, download, pin, delete, list objects and list hosts, and all of that goes
through one indexer. Moving indexd or its PostgreSQL (today on minipc) to another machine moves that authority; it
does not remove it. Replication makes each indexer one of N replicas, each with its own contracts, funding and hosts.

## Configuration

```json
{
  "replicas": [
    { "name": "minipc", "indexer": "https://sia.enclave.host", "appKey": "$SIA_APP_KEY" },
    { "name": "b",      "indexer": "https://indexd.example.org", "appKey": "$SIA_APP_KEY_B" },
    { "name": "c",      "indexer": "https://sia.example.net",    "appKey": "$SIA_APP_KEY_C" }
  ],
  "writeQuorum": 2,
  "region": "auto", "buckets": ["ipfs"],
  "credentials": [{ "accessKeyId": "$S3_ACCESS_KEY_ID", "secretAccessKey": "$S3_SECRET_ACCESS_KEY" }]
}
```

- `replicas` replaces `indexer`. A config without it is one replica (`primary`).
- `replicas` can also be a single `"$SIA_REPLICAS"` string whose secret holds the JSON array. The owner can then
  change the set with a secrets update; in the version config, changing it needs a new catalog version.
- A replica's `appKey` defaults to the top-level `appKey`. A replica whose `$NAME` is unset is a config error. It
  never falls back to another indexer's key. Config debug output never prints a seed.
- Indexer URLs are parsed and canonicalized: the scheme, a lowercase host without a trailing dot, the port only
  when it is not the scheme's default, and the path without a trailing slash.
  - Refused: credentials, a query or a fragment, schemes other than http(s), and the same canonical URL twice (one
    endpoint must not count as two quorum votes).
  - Plain `http://` is allowed for a local or tunnelled indexer and logs a warning. Over it, anyone on the path sees
    which objects exist and can withhold or replay the indexer's answers. They cannot forge objects, which are
    signed and sector-proof checked.
- `writeQuorum` (W) defaults to a majority and must be between 1 and N. N counts members only: a replica marked
  `"retiring": true` is listed only while a membership change moves away from it (see "Membership changes").
- Deadlines (seconds): `metadataTimeoutSecs` 120, `uploadTimeoutSecs` 1800, `uploadGraceSecs` 30,
  `metadataGraceSecs` 5, `stallTimeoutSecs` 120. Maintenance: `repairEverySecs` 300, `repairMaxBytesPerPass` 1 GiB.
- The app key must already be registered on every indexer (indexd admin `POST /api/apps/register`, or the
  connect-key flow) with a quota that covers the data.

| N, W | Writes during one indexer outage | Restart during one outage |
|---|---|---|
| 1, 1 | no | no |
| 2, 1 | yes | needs both; a dead one cannot be removed safely (see "Membership changes") |
| 2, 2 | no | yes |
| 3, 2 | yes | yes (recommended) |

## Fault model

- **Fail-stop indexers with durable acknowledgements.** An indexer may crash, hang, lose answers, or apply a
  request long after its client gave up. Everything it acknowledges, it keeps. W-of-N writes and N - W + 1 boot
  reads rest on this.
- **Partial rollback is tolerated.** Deletion floors are copied to every replica. A deleted key therefore stays
  deleted even if up to N - W indexers roll back to an older state or lose theirs (tested with one of three rolled
  back to before the DELETE). If more do at once, the key can come back.
- **Not Byzantine-fault-tolerant.** An indexer cannot forge objects: they are sealed and signed with the app key,
  and data is checked against Sia sector proofs. It can withhold objects, replay old ones, or lie about what it
  holds. A majority of indexers doing so defeats these guarantees. N - W + 1 does not cover lying indexers.
- **One writer.** Exactly one sia-s3 process may write to a set of app keys at a time. indexd has no fencing (no
  conditional or generation-checked pin). A second writer is invisible until a reload, and two writers break
  conditional PUTs and version ordering. Requests a stopped writer left in flight cannot bring a deleted key back,
  whatever either host's clock says: every version it could stamp lies below a ceiling the next writer starts above
  (see "Versions"). This holds for writers running this version; requests left by a writer that ran an earlier
  version are ordered by wall clock only. They may briefly surface an older version of an undeleted key until the
  newer one wins the merge.
- **Unreadable data is a host fault, not an indexer fault.** Manifest bodies are read from Sia hosts. A replica that
  cannot read the manifest of a key's live version does not load (it would serve an older version and could delete
  data only that manifest names); a superseded manifest it cannot read does not block it and is purged.

## Guarantees under that model

- **Versions.** Every write is stamped with a millisecond clock that only moves forward plus a random write id.
  Replicas merge by taking each key's newest version; a newer deletion hides it. Clocks may be skewed between
  writers, so versions are bounded by durable **version-range ceilings** (store.rs `Meta.ck`; replica.rs,
  "Versions"):
  - A writer stamps a version only inside a range whose ceiling W voters have acknowledged. The first stamping write
    after a boot reserves one (an upload per replica, inline); maintenance renews it at half its 6 h length and gives
    it to replicas that lack it. Without W acknowledgements the write answers 503 and nothing is stamped.
  - A booting writer starts above the highest ceiling on any loaded replica (in a ceiling object, or carried by a
    membership record). Any W set meets any boot set, so every earlier version, acknowledged or abandoned, is below
    its first version and below any deletion floor it writes.
  - A ceiling object is a one-byte object, its ceiling in signed metadata; a new one is a new object, so a late pin
    can only raise a replica's ceiling. Lower ones are then deleted (one per replica at steady state).
  - `/healthz` shows `versionCeiling` per replica, and `version_ceiling`, `observed_ceiling` and `version_fence`
    ("legacy" until the first reservation, then "ceiling") in the cluster stats.
- **Re-reads never race other work.** A dirty replica's fresh listing replaces the old index only when nothing holds
  that index, no change succeeded since the listing began, and no call is in flight; the old store is retired in the
  same step and refuses anything sent through it later (the compactor, an UploadPart or a DELETE's floor still
  holding it). Otherwise the re-read is retried next pass.
- **No secrets in status text.** Indexer requests are signed in their URL's query; error text shown on the status
  page and `/healthz` has every URL's query cut.
- **Writes and boot.** A write succeeds when W *admitted* replicas acknowledge it, and answers 503
  `ServiceUnavailable` otherwise. The app serves once N - W + 1 admitted replicas have loaded, so every acknowledged
  write is visible. A write that answered 503 may still become visible, as after an S3 500. A replica is admitted
  only once it holds the complete history (see "Membership changes"), so an empty or half-backfilled replica never
  counts toward either number.
- **Deadlines and latency.** Every replica call has a deadline. Once W replicas have answered, the others get a
  grace period (30 s for uploads, 5 s for metadata) and are then abandoned. A hung or slow indexer delays a write by
  at most that grace, or fails it at the deadline when W cannot be reached. The write lock is never held past a
  metadata deadline. A streamed body drops a replica that stops taking data for the stall time. A read moves to the
  next replica after the stall time plus one second per MiB without progress, resuming at the first unsent byte.
  The same code runs natively and on wasm32-wasip2 (tokio timers).
- **Unknown outcomes.** A metadata call that fails or is abandoned may still be applied, at any later time. Its
  replica becomes *dirty* and is re-read from its indexer's object feed. No safety decision depends on how long ago
  that was.
- **DELETE** returns 204 only once the deletion is acknowledged on W replicas, as either:
  - a tombstone written into the key's host object on each replica that holds the key, or
  - a deletion floor in a new ledger object, on a replica that does not hold the key, or whose tombstone failed.

  Otherwise it answers 503, and a retry re-applies the same deletion. Any W set meets any boot set, so a boot always
  sees an acknowledged delete.
- **Deletion evidence is kept for good.** Maintenance copies every deletion into a floor on every replica. A floor
  is a key hash plus the deletion's version, about 80 bytes. It lives in a ledger object whose encrypted body is
  checked against the length and SHA-256 in its signed metadata.
  - Once a replica has pinned the floor, the tombstone leaves its object and the payload is reclaimed.
  - Any version older than a floor is dead wherever and whenever it appears: an abandoned pin applied hours later,
    or old data an indexer replays. It is never served, and it is purged.
  - Ledgers are merged when more than 16 pile up. The merged ledger is pinned before any old one is deleted, so no
    floor is ever dropped.
  - A replica with a ledger it cannot read does not load: availability is lost rather than deletion safety.
  - There is no time-based tombstone collection, and no option to discard floors.
- **Repair** copies each key's newest version to replicas that lack it. It reads from any replica that has the
  version and checks the size, and the MD5 for single-part ETags. It also applies missed deletes and purges dead
  versions.

## Membership changes

Quorum intersection (any W set meets any N - W + 1 set) covers only writes acknowledged by W members **of the
current set**. Data written under another set does not meet that: under one indexer it exists on that indexer only,
and a replica added later holds none of it. So every replica keeps **membership records** (store.rs `MsRec`), and the
cluster acts only on what they say (replica.rs, "Membership").

- **Records.** Each is a one-byte object whose signed, sealed metadata names a membership: an epoch, W, and its
  members (64 bits of SHA-256 of each canonical indexer URL, so changing an indexer's URL is a membership change),
  plus the set it replaced and the highest version ceiling the writer knew. Records are only ever added, never
  rewritten, so a pin applied late can only add evidence. A record this version cannot read keeps its replica
  unloaded. 0.1.x leaves them alone (v2 objects); sweeping and compaction never touch them.
  - `admit`: this replica held the complete history when this set admitted it.
  - `seal`: this replica belonged to the set this one replaced; that set no longer acts.
- **Admitted means complete.** A replica is admitted only when it is not dirty, has no call in flight, every ledger
  and every manifest of a live version it lists has been read, and it holds:
  - every key at the merged view's newest version,
  - every deletion, as a tombstone or a floor at least as new,
  - the highest version ceiling the writer knows (see "Versions"),
  - every part of every open multipart upload the sources hold, and the sources must agree on each part. Parts carry
    no version, so when a part was uploaded again while some sources missed it, the acknowledged variant is unknown:
    the change waits until that upload is completed or aborted.

  The merged view must itself be complete: N - W + 1 admitted members of the acting set, every manifest and ledger
  read.
- **States** (`/healthz` → `replicas[].membership`, and `replicas[].voting` / `record` per replica):

| State | When | Serves? | Who votes (counts toward W) |
|---|---|---|---|
| legacy, one indexer | no records, `primary` only | yes, as before | it |
| legacy, several | no records, more than one replica configured | no: with every configured replica loaded, maintenance commits them first (epoch 2) | nobody |
| stable | the configured set is admitted at the newest epoch | with N - W + 1 admitted members loaded | admitted members |
| migrating | another set is admitted (the one before the change) | under the old set's rules: its N - W + 1 | the old set's admitted members |
| pending | the configured set was sealed, never had N - W + 1 admissions | no, maintenance finishes the change first | nobody |
| waiting | admitted members that are not loaded may hold what serving needs | no | nobody |
| refused | records at the newest epoch name sets that cannot be told apart, or a sealed change to another set than the configured one | no | nobody |

- **New members** are written to (PUT, DELETE, parts) as soon as they are loaded, and backfilled by maintenance:
  keys, floors, and open multipart parts. They do not vote until admitted.
- **Commit.** With every configured member loaded and caught up, maintenance commits the change under the write lock
  (and the reservation lock):
  1. `seal` records go to the members of the old set that are configured, as members or `retiring`. At least W(old)
     must succeed: any N - W + 1 set of the old members then meets a seal, so the old set never serves again (not
     even if the configuration is reverted). If too few succeed, the cluster is *pending* and retries. From a set
     without records, every listed replica gets a seal and all must succeed (which of them held the data is unknown).
  2. `admit` records go to every configured member. The set is *stable* once N - W + 1 have one.

  A set that never reached N - W + 1 admissions never acknowledged a write, so its admitted members (or, before any,
  the sealed old set) still hold everything. A commit interrupted at any point is therefore finished by the next
  maintenance pass, or at the next boot before anything is served.
- **One indexer.** A deployment without records (0.1.x, or one indexer on this version) keeps serving on its one
  indexer as before. Its first maintenance pass writes one `admit` record (one small upload). From then on, a
  migration away from it serves from the old indexer alone while the new ones are backfilled.
- **Several indexers without records** (the first boot of a new replicated deployment, or a migration from one
  indexer that never ran a maintenance pass of this version) **never serve**: nothing durable would say that this set
  acted, so a write acknowledged by new replicas alone would be lost if the list went back to the old indexer. With
  every configured indexer loaded (only then is the old holder certainly among them), maintenance runs in the boot
  loop, backfills, seals every one and admits them as epoch 2; then the set serves. For a populated single indexer
  that is downtime for the whole backfill, which is why the procedure below records the single indexer first.
- **Two sets at one epoch.** A change sealed in part, then a different change committed at the same epoch by a boot
  that did not load the partial seal, leaves two sets at that epoch. When both name the set they replaced and exactly
  one has admissions, that one acts and the other's seals are inert (at most one can have admissions: they follow
  W(old) seals, which every later quorum of the old set meets). Otherwise the cluster refuses to serve. Recovery is
  manual: load the replicas holding that epoch's admissions, or, after checking that one set has N - W + 1
  admissions, delete the stray record objects. A single indexer's own record is epoch 1 and a set without records
  commits as epoch 2, so a single-indexer record applied late never collides with it.
- **What a change needs.** The old set's N - W + 1 admitted members, loaded (sources), W(old) of them configured to
  take seals, and every new member reachable at the commit. So:
  - Replace or remove at most W(old) - 1 members of the old set at once, or keep the departing ones listed as
    `retiring` until the commit.
  - Losing more than N - W members of a set for good loses the guarantee for what only they held, and no change can
    be committed from it. With N = 2, W = 1, that is one member. There is no override in this version; accepting that
    loss would need a separate, explicit tool.
  - Data can be lost only if every replica holding it is dropped from the configuration (nothing is left to say it
    existed), or beyond the fault model below.
- **During a migration** the old set's availability applies: from one recorded old indexer, that indexer must be
  up; a deployment without records does not serve until it is committed (above).
- **Stable membership** keeps its availability: with N = 3, W = 2, one indexer down still serves and writes.
- **Cost.** Two records per member per change (one small upload each), plus one per member admitted on its own. They
  are kept.
- **No rollback below this build.** 54818ba (and earlier 0.2 builds) sweep objects whose metadata they do not know
  as orphans after a day: membership records and version ceilings among them. A rollback that lasts longer erases
  them, and the roll-forward starts as a deployment without records. 0.1.x leaves v2 objects alone.
- **Version ceilings across a change.** A reservation counts only the acting set's voters (new members and retiring
  replicas receive it, uncounted). A member is admitted only once it holds the highest ceiling the writer knows (its
  own acknowledged one, or a higher one observed), and every seal and admission record carries that ceiling. The
  admission holds the reservation lock, so no range is acknowledged while the voters change. A writer booting from
  the new set alone therefore starts above every version the old one could stamp.

## Writer fencing (candidate: work/storage-fencing-implementation)

**What it adds.** Exactly one writer at a time, enforced by the indexers rather than by operator discipline.
- **Ballot.** Each process draws a fresh instance id. Its ballot is `gen || counter || iid`.
- **Generation.** `gen` comes from the writer-authority fact delivered with the release: the lease the secrets were
  released under, or the owner's cold recovery.
- **Install, then list.** The ballot is installed on every listed indexer before that indexer is listed (the U1
  current-objects listing).
- **Exact fence on mutations.** Every pin, delete, slab pin and prune carries the token and the receipt the indexer
  issued for it. The indexer applies a mutation only if both equal what it holds.
- **Confirmation before every answer.** Every S3 answer waits for a confirmation round, started after the request
  arrived, that finds this fence on W voters. That includes data, listings, 412, 404 and the DELETE of an absent key.
  Otherwise the answer is 503.

**Configuration:**
- `"writerFence": "required"` (default) | `"off"`;
- `"writerAuthority": "$ENCLAVE_WRITER_AUTHORITY"`;
- `"instanceIsolation": "$ENCLAVE_INSTANCE_ISOLATION"`;
- optional `"acceptUnevidencedIsolation": true`.

Wire contract: `work/storage-fencing-implementation-interface.txt`.

**Guarantees and stops:**
- Writes from a superseded or delayed writer are refused by the indexers whenever they arrive.
- A new writer sees every write acknowledged before its fence was installed.
- A superseded instance answers 503 and writes nothing more.
- An instance under an older lease never preempts a newer one.
- The owner's cold recovery preempts the current writer but never a later lease.

**Fails closed when:**
- the authority fact is missing;
- the isolation is not named;
- the runtime has no recorded no-clone evidence (unless the risk is accepted explicitly);
- an indexer lacks the fence API;
- a confirmation cannot reach W voters.

**Assumptions:**
- **A1:** fail-stop indexers that implement the fence.
- **A2:** a RUNNING instance cannot be duplicated with its memory.
  - A copy made after the raise holds the same credential and is indistinguishable.
  - A copy made before it is refused (a fresh receipt per install; no equal raise).
  - SNP, TDX and VBS have no recorded no-clone evidence here, so they are refused by default.
- **A3:** the instance runs this code. An app-key holder outside it has the owner's full authority. That is not the
  same as a host replaying or duplicating an instance, which the fence and receipt address.

**Costs:**
- one parallel metadata round per batch of requests;
- reads need W voters reachable;
- an indexer whose raise answer was lost stays unused until the next restart.

**Activation dependency:** indexd with the fence API, and the relay/front generation binding
(`work/storage-fencing-implementation/patches`). Until then, `"writerFence": "off"` keeps the single-writer behaviour
(not safe against two writers), and on a fenced account the unfenced writer is refused and stops. `sia-s3 import` is
an unfenced writer: on a fenced account it is refused.

## Copies of a running writer: C2 (fenced mode)

A post-raise copy of a running sia-s3 (or a snapshot restored later) holds the same credential, so the fence alone
cannot tell the copies apart. C2 keeps the S3 semantics anyway, using the indexd G-C2 v4 protocol
(`work/indexd-c2-implementation-interface.txt`; requires the `cas-v4` capability, otherwise fenced boot fails
closed):

- **Conditional head.**
  - Every object pin and delete carries the account head this writer expects there. The indexer applies it only at
    that head, so after a fork each replica takes the mutations of at most one copy.
  - A lost answer is settled by replaying the identical operation, which the indexer applies at most once.
  - A head this writer did not produce is never adopted: that replica is forked out for the rest of the process.
  - Each new operation takes its id from a fresh indexer nonce (`opNonce`, G-C2 R2) fetched after the operation
    began. Two copies with a copied RNG and clock therefore send different operations, even for byte-identical
    requests: one is applied, and the other is refused, also when both first answers are lost. A copy taken after an
    operation fetched its nonce continues that same operation. Indexers without `op-nonce` are refused.
- **Two-phase writes.**
  - PUT, copy, DELETE, multipart completion and membership seals pin their new content tentative first. They commit
    only once W voters hold the tentative pin.
  - `writeQuorum` must be above half the members, so at most one copy can ever commit after a fork.
  - Readers ignore tentative content, and maintenance removes leftovers.
  - Destructive steps (detaching older entries, dropping parts, collecting tombstones, compaction deletes) follow the
    commit.
- **Freshness.** Every answer needs a round in which W voters report this writer's fence, receipt and exact head. A
  re-read is adopted only if the head is the same before and after the listing.
- **After a fork.**
  - Each copy forks out the replicas where it sees another head, and goes on while it can still form a write quorum.
    The copy that reached a quorum first keeps serving.
  - The other copy can neither commit nor confirm freshness once the first has written. It stops when it sees the
    conflicts.
  - Before any write after the fork, both serve the same state.
- **Old clients.** On an enrolled account, a pre-C2 client can neither mutate nor take over (412 mode). Accounts that
  never enrolled behave as before. There is no online downgrade.
- **Not claimed:**
  - a single physical process;
  - confidentiality;
  - tolerance of Byzantine or state-losing indexers (a lower head is a fork, not tolerated);
  - the front/generation binding, which is a separate gate.

## Objects an indexer's operator blocked (PATCH U1-B)

indexd's object blocklist lets an indexer's operator block an object (a takedown). indexd then refuses to return the
object or let it be pinned again. Its current listing omits blocked objects by default. sia-s3 always asks with
`blocked=true`, which lists them flagged and with their metadata withheld. Nothing here removes or works around a block.

**What a blocked object can hide.** Everything sia-s3 knows is in object metadata: key entries (a data object hosts
its own key's entry), tombstones, manifests, ledgers of floors, membership records and ceilings. A blocked data object
cannot be told apart from a blocked record. So:

- **B1:** a replica whose listing has any blocked object is not used:
  - it is not read from;
  - it does not vote or count toward the N − W + 1 needed to serve;
  - nothing is written to it.

  Maintenance lists it again each pass, and it rejoins once nothing is blocked. If a re-read finds a block, the
  replica is detached at once.
- **B2 (readiness):** the usual rule applies to the replicas left. With 3 indexers and W = 2, a block on one still
  serves. If fewer than N − W + 1 admitted replicas remain, every request answers 503. That is never an empty or an
  older listing. A blocked data object and a blocked record affect readiness the same way.
- **B3 (withheld versions):** some key versions are withheld on every replica. These are the versions in the merged
  view when the replica was found blocked that it does not vouch for (that version or newer, with every object it
  needs listed and not blocked). For a withheld version:
  - GET and HEAD answer 451, and a copy from it is refused;
  - repair never copies it (that would rebuild blocked data elsewhere or put it back into the quorum);
  - the key still exists: it is listed, and `If-None-Match: *` fails;
  - a newer PUT or a DELETE supersedes it.

  A version the blocked replica merely missed is withheld too, because nothing tells the two apart.
- **B4 (limits):** a block placed after a replica was listed is seen at its next listing (a re-read or a restart).
  Content is not tracked across keys or uploads.

## Feature parity and limits

- **Multipart.** Up to 10,000 parts. An entry that does not fit in 1 KiB of metadata gets a manifest (store.rs).
  The same applies to keys near S3's 1 KiB key limit and to copies onto crowded objects. Ranges, CopyObject,
  multipart ETags, SigV4 and conditional PUTs are unchanged.
- **0.1.x data** loads unchanged. Entries without stamps order by mtime.
- **Cold recovery.** `recovery export` writes snapshot version 2 when a manifest key is present. `recovery read`
  fetches the manifest body from the snapshot's hosts, verifies it, and needs no indexer (tested with the mock
  indexer offline).
- **Cost.**
  - Every replica stores and uploads its own copy (N times the storage and upload).
  - A manifest adds one small upload.
  - Floors add about 80 bytes per deleted key, forever. Ledger writes cost one small upload per replica per
    maintenance pass that has new deletions.
  - A delete on a replica that lacks the key costs a ledger upload (about 45 s on the live network) before it is
    acknowledged.
  - Repair writes one object per key: keys that shared an object (copies, packed files) get one each on the
    repaired replica.
- **Rollback to 0.1.x.** Not supported once deletes, manifests or replicas exist. 0.1.x ignores floors and manifests
  (it leaves them alone as foreign v2 objects), so older versions could reappear and manifest keys disappear in it.

## What stays centralized, and what activation needs

| Still a single party or a manual step | Why |
|---|---|
| Each indexer operator, for its replica | contracts, renewal, funding, slab repair and the object list live in indexd; the SDK has no path to app-held contracts |
| The sia-s3 deployment (one writer) | indexd has no fencing; failover of the writer is an Enclave-level concern |
| The owner's signing authority | secrets (app keys, S3 credentials) and catalog versions |
| Registration on each indexer | an indexer admits an app key by its operator's action (any indexd that registers it can be listed) |

Activation needs, none of it done here:

1. One or more additional indexd instances (v0.6.0, optionally with `indexd/enclave-small.patch`) with PostgreSQL,
   run by operators verified to be independent of the minipc one.
2. A funded Siacoin wallet per indexer, for on-chain contract formation and renewal. About 14 GB of contracted
   storage per replica for today's ~4.7 GB.
3. The sia-s3 app key registered on each indexer with quota.
4. A real-network validation of this code against those indexers. Mock tests do not cover indexd's real timing,
   errors or 1 KiB limit enforcement.
5. A review, then a catalog version built from a committed, clean checkout (not from any test build) and published
   with the owner's existing authority, and a redeploy with the replica list and keys as secrets.
6. The initial migration (see "Membership changes"): every member `record.admitted` at the newest epoch, and
   `membership.phase` `stable`.

## Operator procedures

Every change of the replica list or of `writeQuorum` is a migration (see "Membership changes"). The cluster refuses
to count a replica that is not admitted, so a mistaken step leaves it unavailable, never serving an incomplete view.

- **From one indexer to three (N = 3, W = 2).** Let the single indexer run one maintenance pass on this version
  (`record.admitted`, epoch 1, on `/healthz`). Skipping this makes the three a set without records, which serves
  nothing until it has been backfilled and committed. Register the app key on the new indexers, list all three, restart. The
  old indexer keeps serving (migrating) while repair backfills the new ones. Once all three are caught up and
  loaded, maintenance commits epoch 2 (`stable`). If the old indexer is unavailable at a restart before that, the
  service answers 503; it never serves the empty new replicas.
- **Add a replica.** Register the app key, add it to the list, restart. The set serves under its old rules until the
  new one is backfilled and the change commits.
- **Replace or remove a replica.** List the departing replica with `"retiring": true` (or remove it outright if the
  rest of the old set still has N - W + 1 members and W to seal), restart, wait for `stable`, then drop it from the
  list.
- **An indexer is down for a while.** With W admitted members reachable, clients see no change. When it returns it is
  re-read and caught up. A restart during the outage needs N - W + 1 other admitted members.
- **An indexer is gone for good, or censored.** Replace it as above while the rest of its set can still commit the
  change (at most W - 1 lost; see "What a change needs"). An indexer that lost its state (or rolled back past its
  record) is not admitted until backfilled again; a fresh app key is cleaner.
- **Do not revert a committed change by editing the list back.** The old set's seals stop it from serving; the
  newer set then waits for its members.
- **Restart or replace the writer.** Stop the old process first: one writer at a time.
- **Recover without any indexer.** `sia-s3 recovery export <indexer> <snapshot>` per replica, then `recovery read`
  (README).

## Validation (native mock tests; no real indexer, host or deployment)

- Faults injected into the mock indexer:
  - a lost response after the pin was applied;
  - a call that never answers;
  - a call applied only when the test releases it, after any number of listings and restarts;
  - an offline indexer;
  - a replica rolled back to a state from before a DELETE.
- Data goes through the real SDK upload and download path: erasure coding, encryption, sector proofs.
- Main cases:
  - A deleted key stays deleted in each of these situations:
    - a pin lands after the DELETE, after maintenance reclaimed the payload, and after a cold restart;
    - stale pre-delete data is replayed;
    - a commit's response is lost;
    - a replica rolls back.
  - A hung replica delays a W=1 write only by the grace period; with W=2 it fails at the deadline.
  - Writes continue through an outage and are backfilled.
  - DELETE refuses until the deletion is durable on W replicas.
  - A 16-part manifest key, a 1000-character key, and copies of both work across replicas, survive a reload, and are
    reclaimed down to floors.
  - Cold recovery of manifest keys works with the indexer offline.
  - Membership (reproduced first, failing on 54818ba: `work/storage-membership-repro.log`):
    - one populated indexer plus two empty ones, the old one offline: not ready, not writable, the empty view never
      served (with and without a record on the old indexer);
    - replacing a member after a DELETE acknowledged while the third was down: waits while the old set may be serving
      elsewhere, migrates under the old rules, commits, and the deletion holds on every new member; reverting the
      list cannot bring the old set back;
    - an open multipart upload is handed over by a `retiring` replica and completes on the new set alone;
    - a commit interrupted after the seal (admissions that never answer) is finished before anything is served,
      also after a restart;
    - the state machine itself, record by record (`membership_states_follow_the_records`).
  - Unreadable manifests, re-reads and status text (from the storage-safety worktree, B2, B3, L1): a replica that
    cannot read a live version's manifest does not load, while a superseded one does not block and is purged; a
    re-read never swaps out a pin in flight, never waits on a busy index under the write lock, and a replaced store
    sends nothing more; signed request URLs never reach error text.
  - Version ceilings (B4): a skewed old writer's abandoned PUT stays below a new writer's DELETE; versions are stamped
    only inside a reserved range; a lagging replica gets the ceiling, and a late reservation only raises it.
  - Ceilings across membership changes: a reservation counts only voters (a member that lost its state does not
    count until re-admitted); a migration commits only once the new members hold the old writer's ceiling, carries
    it in its records, and a skewed old writer's abandoned PUT stays below a DELETE by a writer booting from the new
    set alone; a partly sealed change refuses writes and reservations until finished, also after a restart; a part
    in flight on a new member holds the commit back until re-read, and a new member that cannot read a live manifest
    never loads or counts; a returning member that missed a DELETE and a reservation cannot undo either.
  - Blocked objects (PATCH U1-B, `blocked_*`):
    - the wire, over real HTTP: requests carry `blocked=true`; indexd-fence's JSON shapes; the cursor passes a page
      that ends in a blocked entry; malformed pages are refused;
    - the listing goes past short pages and blocked-only pages to the empty page;
    - a single blocked indexer serves nothing until unblocked, then everything;
    - an acknowledged version blocked at boot is not served older from another replica, not repaired or copied, and
      is superseded by an overwrite;
    - a re-read detaches the replica, and a tombstone it hides cannot resurrect a key;
    - a manifest key whose data object alone is blocked is withheld;
    - old-rules mutant: a stale version is served;
    - fenced: the blocked replica keeps its ballot and rejoins without a second raise.

### Test memory: the disk-backed mock

Every object these tests pin is a full 12-shard slab of 4 MiB sectors. The SDK really does encrypt, erasure-code and
root-hash all of them. The vendored mock host transport kept every sector in RAM, so the 16-part manifest test on two
indexers needed more than 2 GiB and could not run under a bounded test cgroup.

**What changed.** The vendored mock (`vendor/sia-sdk-rs/sia_storage/src/rhp4/mock.rs`, `src/mock.rs`) has an optional
disk backend: `MockNetwork::with_disk_sectors(base, limit)`.
- It is opt-in. `MockNetwork::new()` still keeps sectors in memory, exactly as before.
- It is test-only: the mock module exists only under `cfg(test)` or the SDK's `mock` feature, which sia-s3 enables only
  as a dev-dependency.
- It is native-only (`cfg(not(target_arch = "wasm32"))`). The production wasm build contains none of it.

**What stays the same.** Only where the bytes rest changes:
- the SDK path: encryption, erasure coding, sector roots;
- the indexer faults;
- slow hosts and read failures;
- `clear_sectors`.

**Where the files go.**
- Each disk-backed network creates a fresh, uniquely named directory under `target/mock-sectors/`, which is on disk, not
  the tmpfs `/tmp`.
- Files are `<hex host key>/<hex sector root>.sector`, derived only from the two 32-byte binary values. No
  caller-supplied string reaches the filesystem.

**How it reads.** A read opens the file, seeks to the range and reads exactly that range.
- Its errors match the in-memory store's: "host not found" and "sector not found".
- An out-of-range request is an error instead of the in-memory slice panic.

**Writes and the budget.** Writes go to `.part` and are then renamed. A write over the byte budget, or any I/O failure,
fails the write; it is never dropped silently.

**Cleanup.** On drop, the store removes exactly the files it wrote, then the empty host directories, then its own
directory. Nothing is removed recursively, so anything else found there is left alone and reported.

**Tests.**
- `disk_and_memory_mock_sectors_answer_alike` compares both backends through the real SDK:
  - complete bytes, and ranges at the sector edges and mid-sector;
  - the identical read failure once hosts lose their sectors;
  - only hash-named files, exactly 4 MiB each, inside the store's own directory;
  - an enforced budget;
  - the directory removed on drop.
- Only `many_part_uploads_and_long_keys_use_manifests_everywhere` uses the disk backend. Its assertions, part count,
  replicas and recovery steps are unchanged.

Since version ceilings and membership records (each also a full slab) were added, the replica tests' `Net::new` is
disk-backed too: in RAM, a two-replica test with a few writes was OOM-killed at the 1 GiB test cgroup. Only the test
comparing the two stores still uses the in-memory one (`Net::in_memory`).

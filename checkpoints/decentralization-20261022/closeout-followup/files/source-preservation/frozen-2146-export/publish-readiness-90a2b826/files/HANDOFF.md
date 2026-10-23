# Site publication readiness: same-CID recovery of ipns-publisher 0xd9798e4c, then r2 (SOURCE/READ-ONLY HANDOFF)

No production action was taken. Nothing was POSTed, restarted or reconfigured. No secret, key, env or wallet was read or requested,
and there were no new public reads. Facts come from the 1.0.5 source and the b895d295 evidence
(`work/custody-publisher-assessment-20261023`).

**Source.** Line numbers are for enclave-apps `ipns-publisher/src/main.rs` at fca1fea (blob a9dcb933). They are identical at
4514d25, the source the 1.0.5 wasm was built from (inferred), up to line 718; after it, add 1.

**State at b895d295 (20:44:19Z).**
- The public record is valid: sequence **1026** pointing at `/ipfs/bafybeieuxt6…otzaou`, valid until **2026-10-30T13:03:14Z**.
- The publisher process started at about 19:27:53Z. It has `recovered: null`, an empty value, sequence 0 and
  `durableState: false`.

## 1. Does `POST /publish` re-queue Recover before Sign? Yes

- **The route (l.594–603):** it checks `authorized()` (401 if that fails) and that an identity exists (503 if not). It then calls
  `enqueue_publish()` and answers **202 `{"status":"publishing"}`**.
- **`enqueue_publish` (l.299–315):**
  - if a `Sign` or `RecoverDht` task is already queued, it does nothing, and the POST still answers 202;
  - otherwise it queues `Recover(delegate)` for each delegate (only `https://delegated-ipfs.dev` here), then `Sign`.
    `RecoverDht` is not queued, because a delegate exists.
- The 4-hour republish timer (`tick`, l.317–330) is **not** reset by a POST.

## 2. Can the recovered state be checked before Sign? No

The serve loop (l.826–842) answers pending HTTP, then runs ONE task per iteration. Recover is one blocking GET, bounded by
`REQUEST_DEADLINE` 30 s and a 20 s read timeout (`webreq.rs` l.19, l.100). Sign runs on the very next iteration.

There is no API to hold or cancel Sign. `/api/status` cannot be relied on to show `recovered` in between, and `last_error` is never
exposed. Recovery can therefore be checked only **after** the round, so the gate has to come **before** it (section 6, P1–P3).

## 3. What happens if the delegate fails but `site-root` works (seq-0 fallthrough), and what is the impact?

**What the code does** (`do_sign`, l.421–477, sequence rule l.433–445): with no recovered record and no prior record, it signs
**sequence 0** for the same value `/ipfs/bafybeieuxt6…`, valid until now + 7 days. It then writes the state file if `/data` is
writable, queues the PUT to the delegate and the DHT publish, and announces the same root to IPNI.

**Impact while 1026 is valid (until 2026-10-30T13:03:14Z):** nothing public changes. IPNS resolvers select the higher sequence,
and both records name the same CID anyway. The publisher's own `/routing/v1/ipns/<name>` would serve the seq-0 record, with the
same content. The PUT probably fails as well if egress is the cause.

**It heals itself.** On the next round whose recovery succeeds:
- the first branch fails, because `self.sequence` (0) is below `base_seq` (1026);
- the second branch applies, because `base_value == value`;
- so it signs **1026** again. No manual step is needed, and the sequence never goes backwards publicly.

**The only real hazard is changing the value while recovery fails.** The new CID would get `max(0, 0) + 1` = **sequence 1**.
Resolvers keep 1026, the old site, until 10-30. The publisher's status would show the new value, which is misleading.
- It heals as well: the next successful recovery gives `max(1026, 1) + 1` = 1027.
- Until then, the publication is silently ineffective.
- So **never combine a value change with unconfirmed recovery.**

## 4. The 1.0.5 auth mechanism

**`authorized()` (l.531–544):**
- If `api_key` is empty, every request is authorized.
- Otherwise it requires the `X-Api-Key` header, or a `?key=` query parameter, equal to `api_key`. The source notes that the fleet
  TLS proxy strips `Authorization`.

**Configured as an env reference.** The public redacted snapshot shows the deployment config holding
`"api_key": {"envReference": "$API_KEY"}` and `"ipnsKey": {"envReference": "$IPNS_ED25519_SK"}`. Source:
`work/ipns-production-cutover/snapshots/production-read-final.json`, under `deployment.envelope` and in the version template. So
auth **is configured**, as a deployment secret.

**If `API_KEY` is missing, the route is open.** `expand_env_refs` (l.78–104) clears an unset reference to "". That leaves
`api_key` empty, and `POST /publish` becomes **unauthenticated**.
- **Inference:** `$IPNS_ED25519_SK` resolved at the 19:27:53Z start, because the identity is present, so the secrets were
  delivered and `API_KEY` is probably set too.
- **To prove it**, read the start log: `config: resolved $API_KEY from the environment`, against
  `config: $API_KEY is not set; treating the value as absent`. The log prints the name only, never the value.
- **Impact if it is open:** anyone could trigger rounds. That is bounded to the cases in §3: a same-CID round is harmless, or
  ineffective while egress fails.

**Use the header, never `?key=`.** Query strings end up in proxy and access logs.

## 5. Root's existing credential path (metadata only; no value was read)

- **Where it lives:** deployment secrets live on the API relay. Source: `work/enclave/cli/enclave.mjs`, "per-deployment secrets"
  at l.3035–3060, and `cmdSecrets` at l.3095–3130.
- **How the owner reads them:** `enclave secrets ls 0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a [--show]`.
  This calls `POST /v1/secrets/<id>/get`, signed with a single-use `personal_sign` over `enclave-secrets:get:<id>:<expiry>`.
  The relay checks the signer against the **on-chain owner**, here `0x0b2d009c…eE61`, the Enclave administrator wallet.
- **Even names-only reads fetch values.** Without `--show`, the values are still transferred to the CLI process and only masked
  on display.
- **Historical record:** the 2026-09-25 restore inventory recorded this deployment's relay secrets as staged
  (`relay.secretsStaged: true`).
- **So:** Path B needs an owner wallet signature to obtain `API_KEY`. That is root's decision. Path A needs no credential at all.

## 6. Concrete procedure (root)

**Prerequisites (all read-only, root-side):**
- **P1. App start log** of `0xd9798e4c…` since 19:27:53Z, lines beginning `[ipns-publisher]`. Look for:
  - `config: resolved $API_KEY…` or `…is not set…`;
  - `https://delegated-ipfs.dev: GET failed: …` / `GET answered N` / `knows sequence N`;
  - `publish aborted: <reason>`;
  - `state file: sequence …`.
- **P2. Egress proof for this partition after the relaunch:** outbound 443 works to `delegated-ipfs.dev` and
  `ipfs.enclave.host`. Without it, the round repeats the failure.
- **P3. Public reads:**
  - `GET https://d9798e4c.app.enclave.host/api/status` must show `queuedTasks` 0; note `uptimeSecs`. The next automatic round
    is at process start + 14400 s, about **2026-10-23T23:27:53Z** if the process has not restarted.
  - The delegate record must still be sequence 1026, `/ipfs/bafybeieuxt6…`:
    `curl -sS --max-time 30 -H 'accept: application/vnd.ipfs.ipns-record' https://delegated-ipfs.dev/routing/v1/ipns/k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52 > rec.bin`
    then `ipfs name inspect --verify k51qzi5uqu5dma8l0w05o02gkz7l80f3r3mb536qh8fuhrr2qj4nsa2afe9b52 < rec.bin`, in a throwaway
    `IPFS_PATH`.
  - `curl -sS https://ipfs.enclave.host/site-root` must still print `/ipfs/bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou`.
  - **Do not edit `site-root`.**

**Path A (preferred: no credential, no request).** Once P1 and P2 show working egress, let the automatic round run, then do the
post-checks.

**Path B (one bounded request, only if root decides it is safe).**
1. Obtain `API_KEY` through the credential path in §5. Put it in a 0600 header file containing `X-Api-Key: <value>`, so the
   value is not in argv.
2. Send ONE request:
   `curl -sS --max-time 30 -o resp.json -w '%{http_code}\n' -X POST -H @"$HDR" https://d9798e4c.app.enclave.host/publish`
3. Read the answer:
   - **202** means queued;
   - **401** means a wrong or absent key: stop;
   - **503** means no identity: stop.
4. Do not retry. A second POST is a no-op only while the round is still queued; afterwards it starts another round.
5. Delete the header file.

**Post-checks (either path; the round takes about 1–2 min: Recover ≤ 30 s, Sign, PUT ≤ 30 s).**
- **Success:**
  - `/api/status` shows `sequence` 1026, `value` `/ipfs/bafybeieuxt6…`, `recovered` `{sequence:1026, source:"https://delegated-ipfs.dev"}`,
    `delegates[0].outcome` "ok", and a current `publishedAt`;
  - the delegate record keeps sequence 1026, with validity about now + 7 days;
  - `mode` "dht" only means the DHT client exists; it does not mean a DHT store succeeded.
- **Recovery failed:** `recovered` is null, `sequence` 0 and the value is set. This is the harmless seq-0 case from §3. Fix
  egress; the next successful round converges to 1026. Change nothing else.
- **Value source failed again:** the value is empty. Fix egress.

## 7. Then, r2 publication (existing reviewed flow; nothing new)

**The flow.** `docs/site-release.md` "Publication", using `scripts/site-release/publish.mjs`:
- `site/deploy.sh publish-plan --release <r2 dir> --publisher-config <owner config show> --deployment 0xd9798e4c… --out DIR`;
- then the owner runs `enclave config set <id> --file …`, or `--unsigned --from 0x0b2d…`.
- This changes only `value`, from the URL to `/ipfs/bafybeihm7f2mhw6…`, and keeps the key reference byte for byte.
- It is a production, wallet-held record, so publication goes in mode `plan`.

**The host relaunches the app.** The startup round must again recover 1026, so repeat P1–P2 first.
- **Success:** sequence **1027** with the r2 CID.
- **If it signs sequence 1** (recovery failed), r2 is not visible while 1026 is valid. It self-heals to 1027 on the next round
  whose recovery succeeds.
- **Check afterwards:** `/api/status` shows the new value and sequence 1027, and an independent resolver gives `/ipfs/<r2 CID>`.

## Durability note (no source change proposed)

`/data/ipns-publisher-state.json` (STATE_FILE, l.37) was durable on 10-20 (`durableState: true`) and was absent at the 19:27:53Z
start. Without it, sequence safety depends entirely on the delegate GET. The root metadata query is whether `/data` is mounted and
persistent for this deployment in the relaunched guest.

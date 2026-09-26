# Test 2: the DELEGATION path (the one Steven's apps will take), on the NucBox hv node

Written by enclave-5d for enclave-87. enclave-d1 executes it; b4 and d1 review it. Every deployment here is NON-SENSITIVE
(hello-world 1.0.4), owned by OUR agent wallet `0x29479bf04ed889d46a7afb7f292b9bb26e12647c`, and funded minimally from it
(enclave-87 approved).

THE KEY (enclave-d1's S2 and S4): every command that uses the agent key runs on the WORKSTATION as `bash -ic '…'`. The
interactive profile loads `ETH_AGENT_WALLET` into that one process. It is never `export`ed at a prompt, never typed, printed
or written, and never taken to the box. The CLI staged on the box (cli-864be4e5, dadecbb1…) is for the OPERATOR-owned test 1
(hvnode-test1.ps1) only.
Plan about 1.5 h: (c) and (b) each wait out a lease lapse, up to `leaseSec` (1800 s) after the last renewal (enclave-d1).

## What it proves
An owner who is NOT the box's operator gets a `hyperv-partition-per-app` deployment served by the NucBox ONLY through a
signed delegation to the operator, and ONLY while that consent holds:
- **positive:** with the delegation in `NODE_DIR\delegations\`, the node claims the owner's deployment, its partition
  serves, and public TLS reaches it through B (with M4's CA certificate once v42 and B are live);
- **(a) E4:** the same owner's deployment that requires `snp-guest-per-app` is NEVER claimed or served by the NucBox;
- **(b) expiry:** with a 10-minute delegation, at expiry the RELAY stops serving at once (it checks expiry at decision
  time), and the NODE stops renewing: it holds the lease unrenewed and stops the partition at lapse;
- **(c) removal:** with the delegation file removed, the relay stops serving at the node's next attach, and the node
  holds the lease unrenewed until it lapses, then stops the partition.
Nothing is released on chain in (b) or (c).

## Prerequisites (each is a stop if missing)
- **v42 on the box**:
  - the node from main at or after b4's attach frame and restart recovery (b4 names the final pin);
  - the v42 manager set, and the rebuilt candidate (guest 298924ae; its canary is CANARY-v41 section 0);
  - installed with rollout v2.3 (f605bc6b or later).
  Test 1 is unaffected and may keep running.
- **e3's B on nan**:
  - `RELAY_HVNODE_OPERATORS` names `0x389c3f030a209d04d026228d2d053feb75dbadca` (NEVER `TRUSTED_OPERATORS`);
  - `RELAY_HVNODE_ATTACH=1`;
  - the node's attach is v2 (node.log: `attach signature v2, N delegation(s)`).
- **`MAIN`: a checkout of main at or after c2bbf9518, with node_modules.** That gives the CLI with `deploy --isolation`,
  the read-after-write wait and the live catalog from the address book. It also gives e3's `scripts/host-delegation.mjs`,
  which the rollout branch does not carry. For example:
  `git -C ~/Projects/enclave worktree add ~/enclave-bench/wt-test2-main origin/main && ln -s ~/Projects/enclave/node_modules ~/enclave-bench/wt-test2-main/node_modules`,
  then `MAIN=~/enclave-bench/wt-test2-main`. The CLI runs with an EMPTY home, never the compromised
  ~/.config/enclave/key: `mkdir -p ~/enclave-bench/test2-home` (keep it empty). Every CLI call below is, in full,
  `bash -ic 'cd ~/enclave-bench/wt-test2-main && HOME=~/enclave-bench/test2-home XDG_CONFIG_HOME=~/enclave-bench/test2-home ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs …'`
  (literal paths: a single-quoted `bash -ic` sees no unexported shell variable; the key is expanded by the inner,
  profile-loaded shell), written `CLI …` for short.
- **A public route to the box (enclave-d1's M1).** `https://<id8>.app.enclave.host` reaches the NucBox only through us-west,
  and B's step 1b there is HELD (Steven's ssh). Until it lands, the public name reads 000 whatever the node does. So run
  the watch with `VIA=x`: it reaches the partition through nan's `/x/<id>/https` splice (xsplice.mjs, the WebSocket the SNI
  relay itself opens). nan's api-relay admits that splice only while B's owner-only row serves the deployment NOW. That
  is the data plane's own decision, not `served=`'s report of it. `x=open … k=200 spki=<key>` is reach; `x=refused(<HTTP>)`
  is the relay refusing. Once step 1b lands, run the watch both ways.
- **Gas and USDC:**
  - the operator holds ≥ 0.0005 ETH (R3), and the agent wallet holds a little Base ETH for its own transactions;
  - the agent wallet holds a few cents of USDC.
  - The HOST charge is waived: nucbox-k11's registry `payoutWallet` IS the agent wallet (read 2026-09-26 02:2xZ). On
    ledger rev 12, a lease claimed by a box whose payout wallet is the deployment's owner is rate 0 (free
    self-hosting; test2-watch prints `rate=0` once the NucBox holds it). The publisher fee and the platform's share,
    if any, still leave at funding.
- **Tools:**
  - `delegation-sign.mjs` (here): signs the agent wallet's delegation with the SAME module the relay and the node
    verify with. A delegation that does not verify is renamed `<out>.INVALID`, so it is never copied to the box
    (enclave-d1's S3);
  - `xsplice.mjs` (here, read-only): the `VIA=x` public check above;
  - `test2-watch.sh <id>` (here, read-only): the owners and deployments the relay serves, public TLS with and without CA verification, and
    the ledger's runner, lease, rate and envelope;
  - on the box: `hvnode-accept.ps1 -DeploymentId <id>`, and the node's loopback `http://127.0.0.1:9600`.
- Keep a watch running for each id through every step (VIEM_DIR = a checkout with viem and ws; ~/Projects/enclave by
  default):
  `while :; do VIA=x test2-watch.sh $ID; sleep 30; done | tee -a watch-$ID8.log`.

## 1. The delegation (workstation, then the box)
```
bash -ic 'node ~/enclave-bench/wt-hvnode-rollout/windows/node/ops/hv-node-rollout/test2/delegation-sign.mjs \
  --operator 0x389C3f030a209D04D026228D2D053fEB75DbadcA --box nucbox-k11 --days 1 \
  --expect-owner 0x29479bf04ed889d46a7afb7f292b9bb26e12647c --out ~/enclave-bench/test2/agent-2947.json'
cd $MAIN && node scripts/host-delegation.mjs verify ~/enclave-bench/test2/agent-2947.json \
  --operator 0x389C3f030a209D04D026228D2D053fEB75DbadcA --box nucbox-k11        # no key: a check only
```
- Record:
  - the printed text: the 7-line `enclave-host-delegation-v1` message and its expiry;
  - the file's sha256;
  - the owner's levers.
  e3's `verify`, the relay's own module, must say VALID.
- d1 copies the file to the box as `C:\Users\claude\vbs-like\hvnode\state\delegations\agent-2947.json` (create
  `delegations\` if absent). It inherits `state\`'s ACL, SYSTEM + Administrators only (hvnode-install.ps1 sets it with
  inheritance): check with `icacls`.
- Expect:
  - at the next 30 s tick, loopback `/availability`: `owners` = [0x389c…, 0x2947…] (the operator first);
  - within about 1 minute (within 2 if the node re-attached in the last 2 minutes: the re-attach check is its own 30 s
    timer with a 2-minute minimum gap), node.log: `the owners this node serves changed since its attach: attaching
    again so the relay serves the same set`, then `… attach signature v2, 1 delegation(s)`;
  - the relay took it: the watch's relay part reads `ownerOnly=true owners=[0x2947(until <expiry>),0x389c(op)]` (B's
    row `served`, from that attach). nan's journal shows only `[tunnel] nucbox-k11 attached via …` at an attach, and
    `hosting delegation #i NOT honoured: <reason>` for a refused one: that is a STOP (enclave-b4).
- An invalid file is logged once: `delegation agent-2947.json ignored: <reason>`. That is a STOP. Fix it and re-sign;
  never edit the file.

## 2. Positive: the delegated owner's partition app
```
CLI deploy hello-world:1.0.4 --cpu 0.01 --fund 0.01 --isolation hyperv-partition-per-app --no-wait --yes   # prints ID2
```
(If it created the deployment but did not fund it, run `CLI fund $ID2 --usdc 0.01 --yes`. If it refuses 0.01 as too
little, use the smallest amount it accepts, and record it.)
- The watch, until all of these hold:
  - `runner=nucbox-k11 … (live) … rate=0`;
  - `served=yes until=<the lease end>`;
  - `x=open … k=200 spki=<K2's first 16 hex>` (VIA=x), and `ca=200` once M4 is live.
- The box: `hvnode-accept.ps1 -Commit <c> -DeploymentId $ID2`:
  - A4: `owners` lists 0x2947…;
  - A7: the partition runs, T0-hv, transportKeySha256 = K2;
  - A9: no session = 401, a stranger's session = 404.
  (NOT `-OwnerRestart`: the operator does not own ID2.)
- The workstation: the VIA=x watch is R4 until B's step 1b lands (200 over the partition's TLS, SPKI = K2). After it,
  also `hvnode-accept-remote.sh $ID2 K2` (R4 on the public name: 200 "Hello", the served key = K2).
- M4 (once v42, B and hvcert are live):
  - node.log: `<id10> certificate: <id8>.app.enclave.host installed in partition <instance> …`;
  - `curl -s https://<id8>.app.enclave.host/` VERIFIES (watch `ca=200`).
PASS = all of it.

## 3. Negative (a), E4: an SNP-requiring deployment of the SAME owner is never the NucBox's
BEFORE creating ID3 (enclave-d1's S1): metal-iso0 is production, mid-rollout for Steven's apps, in enclave-63's lane,
with a shared guest pool. Tell enclave-63, and get a yes on the pool's headroom, before the deploy.
```
CLI deploy hello-world:1.0.4 --cpu 0.01 --fund 0.01 --isolation snp-guest-per-app --no-wait --yes   # prints ID3
```
The owner IS served here (the delegation), so the owner gate passes. Two independent gates must still keep ID3 off the
NucBox:
- **the node** (chain.mjs claimPolicy) refuses it for the backend. If it evaluated ID3 before another box claimed it, its
  loopback `/v1/deployments` record for ID3 is `refused` with `it requires isolation backend snp-guest-per-app, and
  this box runs hyperv-partition-per-app`. A box that already holds a live lease on it makes the NucBox skip it, so the
  record may be absent: say which. A claimPolicy refusal is recorded, NOT logged: there is no node.log line for it, and
  the relay's secrets probe is never asked for ID3 (enclave-b4).
- **the relay** (B's servesDeploymentUntil) serves an owner-only row only a deployment requiring
  `hyperv-partition-per-app`.
- Observed:
  - the watch: `runner` is never nucbox-k11, and `served=no` on the nucbox-k11 row, for the whole test;
  - manager.log never names ID3;
  - node.log has no `claimed <id10>`.
- metal-iso0 may claim and serve ID3. The agent wallet is its payout wallet too, and a no-config app is free there. That
  is expected and not the NucBox's.
- Observe for 10 minutes, then d1 REFUNDS ID3 AT ONCE: `CLI refund $ID3 --yes` (`CLI stop $ID3 --yes` if nothing is
  refundable). Do not wait for step 6, which comes only after (c) and (b), about an hour of lapses. Tell enclave-63
  when it is gone.
PASS = none of the NucBox's gates let it through: never its runner, never in its served set, never spawned.

## 4. Negative (c): the delegation file REMOVED
- d1 MOVES `state\delegations\agent-2947.json` out of `delegations\`. Renaming it inside the directory is not enough:
  any `*.json` there is read. Read the time.
- Expect:
  - at the next tick, `/availability` `owners` = [0x389c…] only;
  - within about 2 minutes, node.log `… attaching again …` then `attach signature v2, 0 delegation(s)`, and the watch
    `owners=[0x389c(op)] served=no`, and the data plane refuses it: `x=refused(<HTTP>)` (VIA=x);
  - the node HOLDS ID2. Loopback `/v1/deployments`: ID2 is `held`, `…serves only its operator's and its delegated
    owners' deployments; this one is owned by 0x2947…: held - not started, not renewed, not released…`. The partition
    still runs (A7), and node.log has NO `renewed <id10>` from here on;
  - at the ledger's leaseUntil (read it AT the removal: it can be up to `leaseSec`, 1800 s today, after the last renewal):
    node.log `stopped <id10>: its lease lapsed while held for an owner this box does not serve (0x2947…)` (the owner as
    the ledger read returns it, checksummed: match `0x2947` case-insensitively), and the VM is gone (A7 finds none);
  - no release transaction for ID2: the watch keeps `runner=nucbox-k11 … (lapsed)`. It is not re-claimed while the
    owner is not served.
PASS = all of it, with the times read.

## 5. Negative (b): a SHORT-expiry delegation (10 minutes)
Run it after (c) has lapsed and stopped ID2.
```
node …/delegation-sign.mjs --operator 0x389C3f030a209D04D026228D2D053fEB75DbadcA --box nucbox-k11 --minutes 10 \
  --expect-owner 0x29479bf04ed889d46a7afb7f292b9bb26e12647c --out agent-2947-10m.json
```
- Put it in `delegations\`; the 1-day file stays OUT. The owner is served again, so the node re-claims ID2 (its lease
  lapsed; nothing blocks it).
- Wait for `runner=nucbox-k11 (live)`, `served=yes until=<the DELEGATION's expiry>` (B serves until the earlier of the
  lease end and the expiry), and `x=open … k=200` on a NEW key.
- If the 10 minutes run out before ID2 serves again, sign a fresh one with `--minutes 15`, and record that.
- At the expiry printed by the signer (read the clock):
  - **the RELAY stops at once, without waiting for an attach.** The next watch line reads `served=no`, and within a
    minute of the expiry the data plane refuses a new connection: `x=refused(<HTTP>)` (VIA=x; nan's /x gate checks the
    delegation's expiry at decision time, as the SNI splice does).
    `served=` decides; `owners=` may still read `0x2947(until <a past time>)` for up to 60 s, until B's re-check or the
    node's re-attach rewrites the row (enclave-b4). If B's 60 s re-check of the attached delegations runs before the node re-attaches, nan's journal MAY also show
    `[tunnel] nucbox-k11 served owners now 0x389c…`: the relay dropping the owner on its own (a race with the
    re-attach, so not required; enclave-b4).
  - **the NODE**, at its next tick:
    - `delegation agent-2947-10m.json ignored: expired at <sec>`;
    - `owners` = [0x389c…];
    - a re-attach within about 2 minutes with 0 delegation(s);
    - ID2 `held`, never renewed, and at the lease end `stopped <id10>: its lease lapsed while held …`.
    Nothing is released.
PASS = the relay's stop within a minute of the expiry, and the node's hold, then its stop at lapse.

## 6. Teardown ("refund and cancel")
```
CLI refund $ID2 --yes      # `cancel` is the same command; ID3 was refunded right after (a)
```
- `refund` returns the host's escrow and CANCELS (deactivates) the record. If it says `nothing refundable yet: … reserved
  for the lease`, retry after that lease ends. If it says `nothing to refund`, cancel with `… stop <id> --yes`
  (setActive false).
- d1 removes every agent-wallet file from `state\delegations\`, and `owners` returns to [0x389c…].
- The watch, for both ids: `active=false`, `served=no`, `x=refused(…)`.
- Evidence to keep:
  - both delegation files' sha256s and texts (a signed consent, not a secret);
  - the watch logs, node.log and manager.log excerpts, and the CLI outputs.
  The key never appears in any of them: grep for its ADDRESS only.

## Notes
- Steven's apps take the same path with HIS delegation, never signed by us. He signs it in his Trezor, from
  `node scripts/host-delegation.mjs text --owner 0x0b2d… --operator 0x389C… --box nucbox-k11`. That happens only on v42,
  after S5 and the release decision.
- Timings are the node's and the ledger's:
  - a 30 s tick;
  - a re-attach at most every 2 minutes;
  - a 15-minute renewal lead;
  - the ledger's lease quantum: read `leaseUntil`, don't assume it.

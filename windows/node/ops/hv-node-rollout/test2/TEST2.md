# Test 2: the DELEGATION path (the one Steven's apps will take), on the NucBox hv node

Written by enclave-5d for enclave-87. enclave-d1 executes it; b4 and d1 review it. Every deployment here is NON-SENSITIVE
(hello-world 1.0.4), owned by OUR agent wallet `0x29479bf04ed889d46a7afb7f292b9bb26e12647c`, and funded minimally from it
(enclave-87 approved). The agent key lives only in `ETH_AGENT_WALLET`, exported in the shell beforehand: it is never
typed on a command line, printed or written.

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
- **The CLI from main 864be4e5 or later** (`deploy --isolation` and the read-after-write wait). Run it with an EMPTY
  home, never the compromised ~/.config/enclave/key:
  `H=$(mktemp -d); HOME=$H ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs …`.
- **Gas and USDC:**
  - the operator holds ≥ 0.0005 ETH (R3), and the agent wallet holds a little Base ETH for its own transactions;
  - the agent wallet holds a few cents of USDC.
  - The HOST charge is waived: nucbox-k11's registry `payoutWallet` IS the agent wallet (read 2026-09-26 02:2xZ). On
    ledger rev 12, a lease claimed by a box whose payout wallet is the deployment's owner is rate 0 (free
    self-hosting; test2-watch prints `rate=0` once the NucBox holds it). The publisher fee and the platform's share,
    if any, still leave at funding.
- **Tools:**
  - `delegation-sign.mjs` (here): signs the agent wallet's delegation with the SAME module the relay and the node
    verify with;
  - `test2-watch.sh <id>` (here, read-only): the relay's served set, public TLS with and without CA verification, and
    the ledger's runner, lease, rate and envelope;
  - on the box: `hvnode-accept.ps1 -DeploymentId <id>`, and the node's loopback `http://127.0.0.1:9600`.
- Keep a watch running for each id through every step:
  `while :; do test2-watch.sh $ID; sleep 30; done | tee -a watch-$ID8.log`.

## 1. The delegation (workstation, then the box)
```
node windows/node/ops/hv-node-rollout/test2/delegation-sign.mjs \
  --operator 0x389C3f030a209D04D026228D2D053fEB75DbadcA --box nucbox-k11 --days 1 \
  --expect-owner 0x29479bf04ed889d46a7afb7f292b9bb26e12647c --out agent-2947.json
node scripts/host-delegation.mjs verify agent-2947.json --operator 0x389C3f030a209D04D026228D2D053fEB75DbadcA --box nucbox-k11
```
- Record:
  - the printed text: the 7-line `enclave-host-delegation-v1` message and its expiry;
  - the file's sha256;
  - the owner's levers.
  e3's `verify`, the relay's own module, must say VALID.
- d1 copies the file to the box as `C:\Users\claude\vbs-like\hvnode\state\delegations\agent-2947.json` (create
  `delegations\` if absent). It inherits `state\`'s ACL, SYSTEM + Administrators only (hvnode-install.ps1 sets it with
  inheritance): check with `icacls`.
- Expect within about 30 s (one tick):
  - loopback `/availability`: `owners` = [0x389c…, 0x2947…];
  - node.log: `the owners this node serves changed since its attach: attaching again so the relay serves the same set`;
  - then `… attach signature v2, 1 delegation(s)`;
  - the relay accepts it: nan's journal shows `[tunnel] nucbox-k11 served owners now 0x2947…(until <expiry>), 0x389c…`
    (e3 or 63 reads it).
- An invalid file is logged once: `delegation agent-2947.json ignored: <reason>`. That is a STOP. Fix it and re-sign;
  never edit the file.

## 2. Positive: the delegated owner's partition app
```
HOME=$H ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs deploy hello-world:1.0.4 --cpu 0.01 --fund 0.01 \
  --isolation hyperv-partition-per-app --no-wait --yes         # the id it prints = ID2
```
(If it created the deployment but did not fund it, run `… fund $ID2 --usdc 0.01 --yes`. If it refuses 0.01 as too
little, use the smallest amount it accepts, and record it.)
- The watch, until all of these hold:
  - `runner=nucbox-k11 … (live) … rate=0`;
  - `served=yes until=<the lease end>`;
  - `k=200`, and `ca=200` once M4 is live.
- The box: `hvnode-accept.ps1 -Commit <c> -DeploymentId $ID2`:
  - A4: `owners` lists 0x2947…;
  - A7: the partition runs, T0-hv, transportKeySha256 = K2;
  - A9: no session = 401, a stranger's session = 404.
  (NOT `-OwnerRestart`: the operator does not own ID2.)
- The workstation: `hvnode-accept-remote.sh $ID2 K2`. R4 must answer 200 "Hello", and the served key must be K2.
- M4 (once v42, B and hvcert are live):
  - node.log: `<id10> certificate: <id8>.app.enclave.host installed in partition <instance> …`;
  - `curl -s https://<id8>.app.enclave.host/` VERIFIES (watch `ca=200`).
PASS = all of it.

## 3. Negative (a), E4: an SNP-requiring deployment of the SAME owner is never the NucBox's
```
HOME=$H ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs deploy hello-world:1.0.4 --cpu 0.01 --fund 0.01 \
  --isolation snp-guest-per-app --no-wait --yes                  # ID3
```
The owner IS served here (the delegation), so the owner gate passes. Two independent gates must still keep ID3 off the
NucBox:
- **the node** (chain.mjs claimPolicy) refuses it for the backend. If it evaluated ID3 before another box claimed it, its
  loopback `/v1/deployments` record for ID3 is `refused` with `it requires isolation backend snp-guest-per-app, and
  this box runs hyperv-partition-per-app`. A box that already holds a live lease on it makes the NucBox skip it, so the
  record may be absent: say which.
- **the relay** (B's servesDeploymentUntil) serves an owner-only row only a deployment requiring
  `hyperv-partition-per-app`.
- Observed:
  - the watch: `runner` is never nucbox-k11, and `served=no` on the nucbox-k11 row, for the whole test;
  - manager.log never names ID3;
  - node.log has no `claimed <id10>`.
- metal-iso0 may claim and serve ID3. The agent wallet is its payout wallet too, and a no-config app is free there. That
  is expected and not the NucBox's; tear it down promptly (step 6).
PASS = none of the NucBox's gates let it through: never its runner, never in its served set, never spawned.

## 4. Negative (c): the delegation file REMOVED
- d1 MOVES `state\delegations\agent-2947.json` out of `delegations\`. Renaming it inside the directory is not enough:
  any `*.json` there is read. Read the time.
- Expect:
  - at the next tick, `/availability` `owners` = [0x389c…] only;
  - within about 2 minutes, node.log `… attaching again …` then `attach signature v2, 0 delegation(s)`, and the watch
    `served=no`: public TLS through the relay is refused (k=000);
  - the node HOLDS ID2. Loopback `/v1/deployments`: ID2 is `held`, `…serves only its operator's and its delegated
    owners' deployments; this one is owned by 0x2947…: held - not started, not renewed, not released…`. The partition
    still runs (A7), and node.log has NO `renewed <id10>` from here on;
  - at the ledger's leaseUntil (read it; the quantum is `leaseSec`, 1800 s today): node.log `stopped <id10>: its lease
    lapsed while held for an owner this box does not serve (0x2947…)`, and the VM is gone (A7 finds none);
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
  lease end and the expiry), and k=200 on a NEW key.
- If the 10 minutes run out before ID2 serves again, sign a fresh one with `--minutes 15`, and record that.
- At the expiry printed by the signer (read the clock):
  - **the RELAY stops at once, without waiting for an attach.** The next watch line reads `served=no`, and a new
    connection is refused (k=000) within a minute of the expiry. The SNI splice checks `until` at decision time.
  - **the NODE**, at its next tick:
    - `delegation agent-2947-10m.json ignored: expired at <sec>`;
    - `owners` = [0x389c…];
    - a re-attach within about 2 minutes with 0 delegation(s);
    - ID2 `held`, never renewed, and at the lease end `stopped <id10>: its lease lapsed while held …`.
    Nothing is released.
PASS = the relay's stop within a minute of the expiry, and the node's hold, then its stop at lapse.

## 6. Teardown ("refund and cancel")
```
HOME=$H ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs refund $ID2 --yes      # `cancel` is the same command
HOME=$H ENCLAVE_KEY="$ETH_AGENT_WALLET" node cli/enclave.mjs refund $ID3 --yes
```
- `refund` returns the host's escrow and CANCELS (deactivates) the record. If it says `nothing refundable yet: … reserved
  for the lease`, retry after that lease ends. If it says `nothing to refund`, cancel with `… stop <id> --yes`
  (setActive false).
- d1 removes every agent-wallet file from `state\delegations\`, and `owners` returns to [0x389c…].
- The watch, for both ids: `active=false`, `served=no`.
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

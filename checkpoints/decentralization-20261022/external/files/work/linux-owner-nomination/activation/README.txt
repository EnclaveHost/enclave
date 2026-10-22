METAL0 OPERATOR OWNER NOMINATION - ROOT INTEGRATES AND ACTIVATES (prepared by Claude, 2026-10-21). Nothing here was run
against production; no image was built; the running deabf8f90 control, its config, admission, guests and leases are
untouched.

WHAT IT DOES (owner-nomination.patch; ../RESULT.txt has the evidence)
With the host controller's explicit public config `ownerNomination` (metal0-owner-nomination.json here) - and only with
it - the supervisor in the measured control sends exactly ONE proposeOwner(0x4dde6d1b…, 0x0b2d009c…ee61) from the
registered operator 0xc9d0835c… to the ORIGINAL EnclaveHostOwnership 0xbbd885d3…, through its one serialized operator
transaction queue, when an RPC quorum (publicnode, mainnet.base.org, blastapi; 2 of 3) at one canonical agreed block shows:
code hash 0xe38a0e16… (the reviewed one), registry() == 0x868eb7fc…, registry.get(host) active with this operator and
endpoint https://api.enclave.host/t/metal0, authority owner 0 AND pending 0, and the exact call simulates. Pending ==
0x0b2d… or owner == 0x0b2d…: done, nothing sent. ANY other owner/pending (e.g. the alternate f5… admin): refused, never
replaced. The calldata is byte-identical to outputs/metal0-production-owner-enrollment/transactions.json step 1
(checked in run-v3). The key never leaves the guest; no other transaction kind exists in this path.

INTEGRATION (root)
1. Review owner-nomination.patch (11 files; INVENTORY.txt has before/after hashes). It applies cleanly to main's working
   tree as of this run (patch --dry-run exit 0); main's measured-control.mjs had moved by one unrelated line (SECRET_NAME
   TOKENS?) since the copy - composed without conflict.
2. Compose the next Linux control release with it (the overlay installs /opt/metal/owner-nomination.mjs because gsup
   imports it; the supervisor closure adds app/metal/guest/owner-nomination.mjs and app/network/host-owner-nomination.mjs)
   -> new measurement -> additive admission -> the existing gated activation (gate v4 + app-paid renewals + audit).
   This image change is what makes nomination possible; the config alone does nothing on deabf8f90.
3. Prerequisite: the operator 0xc9d0835c… pays this one proposeOwner's gas itself (~50k gas; app-paid lease gas does not
   cover it). Check its public balance first.
4. Add to /home/steven/Projects/enclave/metal/config.json, beside publicUrl (which must be https://api.enclave.host/t/metal0):
     "ownerNomination": <the contents of metal0-owner-nomination.json>
   fw_cfg, unmeasured, public. The launcher refuses the launch if it is invalid, names another endpoint, or (when the
   config carries registryKey) another operator. Absent = nothing is ever proposed.
5. After the image is kept: ~60 s after registration the supervisor makes a pass (then every 5 min until settled).
   Observe public /v1/health `ownerNomination` (status sent -> done "… is nominated; the owner wallet accepts next") and
   the chain: authority(0x4dde6d1b…) pendingOwner == 0x0b2d009c…ee61, exactly one proposeOwner from 0xc9d0835c….
6. Human wallet steps afterwards (unchanged, outside the host): 0x0b2d… acceptOwner (transactions.json step 2), place the
   policy document, then setPolicy (step 3). Admin rights and platform policy enforcement are unchanged.

ROLLBACK / LIMITS
- Remove `ownerNomination` from config.json (+ restart): nothing further is proposed. A pending nomination that nobody
  accepts grants nothing. This path never cancels or replaces a proposal; cancelling one would need the operator key and
  is NOT provided here (by design: no general operator-transaction handler).
- Sends are bounded (3 per config across restarts; same-bytes re-broadcasts bounded at 3); failures are logged and
  retried every 5 minutes; they never touch leases, renewals or guests.
- Journal (v2): nothing is ever broadcast unless the record holding it was strictly written first (a read-only or full
  state disk = nothing sent). A recorded nomination that fails validation ("blocked-journal") or one recorded under a
  different config ("blocked-unresolved", until it settles on chain) stops all sends; /v1/health shows which. Changing
  `ownerNomination` while one is in flight therefore waits for the old one to land or be overtaken - nothing is replayed
  or cancelled by this path. A blocked-journal record needs manual reconciliation (inspect the state file's
  ownerNomination record; nothing here deletes it).

"""Build the isolated Linux candidate (shadow-b) from CURRENT main supervisor.js and Dockerfile.

App-funded lease gas (design B) through the SHARED runtime network/lease-gas-runtime.mjs, the same module the Windows
candidate bundles. Claim / renew / release only; registry, bond, proof, settle and withdrawEarnings stay the operator's.
The durable release journal stays main's: every sponsored attempt and every lease it signs is persisted BEFORE a relay
sees it, and is settled from the chain by a quorum-verified receipt (success) or a nonce/deadline FENCE (never success).
No production or main-repository edits. Re-running refreshes only the named candidate files and the scoped patches.
"""
from pathlib import Path
import difflib
import shutil

root = Path(__file__).resolve().parents[1]
main = root.parent / "enclave"
target = root / "shadow-b"


def replace_once(source, before, after):
    assert source.count(before) == 1, before[:120]
    return source.replace(before, after)


src = (main / "supervisor.js").read_text()
out = src

# 1. the shared runtime (static: the image ships it, see the Dockerfile hunk)
out = replace_once(out,
    'import { mayReconcile } from "./network/registry-reconcile.mjs";   // the registration rule the Windows node follows too\n',
    'import { mayReconcile } from "./network/registry-reconcile.mjs";   // the registration rule the Windows node follows too\n'
    '// app-funded lease gas: the configuration boundary and sender shared with windows/node/chain.mjs\n'
    'import { leaseGasConfigured, loadLeaseGasConfig, configuredLeaseSender } from "./network/lease-gas-runtime.mjs";\n')

# 2. the sender: claim / renew through the app's reserve, serialized with every other operator transaction
LEASE_GAS = r'''
// ---- app-funded lease gas (work/app-lease-gas design B; the same runtime as windows/node/chain.mjs) ----------------
// The user's direction: lease claims and renewals are paid by the APP, not the host's wallet. Configured
// (ENCLAVE_LEASE_GAS_FILE + _DIGEST + _RPCS + _RELAYS, or the LEASE_GAS_* aliases), claim, renew and release are
// signed locally by the operator key (EIP-7702-delegated to the reviewed EnclaveLeaseExecutor; the authorization rides
// in a relay's transaction), sent by any listed relay and paid from the app's reserve in that same transaction. The
// host checks every landing against its own RPC quorum. A partial or invalid configuration, or a refusal (the owner
// never enabled a reserve, an empty reserve, outside the renew window...), REFUSES the lease write in words: nothing
// ever falls back to this key's ETH. Entirely unconfigured: exactly the operator-paid path above. Registry, bond,
// proof-of-time, settle and withdrawEarnings transactions are unchanged (still this key's own).
const leaseGasEnv = Object.freeze(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ENCLAVE_)?LEASE_GAS_/.test(k))));
const leaseGasActive = () => leaseGasConfigured(leaseGasEnv);
// the host's CURRENT bindings (the address book may move them): a record for another ledger or registry refuses
const leaseBindings = () => ({ chain: base, ledger: DEPLOYMENTS_ADDRESS, registry: REGISTRY_ADDRESS });
let _leaseGas = null, _onLeaseSigned = null;
function leaseGasSender() {
  if (!_leaseGas) {
    const config = loadLeaseGasConfig({ env: leaseGasEnv, ...leaseBindings() });
    _leaseGas = configuredLeaseSender({ config, account: claimSigner().account, getBindings: leaseBindings,
      log: (m) => console.log(m), onSigned: (s) => (_onLeaseSigned ? _onLeaseSigned(s) : undefined) });
  }
  return _leaseGas;
}
if (leaseGasActive()) {
  try { const c = loadLeaseGasConfig({ env: leaseGasEnv, ...leaseBindings() });
        console.log(`[lease-gas] app-funded leases ON: reserve ${c.reserve}, ${c.relays.length} relay(s), ${c.clients.length} RPC(s) (quorum ${c.quorum}); this key's ETH is never used for claim/renew/release`); }
  catch (e) { console.warn(`[lease-gas] app-funded leases are configured but cannot be loaded now (${e.message}); every claim/renew/release refuses until they can`); }
}
function leaseGasError(fn, id, e) {
  const code = e && e.code;
  const msg = `app-funded ${fn} of ${id} not sent: ${(e && e.message) || e}${code === "OverRateCap" ? " (over rate cap)" : ""}; this host's ETH is never used instead`;
  console.warn(`[lease-gas] ${msg}`);
  return Object.assign(new Error(msg), { code, leaseGas: true });
}
/** sendClaimTx's shape (a hash promise with .receipt) for claim/renew. The receipt is the one the host's own quorum
 *  verified (target, exact lease, reserve payment, ledger effect); the 7702 authorization consumes an account nonce,
 *  so it waits its turn in the one operator queue. */
function sendLeaseTx(functionName, args) {
  if (!leaseGasActive()) return sendClaimTx(functionName, args);
  const job = async () => {
    try { const r = await leaseGasSender()[functionName](...args); return { hash: r.hash, receipt: r.receipt }; }
    catch (e) { throw leaseGasError(functionName, args[0], e); }
  };
  const started = _txChain.then(job, job);
  _txChain = started.then(() => {}, () => {});
  const p = started.then((x) => x.hash);
  p.receipt = started.then((x) => x.receipt);
  p.receipt.catch(() => {});   // callers await p first; its rejection is the one they see
  return p;
}
/** A sponsored renew is valid only inside the owner's window before leaseUntil (the reserve enforces it): renew at the
 *  window's lead (fresh, verified owner policy; cached 5 min), never earlier. Unreadable: the ordinary margin, and the
 *  send then refuses in words. */
async function leaseGasRenewDue(rec) {
  const now = Date.now();
  if (!rec._leaseGasLead || now - rec._leaseGasLead.at > 300_000) {
    let ms = RENEW_MARGIN_SEC * 1000;
    try { ms = await leaseGasSender().renewLeadMs(rec.id, ms); } catch { /* refused at the send */ }
    rec._leaseGasLead = { at: now, ms };
  }
  return rec._leaseUntil * 1000 - now <= rec._leaseGasLead.ms;
}
'''
out = replace_once(out,
    'const sendClaimTx = (functionName, args) => sendOperatorTx(DEPLOYMENTS_ADDRESS, CLAIM_TX_ABI, functionName, args);\n',
    'const sendClaimTx = (functionName, args) => sendOperatorTx(DEPLOYMENTS_ADDRESS, CLAIM_TX_ABI, functionName, args);\n' + LEASE_GAS)

# 3. the durable release journal, sponsored
SPONSORED = r'''// ---- a SPONSORED release (app-funded lease gas): the same durable intent, a different transaction ----
// One attempt = one release lease (executor nonce, deadline, max charge) signed once per relay asked (only the payee
// differs). The attempt is persisted BEFORE anything is signed, and every signed lease BEFORE its relay sees it. It is
// resolved only from the chain: a quorum-verified receipt of exactly this lease is success; the executor nonce lane
// moving past it, or its deadline passing at a verified block, is a FENCE (it can never land) and never success.
const leaseIntentView = (s) => ({ payee: s.payee, nonce: String(s.nonce), deadline: String(s.deadline), kind: s.kind,
  enclaveId: s.lease.enclaveId, maxChargeWei: String(s.lease.maxChargeWei), fromBlock: String(s.fromBlock),
  operator: lc(s.operator), reserve: lc(s.reserve), executor: lc(s.executor), chainId: Number(s.chainId), ledger: lc(s.ledger) });
async function acceptSponsoredLanding(it, tx, v) {
  tx.hash = v.hash;
  const block = Number(v.blockNumber);
  const head = Number(await chainClient.getBlockNumber({ cacheTime: 0 }));
  if (head - block + 1 < RELEASE_CONFIRMATIONS) { saveStateNow(); return; }   // landed, not yet confirmed
  tx.state = "success"; tx.block = block;
  try {
    tx.released = parseEventLogs({ abi: RELEASED_EVENT, logs: v.receipt.logs, eventName: "Released", strict: false })
      .some((l) => lc(l.address) === it.ledger && lc(l.args.id) === it.id && lc(l.args.enclaveId) === it.runner);
  } catch { tx.released = false; }
  saveStateNow();
}
function sponsoredRelease(it) {
  const tx = { sponsored: true, hash: null, state: "pending", signedAt: Date.now(), intents: [] };
  const job = async () => {
    it.attempts++; it.txs.push(tx);
    saveStateNow();                                       // the attempt is durable before anything is signed
    _onLeaseSigned = (s) => {                             // each signed lease: durable before its relay has it
      tx.intents.push(leaseIntentView(s));
      tx.leaseNonce = Number(s.nonce); tx.deadline = Number(s.deadline);
      saveStateNow();
    };
    let note = "";
    try {
      const r = await leaseGasSender().release(it.id);
      await acceptSponsoredLanding(it, tx, r.verified);
      note = `landed ${tx.hash}${tx.state === "pending" ? " (confirming)" : ""}`;
    } catch (e) {
      // the state file keeps fixed words only (an error's text can name an endpoint)
      if (!tx.intents.length) { tx.state = "unsent"; tx.why = String((e && e.code) || "refused"); }        // nothing signed: nothing can land
      else if (e && e.code === "NonceConsumed") tx.state = "consumed";                                      // a fence, never this release's success
      else tx.why = String((e && e.code) || "relay");                                                      // may still land: resolved from the chain
      saveStateNow();
      note = `${tx.state}: ${String((e && e.message) || e).slice(0, 240)}`;
    } finally { _onLeaseSigned = null; }
    console.log(`[release] ${it.id} sponsored release ${it.attempts}/${RELEASE_ATTEMPTS} lease nonce ${tx.leaseNonce ?? "-"} (${it.why}; ${note}); the app's reserve pays, never this host`);
    return tx;
  };
  const p = _txChain.then(job, job);
  _txChain = p.then(() => {}, () => {});
  return p;
}
async function resolveSponsoredReleaseTx(it, tx) {
  if (it.ledger !== lc(DEPLOYMENTS_ADDRESS)) { tx.state = "ledger-moved"; saveStateNow(); return; }   // the old ledger's lease is not this one
  if (!tx.intents || !tx.intents.length) { tx.state = "unsent"; saveStateNow(); return; }            // stopped before signing: nothing can land
  const x = tx.intents[0];
  const want = { id: it.id, kind: 3, enclaveId: x.enclaveId, nonce: BigInt(x.nonce), deadline: BigInt(x.deadline), maxChargeWei: BigInt(x.maxChargeWei) };
  // settled by the identity RECORDED with the signed lease (its operator, chain, reserve, executor, ledger), never by
  // this process's current key or configuration: a rotated key or record cannot fence another signer's lease
  const recorded = { operator: x.operator, chainId: x.chainId, reserve: x.reserve, executor: x.executor, ledger: x.ledger };
  const r = await leaseGasSender().resolveSigned(want, BigInt(x.fromBlock), tx.intents.map((i) => i.payee), recorded);
  if (r.why && tx.unsettledWhy !== r.why) { tx.unsettledWhy = r.why; console.warn(`[release] ${it.id} held: ${r.why}`); }
  if (r.state === "landed") return acceptSponsoredLanding(it, tx, r.verified);
  if (r.state === "consumed" || r.state === "expired") { tx.state = r.state; tx.block = r.block; saveStateNow(); }
}

'''
out = replace_once(out,
    '// Sign locally, persist {hash, nonce}, then broadcast, inside the one operator queue (sendOperatorTx): the next operator\n',
    SPONSORED + '// Sign locally, persist {hash, nonce}, then broadcast, inside the one operator queue (sendOperatorTx): the next operator\n')
out = replace_once(out,
    'function signAndSendRelease(it) {\n',
    'function signAndSendRelease(it) {\n  if (leaseGasActive()) return sponsoredRelease(it);   // never this key\'s ETH once app-funded leases are configured\n')
out = replace_once(out,
    'async function resolveReleaseTx(it, tx) {\n  let r = null;\n',
    'async function resolveReleaseTx(it, tx) {\n  if (tx.sponsored) return resolveSponsoredReleaseTx(it, tx);   // no fence transaction: the lease deadline is the fence\n  let r = null;\n')
out = replace_once(out,
    '(${tx ? `transaction ${tx.hash}, nonce ${tx.nonce}` : "deciding"})',
    '(${tx ? (tx.sponsored ? `sponsored lease nonce ${tx.leaseNonce ?? "-"}, deadline ${tx.deadline ?? "-"}` : `transaction ${tx.hash}, nonce ${tx.nonce}`) : "deciding"})')
out = replace_once(out,
    'transactions: it.txs.map((t) => ({ hash: t.hash, nonce: t.nonce, state: t.state, ...(t.block != null ? { block: t.block } : {}) })) } });',
    'transactions: it.txs.map((t) => ({ hash: t.hash, nonce: t.nonce, state: t.state, ...(t.block != null ? { block: t.block } : {}),\n'
    '    ...(t.sponsored ? { sponsored: true, leaseNonce: t.leaseNonce ?? null, deadline: t.deadline ?? null } : {}) })) } });')

# 4. claim / renew call sites, and the renew window
out = replace_once(out,
    '    const lapsed = rec._leaseUntil * 1000 <= Date.now();\n    rec._renewing = true;\n',
    '    const lapsed = rec._leaseUntil * 1000 <= Date.now();\n'
    '    if (leaseGasActive() && !lapsed && !(await leaseGasRenewDue(rec))) continue;   // a sponsored renew waits for the app\'s window\n'
    '    rec._renewing = true;\n')
out = replace_once(out,
    'const sent = lapsed ? sendClaimTx("claim", [rec.id, _enclaveId]) : sendClaimTx("renew", [rec.id]);',
    'const sent = lapsed ? sendLeaseTx("claim", [rec.id, _enclaveId]) : sendLeaseTx("renew", [rec.id]);')
out = replace_once(out,
    '          const sent = sendClaimTx("claim", [rec.id, _enclaveId]);\n',
    '          const sent = sendLeaseTx("claim", [rec.id, _enclaveId]);\n')
out = replace_once(out,
    '    const sent = sendClaimTx("claim", [d.id, _enclaveId]);\n',
    '    const sent = sendLeaseTx("claim", [d.id, _enclaveId]);\n')
# the in-memory lead cache is not state
out = replace_once(out,
    'for (const k of ["_payTimer", "_respawning", "_renewing", "_restarting"]) delete o[k];',
    'for (const k of ["_payTimer", "_respawning", "_renewing", "_restarting", "_leaseGasLead"]) delete o[k];')

# 4b. the strict release journal and fail-closed journal loading (root review 14:54Z), from a plain data file of exact
# BEFORE/AFTER blocks (scripts/linux-supervisor-journal.hooks), applied after the hooks above
def hook_blocks(path):
    blocks, cur, mode = [], {"before": [], "after": []}, None
    for line in path.read_text().split("\n"):
        if line == "@@@@ BEFORE": mode = "before"; cur = {"before": [], "after": []}
        elif line == "@@@@ AFTER": mode = "after"
        elif line == "@@@@ END": blocks.append(("\n".join(cur["before"]) + "\n", "\n".join(cur["after"]) + "\n")); mode = None
        elif mode: cur[mode].append(line)
    return blocks
for hooks in ("linux-supervisor-journal.hooks", "linux-supervisor-scheduler.hooks"):
    for before, after in hook_blocks(root / "scripts" / hooks):
        out = replace_once(out, before, after)

# 5. the measured image ships the shared runtime and its dependencies (viem is already in the locked tree)
dsrc = (main / "Dockerfile").read_text()
dout = replace_once(dsrc,
    'COPY network/canonical.mjs network/host-capacity-record.mjs network/host-capacity-producer.mjs network/registry-reconcile.mjs ./network/\n',
    'COPY network/canonical.mjs network/host-capacity-record.mjs network/host-capacity-producer.mjs network/registry-reconcile.mjs ./network/\n'
    '# app-funded lease gas (claim/renew/release paid by the app\'s reserve): the runtime shared with the Windows node\n'
    'COPY network/lease-gas-runtime.mjs network/lease-gas-owner.mjs network/lease-executor-client.mjs network/lease-executor-authority.mjs network/lease-release-journal.mjs network/rpc-identity.mjs ./network/\n'
    # main's network/lease-executor-client.mjs re-exports ../client/: ship that implementation (and its authority import) too
    'COPY client/lease-executor-client.mjs client/lease-executor-authority.mjs ./client/\n')

for rel, text, base_text, name in (("supervisor.js", out, src, "current-supervisor"), ("Dockerfile", dout, dsrc, "current-dockerfile")):
    dest = target / rel
    if dest.is_symlink() or dest.exists():
        dest.unlink()
    dest.write_text(text)
    patch = "".join(difflib.unified_diff(base_text.splitlines(True), text.splitlines(True), fromfile="a/" + rel, tofile="b/" + rel))
    (root / "patches" / (name + ".hunk.patch")).write_text(patch)

net = target / "network"
if net.is_symlink():
    net.unlink()
net.mkdir(exist_ok=True)
for name in ("lease-executor-client.mjs", "lease-executor-authority.mjs", "lease-gas-owner.mjs", "lease-gas-runtime.mjs", "lease-release-journal.mjs", "rpc-identity.mjs"):
    dest = net / name
    if dest.is_symlink() or dest.exists():
        dest.unlink()
    shutil.copyfile(root / "network" / name, dest)
print("Rebased Linux supervisor + Dockerfile candidate from current main; main and production unchanged.")

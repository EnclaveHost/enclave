"""SUPERSEDED for Windows by scripts/delta-windows-current.py once root integrated this output into main (2026-10-20 19:18Z).
Build the isolated Windows candidate from CURRENT main, preserving shared off-chain heartbeat.

No production or main-repository edits. Re-running refreshes only the named candidate files.
"""
from pathlib import Path
import difflib
import shutil

root = Path(__file__).resolve().parents[1]
main = root.parent / "enclave"
target = root / "shadow-win"
backup = root / "root-relay-fix" / "windows-base"

def replace_once(source, before, after):
    assert source.count(before) == 1, before
    return source.replace(before, after)

HOST_JOURNAL_HOOKS = [
    ("    this.enclaveId = chain.enclaveIdOf(cfg.endpoint);\n",
     "    this.enclaveId = chain.enclaveIdOf(cfg.endpoint);\n"
     "    // app-funded leases: the durable journal of sponsored releases (a release lease may land after this process dies)\n"
     "    if (cfg.dir) chain.setLeaseJournal(path.join(cfg.dir, \"lease-release-journal.json\"));\n"),
    ('    if (!/^0x[0-9a-f]{64}$/.test(id)) return { accepted: false, reason: "id must be the bytes32 deployment id" };\n',
     '    if (!/^0x[0-9a-f]{64}$/.test(id)) return { accepted: false, reason: "id must be the bytes32 deployment id" };\n'
     '    // a sponsored release of it may still land (or the release journal failed to load): no claim or re-adoption here\n'
     '    const releaseHeld = chain.releaseHold(id);\n'
     '    if (releaseHeld) { this.#record(id, { status: "held", reason: releaseHeld }); return { accepted: false, reason: releaseHeld, standing: "held" }; }\n'),
    ("  async tick() {\n    if (!this.chainReady) return;\n",
     "  async tick() {\n    if (!this.chainReady) return;\n"
     "    // journaled sponsored releases: settled ONLY from the chain (verified receipt = released; consumed/expired = fence)\n"
     "    try { for (const r of await chain.resolvePendingReleases()) this.log(`release ${r.id.slice(0, 10)}: ${r.outcome}${r.hash ? ` (${r.hash})` : \"\"}`); }\n"
     "    catch (e) { this.log(`release journal: not settled yet (${e.shortMessage || e.message})`); }\n"),
    ("      if (rec.boundaryHeld !== true && rec.capHeld !== true && !notServing && !oneQuantum && !this.platformPolicy.serviceRefusal() && untilMs - Date.now() < RENEW_LEAD_MS) {",
     "      if (rec.boundaryHeld !== true && rec.capHeld !== true && !notServing && !oneQuantum && !this.platformPolicy.serviceRefusal() && untilMs - Date.now() < RENEW_LEAD_MS && !chain.releaseHold(id)) {"),
    ("    } catch (e) { this.log(`release ${id.slice(0, 10)} failed: ${e.shortMessage || e.message}`); }",
     "    } catch (e) {\n"
     "      // app-funded: a signed release whose relay answer was lost may still land; it is journaled and held, never reported\n"
     "      this.log(e.pending ? `release ${id.slice(0, 10)} unresolved: ${e.shortMessage || e.message}` : `release ${id.slice(0, 10)} failed: ${e.shortMessage || e.message}`);\n"
     "      if (e.pending) this.#record(id, { status: \"held\", reason: e.message });\n"
     "    }"),
]
HOST_GAS_HOOKS = [
    ("        + `. Top up ${chain.operatorAddress()} or apps stop renewing and go away`);",
     "        + (chain.leaseGasActive()\n"
     "          ? `. Lease claims, renewals and releases are paid by each app's own reserve (app-funded leases), so apps keep renewing; "
     "this ETH is only for this box's registry status, price and proof-key writes (and paid apps' proof checkpoints)`\n"
     "          : `. Top up ${chain.operatorAddress()} or apps stop renewing and go away`));"),
    ('    if ((this.gasRenewals ?? 1) <= 0) return no("the operator key has no gas left for claims");',
     '    if (!chain.leaseGasActive() && (this.gasRenewals ?? 1) <= 0) return no("the operator key has no gas left for claims");   // app-funded: the app pays'),
    ("                     && chain.operatorAddress() && (this.gasRenewals ?? 1) > 0);",
     "                     && chain.operatorAddress() && (chain.leaseGasActive() || (this.gasRenewals ?? 1) > 0));"),
    ("      gas: { operator: chain.operatorAddress() || null, low: this.gasLow === true,\n"
     "             hoursLeft: this.gasHoursLeft ?? null, renewalsLeft: this.gasRenewals ?? null },",
     "      // app-funded leases: the apps' reserves pay claim/renew/release, so \"low\" no longer means apps stop renewing; the\n"
     "      // operator's own ETH still pays registry status/price/proof-key writes (registryEthLow)\n"
     "      gas: { operator: chain.operatorAddress() || null, leases: chain.leaseGasActive() ? \"app-funded\" : \"operator-paid\",\n"
     "             low: this.gasLow === true && !chain.leaseGasActive(), registryEthLow: this.gasLow === true,\n"
     "             hoursLeft: this.gasHoursLeft ?? null, renewalsLeft: chain.leaseGasActive() ? null : this.gasRenewals ?? null },"),
    ("      gasRenewalsLeft: this.gasRenewals ?? null,   // an operator key out of gas stops renewing, and the app goes at the end of its quantum",
     "      gasRenewalsLeft: chain.leaseGasActive() ? null : this.gasRenewals ?? null,   // operator-paid only: out of gas stops renewing\n"
     "      leaseGas: chain.leaseGasActive() ? \"app-funded\" : \"operator-paid\","),
]

for rel in ("windows/node/chain.mjs", "windows/node/host.mjs"):
    src = (main / rel).read_text()
    dest = target / rel
    if dest.exists() and not (backup / rel).exists():
        (backup / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(dest, backup / rel)
    out = src
    if rel.endswith("/chain.mjs"):
        out = replace_once(out, 'import { planCheckpoints } from "./verification-checkpoints.mjs";',
            'import { planCheckpoints } from "./verification-checkpoints.mjs";\n'
            'import { leaseGasConfigured, loadLeaseGasConfig, configuredLeaseSender, openReleaseJournal } from "./lease-gas-runtime.bundle.mjs";')
        anchor = 'export const claimDeployment = (id, enclaveId) => send(addresses.deployments, DEP_ABI, "claim", [id, enclaveId]);\nexport const renewDeployment = (id) => send(addresses.deployments, DEP_ABI, "renew", [id]);'
        code = '''// Shared Linux/Windows sponsorship configuration. A partial/invalid configuration throws;
// once configured, no refusal can route a lease operation to the operator-paid sender.
const leaseGasEnv = Object.freeze(Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => /^(ENCLAVE_)?LEASE_GAS_/.test(key))));
let leaseGas = null, leaseJournal = null, onLeaseSigned = null;
const leaseBindings = () => ({ chain: base, ledger: addresses.deployments, registry: addresses.registry });
export const leaseGasActive = () => leaseGasConfigured(leaseGasEnv);
function leaseSender() {
  if (!leaseGasActive()) return null;
  if (!acct) throw new Error("no operator key on this box");
  if (!leaseGas) {
    const config = loadLeaseGasConfig({ env: leaseGasEnv, ...leaseBindings() });
    leaseGas = configuredLeaseSender({ config, account: acct, getBindings: leaseBindings,
      onSigned: (s) => (onLeaseSigned ? onLeaseSigned(s) : undefined) });
  }
  return leaseGas;
}
/** The host's durable sponsored-release journal (host.mjs passes <dir>/lease-release-journal.json at construction). */
export function setLeaseJournal(file) { leaseJournal = openReleaseJournal(file, { log: (m) => console.error(m) }); }
/** Why `id` must not be claimed, re-adopted or renewed here: a sponsored release of it may still land (or the journal
 *  failed to load). null = clear. */
export const releaseHold = (id) => (leaseJournal ? leaseJournal.hold(id) : null);
function leaseSend(fn, args) {
  if (!leaseGasActive()) return send(addresses.deployments, DEP_ABI, fn, args);
  const id = String(args[0]).toLowerCase();
  const job = async () => {
    const refuse = (why, extra = {}) => Object.assign(new Error(`app-funded ${fn} not sent: ${why}; this host's ETH is never used instead`), { leaseGas: true, ...extra });
    if (fn === "release" && !leaseJournal) throw refuse("no durable release journal on this box");
    const held = leaseJournal && (leaseJournal.corrupt() || fn !== "release") ? leaseJournal.hold(id) : null;
    if (held) throw refuse(held, { code: "ReleasePending", pending: true });
    if (fn === "release") {
      try { leaseJournal.begin(id); }                     // durable before anything is signed
      catch (e) { throw refuse(e.message, { code: e.code || "NotPersisted", pending: !!e.pending }); }
      onLeaseSigned = (s) => leaseJournal.signed(id, s); // each signed lease durable before its relay sees it
    }
    let result;
    try { result = await leaseSender()[fn](...args); }
    catch (e) {
      // a sponsored refusal is reported as such (the app's reserve / relays), never as an operator-gas problem
      let pending = false;
      if (fn === "release") {
        const signed = leaseJournal.pending().find((x) => x.id === id)?.intents.length > 0;
        if (!signed) leaseJournal.settle(id, "unsent");                  // nothing signed reached a relay: nothing can land
        else if (e.code === "NonceConsumed") leaseJournal.settle(id, "consumed");   // a fence, never this release's success
        else pending = true;                                             // may still land: settled from the chain
      }
      throw Object.assign(new Error(`app-funded ${fn} not sent: ${e.message}${pending ? " (a signed release may still land: journaled, settled from the chain)" : ""}; this host's ETH is never used instead`),
        { code: e.code, leaseGas: true, pending, cause: e });
    } finally { onLeaseSigned = null; }
    if (result.receipt.status !== "success") throw new Error(`${fn} reverted (${result.hash})`);
    if (fn === "release") leaseJournal.settle(id, "released");          // a quorum-verified receipt of exactly this lease
    return result.hash;
  };
  // 7702 authorization consumes an operator account nonce. Serialize it with ordinary sends.
  return (chainTx = chainTx.then(job, job));
}
/** Settle journaled sponsored releases from the chain: RELEASED only on a verified receipt of that exact lease; a
 *  consumed nonce or a passed deadline is a fence (the hold lifts, nothing is reported released). -> [{id, outcome}] */
export async function resolvePendingReleases() {
  if (!leaseJournal || leaseJournal.corrupt()) return [];
  const out = [];
  for (const e of leaseJournal.pending()) {
    if (!e.intents.length) { leaseJournal.settle(e.id, "unsent"); out.push({ id: e.id, outcome: "unsent" }); continue; }
    if (!leaseGasActive()) { out.push({ id: e.id, outcome: "held: app-funded leases are not configured, so it cannot be verified" }); continue; }
    const x = e.intents[0];
    const want = { id: e.id, kind: 3, enclaveId: x.enclaveId, nonce: BigInt(x.nonce), deadline: BigInt(x.deadline), maxChargeWei: BigInt(x.maxChargeWei) };
    // settled by the identity RECORDED with the signed lease, never by this process's current key or configuration
    const recorded = { operator: x.operator, chainId: x.chainId, reserve: x.reserve, executor: x.executor, ledger: x.ledger };
    const r = await leaseSender().resolveSigned(want, BigInt(x.fromBlock), e.intents.map((i) => i.payee), recorded);
    if (r.state === "landed") { leaseJournal.settle(e.id, "released"); out.push({ id: e.id, outcome: "released", hash: r.verified.hash }); }
    else if (r.state === "consumed" || r.state === "expired") { leaseJournal.settle(e.id, r.state); out.push({ id: e.id, outcome: r.state }); }
    else out.push({ id: e.id, outcome: r.why ? `held: ${r.why}` : "pending" });
  }
  return out;
}
export async function renewLeadMs(id, fallbackMs) {
  const sender = leaseSender();
  return sender ? sender.renewLeadMs(id, fallbackMs) : fallbackMs;
}
export const claimDeployment = (id, enclaveId) => leaseSend("claim", [id, enclaveId]);
export const renewDeployment = (id) => leaseSend("renew", [id]);'''
        out = replace_once(out, anchor, code)
        out = replace_once(out,
            'export const releaseDeployment = (id) => send(addresses.deployments, DEP_ABI, "release", [id]);',
            'export const releaseDeployment = (id) => leaseSend("release", [id]);')
    else:
        # app-funded leases: the operator key's ETH no longer gates claims or availability, and the low-gas warning
        # stops saying apps stop renewing (registry status/price/proof-key writes still use it: price writes stay gated)
        for before, after in HOST_GAS_HOOKS + HOST_JOURNAL_HOOKS:
            out = replace_once(out, before, after)
        out = replace_once(out,
            'try { await chain.renewDeployment(id); this.log(`renewed ${id.slice(0, 10)}`); d = await chain.readDeployment(id); }',
            '''try {
          const lead = await chain.renewLeadMs(id, RENEW_LEAD_MS);
          if (untilMs - Date.now() < lead) {
            await chain.renewDeployment(id);
            this.log(`renewed ${id.slice(0, 10)}`);
            d = await chain.readDeployment(id);
          }
        }''')
    if dest.is_symlink():
        dest.unlink()
    dest.write_text(out)
    patch = "".join(difflib.unified_diff(src.splitlines(True), out.splitlines(True),
        fromfile="a/" + rel, tofile="b/" + rel))
    (root / "patches" / ("current-" + Path(rel).stem + ".hunk.patch")).write_text(patch)

for name in ("lease-executor-client.mjs", "lease-executor-authority.mjs", "lease-gas-owner.mjs",
             "lease-gas-runtime.mjs", "lease-release-journal.mjs", "rpc-identity.mjs"):
    dest = target / "network" / name
    if dest.is_symlink():
        dest.unlink()
    shutil.copyfile(root / "network" / name, dest)
dest = target / "network/registry-reconcile.mjs"
if dest.is_symlink():
    dest.unlink()
shutil.copyfile(main / "network/registry-reconcile.mjs", dest)
print("Rebased Windows chain/host candidate; main and production unchanged.")

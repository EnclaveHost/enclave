// PAID CAPACITY AUDITS on a Windows host (docs/design/paid-capacity-verification.md). The audit coordinator creates a job
// deployment through EnclaveVerificationFees for ONE host at a negotiated rate, and that host accepts the rate with
// EnclaveDeployments.offerJobRate, signed by its registry OPERATOR. Here the operator key never leaves the box, so the
// node accepts by itself: a PULL in the ledger scan, finding the jobs created for it. The coordinator only waits for the
// acceptance on chain (rateFor) before it funds the job; the node then claims it like any other work.
//
// What is accepted is availability/host-acceptor.mjs's decision, unchanged: a fee-contract job for THIS enclave, unfunded
// and unexpired, running an approved audit workload, at the job's own rate and expiry and at or above the operator's
// floor. Its transaction goes out through the node's one serialized sender (chain.mjs send), never beside a claim or a
// renewal with its own nonce. OFF unless the operator lists the workloads (ENCLAVE_AUDIT_APPREFS).

const lc = (s) => String(s || "").toLowerCase();
const ZERO_RUNNER = /^0x0*$/;
const FEES_JOBS_ABI = [{ type: "function", name: "jobs", stateMutability: "view", inputs: [{ type: "bytes32" }],
  outputs: [{ type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" },
            { type: "uint256" }, { type: "bool" }, { type: "uint64" }] }];

/** ENCLAVE_AUDIT_APPREFS -> the catalog refs this host runs audits for (catalog://0x<64 hex>/<version>). */
export function auditAppRefsOf(raw) {
  return String(raw || "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^catalog:\/\/0x[0-9a-f]{64}\/\d+$/.test(x));
}

/**
 * -> { enabled, pass(rows) }. pass() returns the ids of the active jobs created for this host (accepted now or before),
 * so the scan can include them in its pool whatever its scope. Never throws: a failure is logged once per job and reason.
 * opts: appRefs, minRatePerShareMilli6 (bigint), enclaveId, ledger, fees (address or null), publicClient, send(address,
 * abi, fn, args) -> hash, log, now; loadAcceptor (tests).
 */
export function createAuditJobs({ appRefs = [], minRatePerShareMilli6 = 0n, enclaveId, ledger, fees, publicClient, send, log = () => {},
                                  now = () => Date.now(), loadAcceptor = () => import("../../availability/host-acceptor.mjs") }) {
  const allowed = new Set(appRefs.map(lc));
  const enabled = allowed.size > 0 && !!fees && !!ledger;
  const notOurs = new Set();                 // a job's host never changes: a job for another host is read once
  const accepted = new Map();               // id -> rate accepted (string)
  const said = new Map();                   // id -> last logged failure (once per reason)
  let acceptor = null;
  async function accept(o) {
    if (!acceptor) {
      const { createHostAcceptor } = await loadAcceptor();
      acceptor = createHostAcceptor({ publicClient, ledger, fees, enclaveId, appRefs: [...allowed], minRatePerShareMilli6, log,
        // through the node's serialized sender: one transaction at a time from this key, with its nonce bookkeeping
        operatorWallet: { writeContract: ({ address, abi, functionName, args }) => send(address, abi, functionName, args) } });
    }
    return acceptor(o);
  }
  async function pass(rows) {
    const mine = new Set();
    if (!enabled) return mine;
    for (const d of rows) {
      const id = lc(d.id);
      if (!d.active || !allowed.has(lc(d.appRef)) || notOurs.has(id)) continue;
      // somebody else holds a live lease on it: not a job waiting for this host
      const live = Number(d.leaseUntil) * 1000 > now();
      if (live && !ZERO_RUNNER.test(String(d.runner || "")) && lc(d.runner) !== lc(enclaveId)) continue;
      let j;
      try { j = await publicClient.readContract({ address: fees, abi: FEES_JOBS_ABI, functionName: "jobs", args: [id] }); }
      catch (e) { const m = `audit job ${id.slice(0, 10)}: the fee contract could not be read (${e.shortMessage || e.message})`;
                  if (said.get(id) !== m) { said.set(id, m); log(m); } continue; }
      if (/^0x0{40}$/i.test(String(j[1])) || lc(j[2]) !== lc(enclaveId)) { notOurs.add(id); continue; }
      mine.add(id);
      if (j[7] || accepted.get(id) === String(j[5])) continue;                    // funded, or already accepted at this rate
      if (BigInt(j[4]) * 1000n <= BigInt(now())) continue;                          // its offer expired: nothing to accept
      try {
        await accept({ id, hostId: enclaveId, rate6: j[5], expiresSec: j[4] });
        accepted.set(id, String(j[5])); said.delete(id);
      } catch (e) {
        const m = `audit job ${id.slice(0, 10)} not accepted: ${e.shortMessage || e.message}`;
        if (said.get(id) !== m) { said.set(id, m); log(m); }
      }
    }
    return mine;
  }
  return { enabled, pass };
}

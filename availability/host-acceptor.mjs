// The HOST side of a paid capacity audit (docs/design/paid-capacity-verification.md, dependency 5: host-side offer
// acceptance). The audit coordinator creates a job deployment through EnclaveVerificationFees for ONE host at a negotiated
// rate; the host explicitly accepts that rate with EnclaveDeployments.offerJobRate, signed by its registry OPERATOR. This
// module is that acceptance, and nothing else: it signs only
//   - for this host's own enclave id,
//   - a job the fee contract created for THIS host (fees.jobs(id).hostId), still unfunded and unexpired,
//   - running an approved audit workload (the deployment's appRef is on this host's list),
//   - at the job's own rate, and only if that rate is at or above this host's floor (per audited share);
// and it offers exactly the job's rate and expiry, never more. Customer work keeps priority: the host's supervisor claims
// the job like any other, and only if it has the spare capacity.
import fs from "node:fs";

const lc = (s) => String(s || "").toLowerCase();
const abi = (n) => JSON.parse(fs.readFileSync(new URL(`../contracts/${n}.abi.json`, import.meta.url)));
const D = abi("EnclaveDeployments"), F = abi("EnclaveVerificationFees");

export function createHostAcceptor({ publicClient, operatorWallet, ledger, fees, enclaveId, appRefs, minRatePerShareMilli6 = 0n,
                                     now = () => BigInt(Math.floor(Date.now() / 1000)), log = console.log }) {
  const allowed = new Set(appRefs.map(lc));
  const read = (address, a, functionName, args = []) => publicClient.readContract({ address, abi: a, functionName, args });
  return async function accept({ id, hostId, rate6, expiresSec }) {
    if (!/^0x[0-9a-f]{64}$/.test(lc(id))) throw new Error("acceptor: bad deployment id");
    if (lc(hostId) !== lc(enclaveId)) throw new Error("acceptor: the offer names another host");
    const j = await read(fees, F, "jobs", [id]);   // (source, wallet, hostId, epoch, expires, rate6, amount6, funded, stopAfter)
    if (/^0x0{40}$/.test(j[1])) throw new Error("acceptor: not a fee-contract job");
    if (lc(j[2]) !== lc(enclaveId)) throw new Error("acceptor: the job was created for another host");
    if (j[7]) throw new Error("acceptor: the job is already funded");
    if (BigInt(j[4]) <= now()) throw new Error("acceptor: the job's offer expired");
    if (BigInt(rate6) !== BigInt(j[5]) || BigInt(expiresSec) !== BigInt(j[4])) throw new Error("acceptor: the offer is not the job's own rate and expiry");
    const d = await read(ledger, D, "get", [id]);
    if (!allowed.has(lc(d.appRef))) throw new Error(`acceptor: ${d.appRef} is not an approved audit workload`);
    if (BigInt(d.cpuMilli) === 0n || BigInt(j[5]) < minRatePerShareMilli6 * BigInt(d.cpuMilli)) throw new Error("acceptor: below this host's floor");
    // idempotent: an acceptance already on chain at this rate is not sent again
    try { if (BigInt(await read(ledger, D, "rateFor", [id, enclaveId])) === BigInt(j[5])) { log(`[acceptor] audit job ${id.slice(0, 10)} already accepted`); return { tx: null }; } } catch {}
    const hash = await operatorWallet.writeContract({ address: ledger, abi: D, functionName: "offerJobRate", args: [id, enclaveId, BigInt(j[5]), BigInt(j[4])] });
    const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (r.status !== "success") throw new Error(`acceptor: offerJobRate reverted (${hash})`);
    log(`[acceptor] accepted audit job ${id.slice(0, 10)} at ${j[5]}/s until ${j[4]} (tx ${hash})`);
    return { tx: hash };
  };
}

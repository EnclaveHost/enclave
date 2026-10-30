// lease-relay-migration-check.mjs - READ-ONLY gate before a lease relay KEY that was moved from another machine is started
// here. A relay key must sign from ONE place at a time, and a send the old machine signed but never saw resolved must be
// carried over (the relay re-broadcasts exactly those bytes, client/lease-executor-client.mjs startLeaseRelay), never
// signed anew at the same nonce. This check proves, from public chain state, that the moved key's nonce is reconciled
// with the moved send record. It never opens the key file and signs nothing.
//
// Settings: the relay's own (LEASE_RELAY_RECORD, LEASE_RELAY_DIGEST, LEASE_RELAY_RPCS, LEASE_RELAY_QUORUM,
// LEASE_RELAY_STATE) plus LEASE_RELAY_EXPECTED_PAYEE (the moved key's public address).
//   node lease-relay-migration-check.mjs            exit 0 = reconciled (one JSON line), 1 = refused (reasons), 2 = usage
// At ONE block the RPC quorum agrees on (verifiedLeaseAuthority: the reviewed reserve/executor code and bindings too):
//   - the send record must EXIST (the old machine's journal travels with the key; an absent one is not "nothing pending")
//     and be exactly {} or {nonce, raw, hash} with keccak256(raw) = hash, a transaction on this chain at that nonce, signed
//     by the expected payee;
//   - {}: nothing of this key may be in flight anywhere: every answering provider's pending nonce equals the agreed nonce;
//   - {nonce, raw, hash}: either that transaction is MINED (its receipt agreed by the quorum; the agreed nonce is past it),
//     or it is still the key's NEXT transaction (agreed nonce = its nonce; no provider sees a pending nonce beyond it + 1):
//     the relay re-broadcasts it before any new send. A nonce consumed by ANOTHER transaction, or an unknown transaction in
//     flight, is refused: settle it by hand first.
// The key's balance (public) is reported against the float cap; the relay itself refuses to start above its cap.
// LEASE_RELAY_SOURCE_ORIGIN (optional, the old machine's public relay origin): exclusivity, a second check beside the old
// machine's own stop receipt. It must NOT answer /v1/info as this payee. A connection refused/reset/timed out or an HTTP
// error is "not serving"; a TLS/certificate failure proves nothing and refuses.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createPublicClient, http, defineChain, getAddress, isAddress, keccak256, parseTransaction, recoverTransactionAddress, formatEther, parseEther } from "viem";
import { parseDeploymentRecord } from "./lease-gas-owner.mjs";
import { leaseRpcSet, verifiedLeaseAuthority } from "./lease-executor-authority.mjs";

const HASH = /^0x[0-9a-f]{64}$/;

/** The moved send record: null for {}, else { nonce, raw, hash, tx }; throws a reason for anything else. */
export async function movedSendRecord(text, { chainId, payee }) {
  let j; try { j = JSON.parse(text); } catch { throw new Error("the send record is not JSON"); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("the send record is not an object");
  const keys = Object.keys(j).sort().join(",");
  if (keys === "") return null;
  if (keys !== "hash,nonce,raw") throw new Error(`the send record has fields ${keys.slice(0, 80)}, not exactly nonce, raw, hash`);
  if (!Number.isSafeInteger(j.nonce) || j.nonce < 0 || typeof j.raw !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(j.raw) || typeof j.hash !== "string")
    throw new Error("the send record's nonce, raw or hash is malformed");
  if (keccak256(j.raw) !== j.hash.toLowerCase()) throw new Error("the send record's hash is not keccak256(raw)");
  let tx; try { tx = parseTransaction(j.raw); } catch { throw new Error("the send record's raw bytes are not a signed transaction"); }
  // (defensive: a parsed transaction without a nonce field is nonce 0)
  if (tx.chainId !== chainId || (tx.nonce ?? 0) !== j.nonce) throw new Error(`the send record is for chain ${tx.chainId} at nonce ${tx.nonce}, not chain ${chainId} at ${j.nonce}`);
  let signer; try { signer = await recoverTransactionAddress({ serializedTransaction: j.raw }); } catch { throw new Error("the send record's transaction has no recoverable signature"); }
  if (getAddress(signer) !== getAddress(payee)) throw new Error("the send record was signed by another key than the expected payee");
  return { nonce: j.nonce, raw: j.raw, hash: j.hash.toLowerCase(), tx };
}

/** -> { serving: bool|null, detail }: null = cannot tell (refuse) */
export async function probeSourceRelay(origin, { payee, fetchImpl = fetch, timeoutMs = 8000 }) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${origin}/v1/info`, { signal: ctl.signal });
    if (r.status !== 200) return { serving: false, detail: `HTTP ${r.status}` };
    let j = null; try { j = await r.json(); } catch { return { serving: false, detail: "HTTP 200, not relay JSON" }; }
    if (j && isAddress(String(j.payee || "")) && getAddress(j.payee) === getAddress(payee)) return { serving: true, detail: `answers as ${getAddress(j.payee)}` };
    return { serving: false, detail: `answers as another payee ${String(j?.payee || "none").slice(0, 42)}` };
  } catch (e) {
    const code = String(e?.cause?.code || e?.code || e?.name || "");
    if (/CERT|TLS|SSL|ALTNAME|SELF_SIGNED|VERIFY/i.test(code)) return { serving: null, detail: `TLS failure ${code}: cannot tell whether it serves` };
    return { serving: false, detail: `no answer (${code || String(e?.message || e).slice(0, 80)})` };
  } finally { clearTimeout(t); }
}

/**
 * -> { ok, decision, payee, block, nonce, record, pendingNonces, balanceEth, problems[] }
 * clients: viem public clients over the relay's RPCs (the CLI builds them); the authority block is agreed by `quorum`.
 */
export async function checkRelayMigration({ recordBytes, digest, clients, quorum, stateFile, payee, maxFloatEth = null,
  allowLoopbackHttp = false, rpcTimeoutMs = 10_000, confirmations = 0, now = Date.now, readFile = fs.readFileSync, sourceOrigin = null, fetchImpl = fetch }) {
  const problems = [];
  if (!isAddress(String(payee || ""))) throw new Error("LEASE_RELAY_EXPECTED_PAYEE must be the moved key's address");
  payee = getAddress(payee);
  const deployment = parseDeploymentRecord(recordBytes, { expectedDigest: digest });
  let text;
  try { text = readFile(stateFile, "utf8"); }
  catch (e) { throw new Error(`${stateFile}: ${e.code || e.message}: the moved key's send record must be carried over with it (an absent record is not "nothing pending")`); }
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error(`${stateFile} is larger than a relay send record`);
  const record = await movedSendRecord(text, { chainId: deployment.chainId, payee });
  const v = await verifiedLeaseAuthority({ clients, deployment, quorum, allowLoopbackHttp, confirmations, timeoutMs: rpcTimeoutMs, now });
  const nonce = await v.client.getTransactionCount({ address: payee });
  const rpc = leaseRpcSet(clients, { quorum, allowLoopbackHttp, timeoutMs: rpcTimeoutMs });
  // every provider's own pending view (mempools differ: ANY provider seeing more in flight than allowed refuses)
  const pending = (await Promise.allSettled(rpc.peers.map(async (p) => Number(BigInt(await rpc.request(p.client, "eth_getTransactionCount", [payee, "pending"]))))))
    .map((r) => (r.status === "fulfilled" ? r.value : null));
  const balance = (await rpc.agree(rpc.peers, async (p) => BigInt(await rpc.request(p.client, "eth_getBalance", [payee, { blockHash: v.block.hash, requireCanonical: true }])), "the key's balance")).value;
  let decision;
  if (!record) {
    decision = "nothing pending";
    if (pending.some((n) => n !== null && n !== nonce)) problems.push(`a provider sees a pending nonce (${pending.join(",")}) beyond the agreed ${nonce} while the record is empty: an unknown transaction of this key is in flight; wait for it to resolve`);
  } else {
    const receipts = await rpc.agree(rpc.peers, async (p) => {
      const r = await rpc.request(p.client, "eth_getTransactionReceipt", [record.hash]);
      return r ? { mined: true, status: String(r.status), block: String(BigInt(r.blockNumber)) } : { mined: false };
    }, "the recorded transaction's receipt").catch(() => null);
    if (!receipts) problems.push("the RPC quorum does not agree whether the recorded transaction is mined: retry, or settle it by hand");
    else if (receipts.value.mined) {
      decision = `recorded transaction mined (status ${receipts.value.status}, block ${receipts.value.block})`;
      if (nonce <= record.nonce) problems.push(`the recorded transaction is mined but the agreed nonce ${nonce} is not past it (${record.nonce}): the quorum's block is behind; retry`);
      if (pending.some((n) => n !== null && n !== nonce)) problems.push(`a provider sees a pending nonce (${pending.join(",")}) beyond the agreed ${nonce}: an unknown transaction is in flight`);
    } else {
      decision = `recorded transaction at nonce ${record.nonce} not mined: the relay re-broadcasts these exact bytes before any new send`;
      if (nonce !== record.nonce) problems.push(`the agreed nonce is ${nonce}, not the recorded ${record.nonce}: ${nonce > record.nonce ? "that nonce was consumed by ANOTHER transaction" : "a gap"}; settle the record by hand`);
      if (pending.some((n) => n !== null && n > record.nonce + 1)) problems.push(`a provider sees a pending nonce (${pending.join(",")}) beyond the recorded transaction: an unknown transaction is in flight`);
    }
  }
  if (pending.filter((n) => n !== null).length < rpc.required) problems.push(`only ${pending.filter((n) => n !== null).length} provider(s) answered the pending nonce; ${rpc.required} are required`);
  let source = null;
  if (sourceOrigin) {
    source = { origin: sourceOrigin, ...(await probeSourceRelay(sourceOrigin, { payee, fetchImpl })) };
    if (source.serving !== false) problems.push(`the source relay ${sourceOrigin} ${source.serving ? "STILL SERVES this key" : "cannot be shown stopped"} (${source.detail}): stop it before this machine starts the key`);
  }
  if (maxFloatEth !== null && balance > parseEther(String(maxFloatEth))) problems.push(`the key holds ${formatEther(balance)} ETH, above the ${maxFloatEth} ETH float cap: the relay would refuse to start`);
  return { ok: problems.length === 0, decision: decision ?? null, payee, block: { number: String(v.block.number), hash: v.block.hash }, nonce,
    record: record ? { nonce: record.nonce, hash: record.hash } : {}, pendingNonces: pending, balanceEth: formatEther(balance), source, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const e = process.env, need = (k) => { const x = String(e[k] || "").trim(); if (!x) { console.error(`[relay-migration] ${k} is not set`); process.exit(2); } return x; };
  const recordFile = need("LEASE_RELAY_RECORD"), digest = need("LEASE_RELAY_DIGEST"), stateFile = need("LEASE_RELAY_STATE"), payee = need("LEASE_RELAY_EXPECTED_PAYEE");
  const rpcs = need("LEASE_RELAY_RPCS").split(",").map((s) => s.trim()).filter(Boolean), quorum = Number(need("LEASE_RELAY_QUORUM"));
  (async () => {
    const recordBytes = fs.readFileSync(recordFile);
    const deployment = parseDeploymentRecord(recordBytes, { expectedDigest: digest });
    const chain = defineChain({ id: deployment.chainId, name: `chain-${deployment.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcs[0]] } } });
    const clients = rpcs.map((url) => createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 10_000 }) }));
    const r = await checkRelayMigration({ recordBytes, digest, clients, quorum, stateFile, payee, maxFloatEth: e.LEASE_RELAY_MAX_FLOAT_ETH || null,
      sourceOrigin: e.LEASE_RELAY_SOURCE_ORIGIN ? new URL(e.LEASE_RELAY_SOURCE_ORIGIN).origin : null });
    console.log(JSON.stringify(r));
    process.exitCode = r.ok ? 0 : 1;
  })().catch((err) => { console.error(`[relay-migration] refused: ${err.message}`); process.exitCode = 1; });
}

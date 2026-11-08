// Admission policy for an SEV-SNP RPC enclave taken from the chain, not from local config.
//
// An enclave is admitted only while Base says, on every queried RPC (all must agree):
//   - EnclaveDeployments.get(deployment): owner == the expected owner, active, appRef ==
//     "catalog://<appId>/<versionIndex>", and a runner holds a current lease;
//   - EnclaveAppCatalog.getVersion(appId, versionIndex): approved (1), not yanked, and its
//     immutable config names the allowed launch measurements (config.snp.measurements).
// The enclave's SNP report must then carry one of those measurements and HOST_DATA equal to
// the deployment id (rpc/snp/launch.py sets it), so a report proves which deployment it serves.
// No dependencies: plain JSON-RPC eth_call and a decoder for exactly the two structs used.

const SEL_GET = '0x8eaa6ac0';          // EnclaveDeployments.get(bytes32)
const SEL_VERSION = '0xaf904a06';      // EnclaveAppCatalog.getVersion(bytes32,uint256)
const DEPLOYMENT = ['bytes32:id', 'address:owner', 'string:appRef', 'string:ports', 'string:configCid', 'uint:gpuMilli',
  'uint:cpuMilli', 'uint:appPort', 'bool:isPublic', 'bool:active', 'uint:createdAt', 'uint:rate', 'uint:balance6',
  'uint:spent6', 'bytes32:runner', 'address:runnerOperator', 'uint:leaseUntil'];
const VERSION = ['string:cid', 'string:version', 'uint:vramMb', 'uint:gpuGflops', 'uint:memMb', 'uint:cpuGflops',
  'uint:createdAt', 'bool:verified', 'bool:yanked', 'string:ports', 'uint:approval', 'string:config'];
const H32 = /^0x[0-9a-f]{64}$/;
const M48 = /^[0-9a-f]{96}$/;

const word = (hex, i) => hex.slice(i * 64, i * 64 + 64);

// Decode a return value that is one dynamic tuple of static words and strings.
export function decodeTuple(data, fields) {
  const hex = data.replace(/^0x/, '').toLowerCase();
  const base = Number(BigInt('0x' + word(hex, 0))) * 2;
  const t = hex.slice(base);
  const out = {};
  fields.forEach((f, i) => {
    const [type, name] = f.split(':');
    const w = word(t, i);
    if (w.length !== 64) throw new Error('short return data');
    if (type === 'string') {
      const off = Number(BigInt('0x' + w)) * 2;
      const len = Number(BigInt('0x' + t.slice(off, off + 64)));
      if (off + 64 + len * 2 > t.length) throw new Error('string out of range');
      out[name] = Buffer.from(t.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
    } else if (type === 'address') out[name] = '0x' + w.slice(24);
    else if (type === 'bytes32') out[name] = '0x' + w;
    else if (type === 'bool') out[name] = BigInt('0x' + w) !== 0n;
    else out[name] = BigInt('0x' + w);
  });
  return out;
}

async function ethCallOnce(fetchImpl, rpc, to, data, timeoutMs) {
  const r = await fetchImpl(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(timeoutMs) });
  let j;
  try { j = await r.json(); } catch { j = null; }
  // The status only, never the RPC URL: provider URLs carry API keys.
  if (!j || typeof j.result !== 'string' || j.error) throw new Error('eth_call failed' + (r.status && r.status !== 200 ? ': HTTP ' + r.status : ''));
  return j.result;
}

// One retry per read after a short pause. The public Base RPCs rate-limit (HTTP 429) now and then,
// and a single refused read dropped the enclave from the gateway about every 40 min (prod r11,
// 2026-11-07/08). Every RPC must still answer and agree; a retry only gives each one a second chance.
async function ethCall(fetchImpl, rpc, to, data, timeoutMs, retryMs) {
  try { return await ethCallOnce(fetchImpl, rpc, to, data, timeoutMs); }
  catch {
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    return ethCallOnce(fetchImpl, rpc, to, data, timeoutMs);
  }
}

export async function resolveDeploymentPolicy(p, { fetchImpl = fetch, now = Date.now(), timeoutMs = 10000, retryMs = 500 } = {}) {
  const { rpcs, ledger, catalog, deployment, owner, appId, versionIndex } = p;
  if (!Array.isArray(rpcs) || rpcs.length < 2) throw new Error('deployment policy needs at least two Base RPCs');
  if (!H32.test(deployment) || !H32.test(appId) || !Number.isInteger(versionIndex) || versionIndex < 0)
    throw new Error('deployment policy malformed');
  const idx = versionIndex.toString(16).padStart(64, '0');
  const reads = await Promise.all(rpcs.map(async (rpc) => [
    await ethCall(fetchImpl, rpc, ledger, SEL_GET + deployment.slice(2), timeoutMs, retryMs),
    await ethCall(fetchImpl, rpc, catalog, SEL_VERSION + appId.slice(2) + idx, timeoutMs, retryMs)]));
  if (reads.some(([d, v]) => d !== reads[0][0] || v !== reads[0][1])) throw new Error('Base RPCs disagree on the deployment');
  const d = decodeTuple(reads[0][0], DEPLOYMENT), v = decodeTuple(reads[0][1], VERSION);
  const lower = (s) => String(s).toLowerCase();
  if (d.id !== lower(deployment)) throw new Error('deployment not found');
  if (lower(d.owner) !== lower(owner)) throw new Error('deployment owner is not the expected owner');
  if (!d.active) throw new Error('deployment inactive');
  if (d.appRef !== `catalog://${lower(appId)}/${versionIndex}`) throw new Error('deployment runs a different app version');
  if (Number(d.leaseUntil) * 1000 <= now) throw new Error('deployment has no current lease');
  if (Number(v.approval) !== 1 || v.yanked) throw new Error('catalog version not approved');
  let cfg;
  try { cfg = JSON.parse(v.config); } catch { throw new Error('catalog version config is not JSON'); }
  const ms = cfg?.snp?.measurements;
  const allowed = (Array.isArray(ms) ? ms : Object.values(ms || {})).map(lower).filter((m) => M48.test(m));
  if (!allowed.length) throw new Error('catalog version names no SNP measurement');
  return { allowedMeasurements: allowed, hostData: lower(deployment).slice(2), leaseUntil: Number(d.leaseUntil),
    runner: d.runner, version: v.version, cid: v.cid };
}

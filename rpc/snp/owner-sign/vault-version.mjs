// A new version of a catalog app whose publisher is the owner's session vault, for a deployment that vault holds.
// Shared by vault-version-plan.mjs (writes the steps) and server.mjs (what is done, what is ready, and the one upload
// the owner's signed message authorizes).
//
// The vault is the publisher, so the version is published through SessionVault.ownerCall and starts Pending; the
// catalog owner approves it. The deployment moves with SessionVault.promote, not with a bare setAppRef: the relay
// releases a vault-held production deployment's secrets only for the (appRef, configCid) pair its owner promoted.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { encodeAbiParameters, keccak256, recoverMessageAddress } from 'viem';
import { CATALOG_ABI, LEDGER_ABI, VAULT_ABI } from './abi.mjs';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const uploadMessage = (hash, expiry) => `enclave-upload:${hash}:${expiry}`;
// SessionVault's record of what its owner promoted: keccak256(abi.encode(appRef, configCid))
export const promotedHash = (appRef, configCid) => keccak256(encodeAbiParameters([{ type: 'string' }, { type: 'string' }], [appRef, configCid]));

// Null once every gateway the plan names serves the component under its CID, byte for byte; else what is missing.
export async function served(u, fetchImpl = fetch) {
  for (const g of u.gateways) {
    const r = await fetchImpl(`${g}/ipfs/${u.cid}`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
    if (!r?.ok) return `${new URL(g).host} does not serve the component yet`;
    if (sha256(Buffer.from(await r.arrayBuffer())) !== u.sha256) return `${new URL(g).host} serves other bytes under this CID`;
  }
  return null;
}

// Trade the owner's signed message for the relay's upload token and pin the component. The gateway chooses the CID:
// anything but the plan's is an error, because the host's release files and the publish step already name it.
export async function upload(u, owner, { expiry, signature }, fetchImpl = fetch) {
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(expiry) || expiry < now || expiry > now + 600 || !/^0x[0-9a-fA-F]{130}$/.test(signature || '')) throw new Error('bad upload authorization');
  const bytes = fs.readFileSync(u.file);
  if (sha256(bytes) !== u.sha256) throw new Error('the component on disk is not the one the plan names');
  const signer = await recoverMessageAddress({ message: uploadMessage(u.sha256, expiry), signature });
  if (signer.toLowerCase() !== owner.toLowerCase()) throw new Error(`signed by ${signer}, not the owner`);
  const post = async (url, init) => {
    const r = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(120000), ...init }), text = await r.text();
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}: ${text.slice(0, 160)}`);
    return JSON.parse(text);
  };
  const tok = await post(u.tokenUrl, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: u.sha256, expiry, signature }) });
  if (!/^[0-9a-f]{64}$/.test(tok.token || '') || String(tok.address).toLowerCase() !== owner.toLowerCase()) throw new Error('the relay returned no upload token for the owner');
  const up = await post(u.uploadUrl, { headers: { 'content-type': 'application/wasm', 'x-upload-address': tok.address, 'x-upload-expiry': String(expiry), 'x-upload-token': tok.token }, body: bytes });
  if (up.cid !== u.cid) throw new Error(`the gateway pinned it as ${up.cid}, not ${u.cid}: prepare the release again with that CID`);
  return up.cid;
}

const SERVED_RECHECK_MS = 60000;

// Does the host load the release this version needs? The promote is offered only then: a host still on the old
// release refuses the new version and the deployment stays down. The host switch writes the marker when it succeeds.
function hostSwitched(s) {
  try { return JSON.parse(fs.readFileSync(s.hostMarker, 'utf8')).igvmSha256 === s.hostRelease ? null : 'the host switch recorded another release'; }
  catch { return 'the host does not load this release yet: run the host switch first'; }
}

// upload, publish, approve, promote. A transaction is ready only while the chain is in the state it expects and it
// simulates from the owner's address. `cache` keeps the served check from fetching the component again once it passed.
// The promote is the exception: the host fetches the component when the deployment moves, so while that step is next
// the gateways are asked again, at most once a minute (2026-11-14: the gateway app had restarted with an empty index and
// answered 404 for a component it had served the day before, and the page offered the promote).
export async function vaultVersionStatus(plan, pub, { fetchImpl = fetch, cache = {}, journal = [], now = Date.now } = {}) {
  const s = plan.status, read = (address, abi, functionName, args) => pub.readContract({ address, abi, functionName, args });
  const [versions, d, held] = await Promise.all([read(s.catalog, CATALOG_ABI, 'numVersions', [s.appId]),
    read(s.ledger, LEDGER_ABI, 'get', [s.deployment]), read(s.vault, VAULT_ABI, 'held', [s.deployment])]);
  const published = versions > BigInt(s.versionIndex);
  const v = published ? await read(s.catalog, CATALOG_ABI, 'getVersion', [s.appId, BigInt(s.versionIndex)]) : null;
  const versionProblem = !published ? `version ${s.versionIndex} is not published yet`
    : v.cid !== s.upload.cid || v.version !== s.label || v.config !== s.versionConfig || v.ports !== s.ports ? `version ${s.versionIndex} on chain is not this release`
    : v.yanked ? `version ${s.versionIndex} is yanked` : null;
  const approved = !versionProblem && v.approval === 1;
  if (!cache.served) { cache.served = (cache.gone = cache.missing = await served(s.upload, fetchImpl)) === null; cache.checkedAt = now(); }
  const onNew = d.appRef === s.newAppRef && d.configCid === s.configCid && held[1] === promotedHash(s.newAppRef, s.configCid);
  const done = { upload: cache.served, publish: published && !versionProblem, approve: approved, promote: onNew };
  let gone = null;
  if (approved && !onNew) {
    if (!(now() - cache.checkedAt < SERVED_RECHECK_MS)) { cache.gone = await served(s.upload, fetchImpl); cache.checkedAt = now(); }
    gone = cache.gone && cache.gone.replace(' yet', ' now');
  }
  const blocked = {
    upload: null,
    publish: !cache.served ? cache.missing : published ? versionProblem : null,
    approve: versionProblem,
    promote: versionProblem || (!approved ? `version ${s.versionIndex} is not approved` : null) || hostSwitched(s) || gone
      || (d.appRef !== s.oldAppRef && d.appRef !== s.newAppRef ? `the deployment runs ${d.appRef}` : null),
  };
  const ready = {};
  for (const step of plan.steps) {
    ready[step.id] = !done[step.id] && !blocked[step.id];
    if (!ready[step.id] || step.upload) continue;
    try { await pub.call({ account: plan.owner, to: step.to, data: step.data }); }
    catch (e) { ready[step.id] = false; blocked[step.id] = 'it would revert: ' + String(e.shortMessage || e.message).slice(0, 160); }
  }
  return { ...done, ready, blocked, appRef: d.appRef, versions: String(versions), journal };
}

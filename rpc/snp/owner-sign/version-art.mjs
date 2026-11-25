// A catalog app's thumbnail and banner. Shared by version-art-plan.mjs (writes the steps) and server.mjs (what is
// done, what is ready).
//
// The store draws the art named in the config of the newest approved version (`_media`), and a version's config never
// changes. So new art is a new version: the newest one again, same component, resources and ports, its config
// differing in `_media` alone. No deployment moves: each keeps the version its app ref names.
import crypto from 'node:crypto';
import { CATALOG_ABI } from './abi.mjs';
import { served } from './vault-version.mjs';

// CIDv1, raw codec, sha2-256: what the gateway returns for a file it stores as one block (under 256 KiB).
export const RAW_BLOCK_MAX = 262144;
export function rawCid(bytes) {
  if (bytes.length > RAW_BLOCK_MAX) throw new Error('the file is over 256 KiB: the gateway would not store it as one block');
  const b = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), crypto.createHash('sha256').update(bytes).digest()]);
  let bits = '', out = '';
  for (const x of b) bits += x.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return 'b' + out;
}

// The config with `_media` replaced and nothing else touched, keys in their order. Refused unless the config is the
// canonical JSON object the catalog holds, so the new version differs from the old in the art alone.
export function withArt(config, media) {
  let o;
  try { o = JSON.parse(config); } catch { throw new Error('the version’s config is not JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o) || JSON.stringify(o) !== config) throw new Error('the version’s config is not a canonical JSON object');
  const out = JSON.stringify({ ...o, _media: media });
  if (Buffer.byteLength(out) > 4096) throw new Error('the config with the art is over 4096 bytes');
  return out;
}

// upload per file, then publish. An upload is done once every gateway serves the file under its CID; the publish is
// offered only then, only while the app's newest version is still the one the plan copied, and only if it simulates.
export async function versionArtStatus(plan, pub, { fetchImpl = fetch, cache = {}, journal = [] } = {}) {
  const s = plan.status, read = (functionName, args) => pub.readContract({ address: s.catalog, abi: CATALOG_ABI, functionName, args });
  const versions = Number(await read('numVersions', [s.appId]));
  const v = versions > s.versionIndex ? await read('getVersion', [s.appId, BigInt(s.versionIndex)]) : null;
  const published = !!v && v.version === s.label && v.cid === s.cid && v.config === s.config && v.approval === 1 && !v.yanked;
  const done = {}, blocked = {}, ready = {};
  let missing = null;
  for (const [id, u] of Object.entries(s.uploads)) {
    if (!cache[id]) cache[id] = (cache['missing:' + id] = await served(u, fetchImpl)) === null;
    done[id] = cache[id]; blocked[id] = null;
    if (!cache[id]) missing ??= cache['missing:' + id].replace('the component', u.cid.slice(0, 14) + '…');
  }
  const step = plan.steps.find((x) => !x.upload);
  done[step.id] = published;
  blocked[step.id] = published ? null : missing || (v ? `version ${s.versionIndex} on chain is not this one` : versions !== s.versionIndex ? 'the app’s versions changed after this page was prepared' : null);
  for (const x of plan.steps) ready[x.id] = !done[x.id] && !blocked[x.id];
  if (ready[step.id]) {
    try { await pub.call({ account: plan.owner, to: step.to, data: step.data }); }
    catch (e) { ready[step.id] = false; blocked[step.id] = 'it would revert: ' + String(e.shortMessage || e.message).slice(0, 160); }
  }
  return { ...done, ready, blocked, versions: String(versions), journal };
}

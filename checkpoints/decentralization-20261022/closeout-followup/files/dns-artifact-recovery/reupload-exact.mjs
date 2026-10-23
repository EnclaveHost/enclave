// ROOT-RUN ONLY (dns-artifact-recovery). Re-publish the EXACT EnclaveDNS 0.1.5 wasm to the s3-ipfs-adapter so its pinned CID
// is served again. No catalog version, no owner signature, no transaction: the adapter derives the same CID from the same
// bytes (pins/<cid>). The same supported EIP-191 direct upload as enclavedns-upload-502-20261021/direct-upload-r3.mjs (its
// temporary key has no funds or authority and is never stored), WITHOUT that script's wallet-handoff journal guards, which
// refuse now because publish/upgrade have since completed. Preconditions are checked here and it refuses otherwise:
//   - the local wasm is the pinned artifact and imports to the pinned CID (frozenWasm);
//   - the adapter's public /api/status is "ready" with a complete (untruncated) listing and no error,
//     i.e. the CID is really absent from a complete index, not merely unindexed while sia-s3 is down;
//   - CONFIRM_REUPLOAD=bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau is set.
// Then: one POST /add-wasm; the answered CID must be the pinned one; the full CAR is read back from the adapter and must
// be exactly the frozen DAG (verifyCar). Prints only CIDs, hashes and counts.
import fs from 'node:fs';
import {generatePrivateKey,privateKeyToAccount} from '../../enclave/node_modules/viem/_esm/accounts/index.js';
import {directUploadHeaders} from '../../enclave/sdk/storage/upload-auth.mjs';
import {DNS} from '../../enclavedns-stale-20261021/wallet-handoff/trust.mjs';
import {frozenWasm,readBounded,verifyCar} from '../../site-host-live-publish/handoff/site-upload.mjs';

const origin = 'https://7ae476a3.app.enclave.host', audience = '0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33';
const out = new URL('./reupload-result.json', import.meta.url);
if (process.env.CONFIRM_REUPLOAD !== DNS.expectedCid) throw Error(`set CONFIRM_REUPLOAD=${DNS.expectedCid} to upload; nothing was sent`);
const {bytes, dag} = frozenWasm(DNS);                                     // size 2588705, sha256 e3780187…, imports to the CID
const st = await (await fetch(origin + '/api/status', {redirect: 'error', signal: AbortSignal.timeout(20000)})).json();
if (st.state !== 'ready' || st.truncated !== false || st.error !== null)
  throw Error(`adapter index not complete (state=${st.state}, truncated=${st.truncated}, error=${st.error !== null}); restore its S3 backend and POST /api/refresh first; nothing was sent`);
const probe = await fetch(`${origin}/ipfs/${DNS.expectedCid}?format=raw`, {method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30000)});
if (probe.status === 200) throw Error('the CID is already served by the adapter; nothing was sent');
const account = privateKeyToAccount(generatePrivateKey());
const url = origin + '/add-wasm';
const headers = await directUploadHeaders({audience, url, address: account.address, bytes, signMessage: (o) => account.signMessage(o)});
const res = await fetch(url, {method: 'POST', body: bytes, headers: {...headers, 'content-length': String(bytes.length), 'content-type': 'application/wasm'},
  redirect: 'error', signal: AbortSignal.timeout(300000)});
const body = await readBounded(res, 4096, 'upload reply');
if (!res.ok) { fs.writeFileSync(out, JSON.stringify({status: 'refused', http: res.status}, null, 2)); throw Error(`upload HTTP ${res.status}; see the adapter log`); }
if (JSON.parse(body).cid !== DNS.expectedCid) throw Error('the adapter answered a different CID');
const carRes = await fetch(`${origin}/ipfs/${DNS.expectedCid}?format=car&dag-scope=all`, {redirect: 'error', signal: AbortSignal.timeout(90000)});
if (carRes.status !== 200) throw Error(`readback HTTP ${carRes.status}`);
const proof = verifyCar(DNS, await readBounded(carRes, DNS.upload.maxCarBytes, 'CAR'), dag);
const result = {status: 'verified', cid: DNS.expectedCid, artifactSha256: DNS.wasm.sha256, bytes: bytes.length, ...proof, at: new Date().toISOString(),
  origin, chainTransactions: 0, ownerSignature: false};
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));

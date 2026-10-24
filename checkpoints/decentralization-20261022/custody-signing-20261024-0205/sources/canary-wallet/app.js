'use strict';
// Local page (adapted from custody-factory-wallet app.js). The wallet is asked for anything ONLY from a click handler:
// Connect -> eth_requestAccounts; Sign upload authorization -> the server's durable begin, then personal_sign of exactly
// the displayed message, then the server uploads and verifies; Review publish -> eth_accounts/eth_chainId (switch if
// needed), the server's FRESH preparation, then eth_sendTransaction with exactly the prepared transaction. Only an
// explicit rejection (4001) is ever reported as "nothing happened"; any other wallet error (a disconnected hardware key,
// a closed popup) leaves the attempt open and says so. The signature is passed straight to this local server.
const el = (id) => document.getElementById(id);
const HASH = /^0x[0-9a-fA-F]{64}$/, KEY = 'enclave-canary-' + document.body.dataset.stage + '-hash';
const lc = (x) => String(x || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let provider, config, connected = false, busy = false, hash = null;

function say(text, kind) { el('status').textContent = text; el('status').dataset.kind = kind || ''; }
function eth(v) { const w = BigInt(v), s = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return (w / 10n ** 18n) + (s ? '.' + s : '') + ' ETH (' + w + ' wei)'; }
const stored = () => { try { const h = localStorage.getItem(KEY); return HASH.test(h || '') ? h : null; } catch { return null; } };
const remember = (h) => { try { localStorage.setItem(KEY, h); } catch {} };
const forget = () => { try { localStorage.removeItem(KEY); } catch {} };
const lost = (why) => { connected = false; el('connect').disabled = false; el('wallet').textContent = why; if (config) render(true); };

function found(p) { if (provider) return; provider = p; el('wallet').textContent = 'MetaMask detected.'; el('connect').disabled = false;
  p.on?.('accountsChanged', (a) => { if (config && lc(a?.[0]) !== lc(config.request.transaction.from)) lost('MetaMask account changed; connect the administrator again.'); });
  p.on?.('disconnect', () => lost('MetaMask disconnected; reconnect before any further step. Nothing is assumed to have happened.')); }
window.addEventListener('eip6963:announceProvider', (event) => { if (event.detail?.info?.rdns === 'io.metamask') found(event.detail.provider); });
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(() => { if (!provider) { const p = window.ethereum?.providers?.find((x) => x.isMetaMask) || window.ethereum; if (p?.isMetaMask) found(p); else el('wallet').textContent = 'MetaMask was not detected. Enable the extension for this local page and reload.'; } }, 500);

async function api(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signing-Token': config.token }, body: JSON.stringify(data || {}) });
  const j = await r.json(); if (!r.ok) throw Object.assign(Error(j.error || 'request failed'), { status: r.status }); return j;
}
const UPLOAD_TEXT = { ready: 'Not uploaded.', authorizing: 'Waiting for the signed authorization.', uploading: 'Uploading…',
  'stored-verified': 'Stored and verified: the gateway returned the pinned CID and serves exactly the pinned bytes.',
  'pinned-unverified': 'The gateway returned the pinned CID, but the bytes have not been fetched back yet. Click Verify storage again.',
  'upload-unknown': 'The gateway did not answer the upload, so it is NOT known whether it stored the component. Click Verify storage again (a fetch, not a new upload). A failed check does not prove it was not stored. Only if you choose to, Upload the same bytes again authorizes the same file and CID once more.',
  'cid-mismatch': 'STOP: the gateway returned another CID. Nothing may be published. Ask root.' };
function render(keep) {
  const s = config.state, tx = config.request.transaction, up = config.stages.upload, comp = config.stages.component;
  el('from').textContent = tx.from; el('to').textContent = tx.to; el('value').textContent = eth(tx.value);
  el('component').textContent = comp.size + ' bytes · sha256 ' + comp.sha256 + ' · CID ' + comp.cid;
  el('upload').textContent = (UPLOAD_TEXT[up.status] || ('Unknown upload state ' + up.status + '; stop and ask root.')) + (up.lastError ? ' Last error: ' + up.lastError : '');
  el('transaction').textContent = JSON.stringify(s.request ? s.request.transaction : tx, null, 2);
  const expired = up.status === 'authorizing' && Date.now() / 1000 >= up.expiry;
  el('authorize').disabled = busy || !connected || !(up.status === 'ready' || expired);
  el('verify-storage').hidden = !['pinned-unverified', 'upload-unknown'].includes(up.status);
  el('verify-storage').disabled = busy;
  el('retry-same').hidden = up.status !== 'upload-unknown';
  el('retry-same').disabled = busy || !connected;
  hash = s.hash || hash || stored();
  const open = s.status === 'awaiting-wallet' || s.status === 'submitted';
  el('recover').hidden = !open;
  if (hash && !el('hash').value) el('hash').value = hash;
  el('hash').readOnly = !!s.hash;
  el('check').disabled = busy || !open;
  el('reconcile').disabled = busy || s.status !== 'awaiting-wallet' || !!s.hash;
  el('sign').disabled = busy || !connected || s.status !== 'ready' || up.status !== 'stored-verified';
  if (keep) return;
  const nonce = s.request?.transaction?.nonce ? ' (nonce ' + BigInt(s.request.transaction.nonce) + ')' : '';
  if (s.status === 'ready' && ['upload-unknown', 'pinned-unverified', 'uploading', 'cid-mismatch', 'authorizing'].includes(up.status) && !expired) say(UPLOAD_TEXT[up.status], 'wait');
  else if (s.status === 'ready') say(up.status !== 'stored-verified' ? (connected ? 'Step 1: click Sign upload authorization in MetaMask.' : 'Ready. Connect MetaMask with the administrator account shown above. Nothing is requested until you click.')
    : (connected ? 'Step 2: click Review publish transaction in MetaMask: the server rechecks Base and the stored component first.' : 'The component is stored and verified. Connect MetaMask to publish.'));
  else if (s.status === 'preparing') say('The server is preparing a request. Reload in a few seconds.', 'wait');
  else if (s.status === 'awaiting-wallet') say('A publish transaction' + nonce + ' was handed to MetaMask. Do NOT send it again. If MetaMask sent it, enter its hash below and click Check pending transaction. If you are sure it was never sent, reject any open request in MetaMask, wait 5 minutes and click No hash: check the chain.', 'wait');
  else if (s.status === 'submitted') say('Submitted ' + s.hash + '. Click Check pending transaction; it counts after two later blocks on two providers.', 'wait');
  else if (s.status === 'confirmed') { forget(); say('Confirmed: ' + s.hash + '. ' + document.body.dataset.done, 'ok'); }
  else say('Unknown state ' + s.status + '; stop and ask root.', 'error');
}
async function load(keep) { config = await (await fetch('/request')).json(); render(keep); }
load().catch((e) => say(e.message, 'error'));

el('connect').onclick = async () => {
  try {
    if (!config) throw Error('The request is still loading.');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (lc(accounts?.[0]) !== lc(config.request.transaction.from)) throw Error('Select the administrator account ' + config.request.transaction.from + ' in MetaMask, then Connect again.');
    connected = true; el('connect').disabled = true; el('wallet').textContent = 'Connected: ' + accounts[0]; render();
  } catch (e) { say(e.message, 'error'); }
};

async function sameAccount(want) {
  if (lc((await provider.request({ method: 'eth_accounts' }))[0]) !== lc(want)) { lost('The MetaMask account changed; connect the administrator again.'); throw Error('The MetaMask account changed; connect the administrator again.'); }
}

el('authorize').onclick = async () => {
  if (busy) return; busy = true; render(true); let begun = false, after = null;
  try {
    const from = config.request.transaction.from, comp = config.stages.component;
    await sameAccount(from);
    const b = await api('/upload/begin'); begun = true;
    if (b.message !== 'enclave-upload:' + comp.sha256 + ':' + b.expiry || lc(b.address) !== lc(from)) throw Error('The server asked for a different message than this page shows. Nothing was signed. Stop and ask root.');
    el('message').textContent = b.message + ' (expires ' + new Date(b.expiry * 1000).toISOString() + ')';
    say('Review the message in MetaMask: ' + b.message + '. It authorizes uploading exactly these bytes; it is not a transaction.', 'wait');
    let signature = await provider.request({ method: 'personal_sign', params: [b.messageHex, from] });
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature || '')) throw Error('The wallet returned no signature. Nothing was uploaded.');
    say('Signature received. Uploading to decentralized storage (up to 5 minutes), then verifying the stored bytes (up to 90 seconds). No further wallet action is needed while this runs…', 'wait');
    const sent = api('/upload/signature', { signature }); signature = null;
    const st = await sent;
    after = st.status === 'stored-verified' ? 'Uploaded, stored and verified. Step 2 is enabled.' : (UPLOAD_TEXT[st.status] || st.status);
  } catch (e) {
    if (e.code === 4001 && begun) { try { await api('/upload/rejected', { code: 4001 }); after = 'You rejected the message in MetaMask; nothing was signed or uploaded.'; } catch (x) { say(x.message, 'error'); } }
    else say(e.message + (begun && e.code !== undefined ? ' The wallet did not return a signature; nothing was uploaded. If the request is still open in MetaMask or on the hardware key, reject it; this authorization expires on its own.' : ''), 'error');
  } finally { busy = false; await load(true).catch(() => {}); if (after) say(after, /STOP/.test(after) ? 'error' : 'ok'); }
};

el('verify-storage').onclick = async () => {
  if (busy) return; busy = true; render(true);
  try { const st = await api('/upload/verify-storage'); say(st.status === 'stored-verified' ? UPLOAD_TEXT[st.status] : 'Not verified: ' + (st.lastError || st.status), st.status === 'stored-verified' ? 'ok' : 'wait'); }
  catch (e) { say(e.message, 'error'); } finally { busy = false; await load(true).catch(() => {}); }
};

el('sign').onclick = async () => {
  if (busy) return; busy = true; render(true); let prepared = false, keep = true, after = null;
  try {
    const want = config.request.transaction;
    await sameAccount(want.from);
    if (await provider.request({ method: 'eth_chainId' }) !== want.chainId) await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want.chainId }] });
    if (await provider.request({ method: 'eth_chainId' }) !== want.chainId) throw Error('Select Base in MetaMask before reviewing.');
    say('The server is re-fetching the stored component, rechecking Base on two providers and simulating the exact transaction…', 'wait');
    const tx = (await api('/prepare')).transaction; prepared = true;
    for (const k of ['from', 'to', 'data', 'value', 'chainId']) if (lc(tx[k]) !== lc(want[k])) throw Error('The prepared transaction differs from the displayed one (' + k + '). It was NOT passed to MetaMask. Stop and ask root.');
    el('transaction').textContent = JSON.stringify(tx, null, 2);
    say('Review in MetaMask: to ' + tx.to + ', value ' + eth(tx.value) + ', nonce ' + BigInt(tx.nonce) + '. Do not edit gas or fees. Confirm only if it matches this page.', 'wait');
    const h = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
    if (!HASH.test(h || '')) throw Error('MetaMask returned no transaction hash. Do NOT send again; check MetaMask activity and ask root.');
    hash = h; remember(h); el('hash').value = h; busy = false; await load(true);
    await settle(24);
  } catch (e) {
    if (e.code === 4001 && prepared) {
      try { await api('/rejected', { code: 4001 }); after = 'You rejected the request in MetaMask; nothing was sent. You can review it again.'; } catch (x) { say(x.message, 'error'); }
    } else say(e.message + (prepared ? ' The request stays open; do not send it again. If MetaMask sent it, enter its hash; otherwise reconcile after 5 minutes.' : ''), 'error');
  } finally { busy = false; await load(keep).catch(() => {}); if (after) say(after); }
};

/** /result: records the hash (only if a provider returns it with exactly the request's fields) and verifies it. */
async function settle(tries) {
  for (let i = 0; i < tries; i++) {
    try { const r = await api('/result', { hash }); forget(); await load(true); say('Confirmed: ' + r.transactionHash + '. ' + document.body.dataset.done, 'ok'); return true; }
    catch (e) { say('Submitted ' + hash + '. Not verified yet: ' + e.message, e.status === 409 ? 'error' : 'wait'); if (e.status === 409 || e.status === 403) return false; }
    if (i + 1 < tries) await sleep(5000);
  }
  return false;
}
el('check').onclick = async () => {
  const h = el('hash').value.trim();
  if (!HASH.test(h)) return say('Enter the 0x… transaction hash (66 characters) from MetaMask.', 'error');
  if (busy) return; busy = true; render(true); hash = h;
  try { await settle(1); } finally { busy = false; await load(true).catch(() => {}); }
};
el('reconcile').onclick = async () => {
  if (busy) return; busy = true; render(true);
  try { const r = await api('/reconcile'); await load(true); say(r.reason + (r.reset ? ' The attempt was closed; you may review again.' : ''), r.reset ? 'ok' : 'wait'); }
  catch (e) { say(e.message, 'error'); } finally { busy = false; await load(true).catch(() => {}); }
};
el('retry-same').onclick = async () => {
  // the administrator's explicit choice; nothing uploads until the next signed authorization
  if (busy) return; busy = true; render(true);
  try { await api('/upload/retry-same-bytes', { confirm: 'retry-same-bytes' }); say('The earlier outcome stays unknown. Sign a new authorization for the SAME bytes and CID to upload them again.', 'wait'); }
  catch (e) { say(e.message, 'error'); } finally { busy = false; await load(true).catch(() => {}); }
};

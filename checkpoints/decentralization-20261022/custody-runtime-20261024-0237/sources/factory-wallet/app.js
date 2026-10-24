'use strict';
// Local page for one stage. MetaMask is asked for anything ONLY from a click handler: Connect -> eth_requestAccounts;
// Review -> eth_accounts/eth_chainId (and a chain switch if needed), then the server's fresh preparation, then
// the wallet's send request with exactly the prepared transaction. Nothing signs or sends automatically. The page refuses to
// pass on a prepared transaction whose sender/target/calldata/value/chain differ from what it displayed.
const el = (id) => document.getElementById(id);
const HASH = /^0x[0-9a-fA-F]{64}$/, KEY = 'enclave-book-factory-' + document.body.dataset.stage + '-hash';
const lc = (x) => String(x || '').toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let provider, config, connected = false, busy = false, hash = null;

function say(text, kind) { el('status').textContent = text; el('status').dataset.kind = kind || ''; }
function eth(v) { const w = BigInt(v), s = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, ''); return (w / 10n ** 18n) + (s ? '.' + s : '') + ' ETH (' + w + ' wei)'; }
const stored = () => { try { const h = localStorage.getItem(KEY); return HASH.test(h || '') ? h : null; } catch { return null; } };
const remember = (h) => { try { localStorage.setItem(KEY, h); } catch {} };
const forget = () => { try { localStorage.removeItem(KEY); } catch {} };

function found(p) { if (provider) return; provider = p; el('wallet').textContent = 'MetaMask detected.'; el('connect').disabled = false;
  p.on?.('accountsChanged', (a) => { if (config && lc(a?.[0]) !== lc(config.request.transaction.from)) { connected = false; el('connect').disabled = false; el('wallet').textContent = 'MetaMask account changed; connect the administrator again.'; render(true); } }); }
window.addEventListener('eip6963:announceProvider', (event) => { if (event.detail?.info?.rdns === 'io.metamask') found(event.detail.provider); });
window.dispatchEvent(new Event('eip6963:requestProvider'));
setTimeout(() => { if (!provider) { const p = window.ethereum?.providers?.find((x) => x.isMetaMask) || window.ethereum; if (p?.isMetaMask) found(p); else el('wallet').textContent = 'MetaMask was not detected. Enable the extension for this local page and reload.'; } }, 500);

async function api(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signing-Token': config.token }, body: JSON.stringify(data || {}) });
  const j = await r.json(); if (!r.ok) throw Object.assign(Error(j.error || 'request failed'), { status: r.status }); return j;
}
function render(keep) {
  const s = config.state, tx = config.request.transaction;
  el('from').textContent = tx.from; el('to').textContent = tx.to; el('value').textContent = eth(tx.value);
  el('transaction').textContent = JSON.stringify(s.request ? s.request.transaction : tx, null, 2);
  hash = s.hash || hash || stored();
  const open = s.status === 'awaiting-wallet' || s.status === 'submitted';
  el('recover').hidden = !open;
  if (hash && !el('hash').value) el('hash').value = hash;
  el('hash').readOnly = !!s.hash;
  el('check').disabled = busy || !open;
  el('sign').disabled = busy || !connected || s.status !== 'ready';
  if (keep) return;
  const nonce = s.request?.transaction?.nonce ? ' (nonce ' + BigInt(s.request.transaction.nonce) + ')' : '';
  if (s.status === 'ready') say(connected ? 'Administrator connected. Click Review transaction in MetaMask: the server rechecks Base first, then MetaMask opens with the exact transaction.'
    : 'Ready. Connect MetaMask with the administrator account shown above. Nothing is requested until you click.');
  else if (s.status === 'preparing') say('The server is preparing a request. Reload in a few seconds.', 'wait');
  else if (s.status === 'awaiting-wallet') say('A transaction' + nonce + ' was handed to MetaMask. Do NOT send it again. If MetaMask sent it, enter its hash below (MetaMask activity tab) and click Check pending transaction. If it was never sent, ask root to inspect the administrator nonce before any reset.', 'wait');
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

el('sign').onclick = async () => {
  if (busy) return; busy = true; render(true); let prepared = false, keep = true, after = null;
  try {
    const want = config.request.transaction;
    if (lc((await provider.request({ method: 'eth_accounts' }))[0]) !== lc(want.from)) { connected = false; el('connect').disabled = false; throw Error('The MetaMask account changed; connect the administrator again.'); }
    if (await provider.request({ method: 'eth_chainId' }) !== want.chainId) await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want.chainId }] });
    if (await provider.request({ method: 'eth_chainId' }) !== want.chainId) throw Error('Select Base in MetaMask before reviewing.');
    say('The server is rechecking Base on two providers and simulating the exact transaction…', 'wait');
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
    } else say(e.message + (prepared ? ' The request stays open; do not send it again.' : ''), 'error');
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

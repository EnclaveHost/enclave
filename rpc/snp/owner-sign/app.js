// Owner signing page: one eth_sendTransaction per click, from the connected owner account only.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let plan, account, provider = window.ethereum;

async function getJson(url, init) { const r = await fetch(url, init); return r.json(); }

function render(status) {
  $('steps').innerHTML = plan.steps.map((s, i) => {
    const done = status?.[s.id] === true, ready = status?.ready?.[s.id] === true;
    const tag = done ? '<span class="tag done">Done on chain</span>' : ready ? '<span class="tag ready">Ready</span>'
      : `<span class="tag">${esc(status?.blocked?.[s.id] ? 'Waiting: ' + status.blocked[s.id] : 'Waiting for an earlier step')}</span>`;
    const rows = Object.entries(s.show).map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`).join('');
    const note = status?.note?.[s.id] ? `<p class="why">${esc(status.note[s.id])}</p>` : '';
    return `<section class="step"><h2>${i + 1}. ${esc(s.title)} ${tag}</h2><p class="why">${esc(s.why)}</p>${note}
      <table>${rows}<tr><td>To</td><td><code>${esc(s.to || 'none: a contract creation')}</code></td></tr><tr><td>Value</td><td><code>${esc(s.valueEth)} ETH</code></td></tr></table>
      <button data-step="${esc(s.id)}" ${!account || done || !ready ? 'disabled' : ''}>Sign step ${i + 1}</button><div class="msg" id="msg-${esc(s.id)}"></div></section>`;
  }).join('');
  for (const b of document.querySelectorAll('button[data-step]')) b.onclick = () => sign(b.dataset.step);
}

async function refresh() { try { render(await getJson('/status')); } catch { render(null); } }

async function connect() {
  if (!provider) { $('who').textContent = 'No browser wallet found'; return; }
  const [a] = await provider.request({ method: 'eth_requestAccounts' });
  const chain = await provider.request({ method: 'eth_chainId' });
  if (parseInt(chain, 16) !== plan.chainId) {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + plan.chainId.toString(16) }] });
  }
  if (a.toLowerCase() !== plan.owner.toLowerCase()) { $('who').textContent = `Connected ${a}, but the owner is ${plan.owner}. Switch accounts.`; account = null; return refresh(); }
  account = a; $('who').textContent = `Owner connected: ${a}`; refresh();
}

async function sign(id) {
  const s = plan.steps.find((x) => x.id === id), msg = $('msg-' + id);
  msg.className = 'msg'; msg.textContent = 'Confirm on the Trezor…';
  try {
    if (parseInt(await provider.request({ method: 'eth_chainId' }), 16) !== plan.chainId) throw new Error('wallet is not on Base');
    // a step without `to` is a contract creation; a step may fix its gas limit
    const tx = { from: account, data: s.data, value: s.value, ...(s.to ? { to: s.to } : {}), ...(s.gas ? { gas: s.gas } : {}) };
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
    await getJson('/submitted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: id, hash }) });
    msg.textContent = 'Sent: ' + hash + ' — waiting for it to be included…';
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 3000)); const st = await getJson('/status'); if (st[id]) break; }
    refresh();
  } catch (e) { msg.className = 'msg err'; msg.textContent = (e && e.code === 4001) ? 'Rejected in the wallet. Nothing was sent.' : 'Not sent: ' + (e.message || e); }
}

plan = await getJson('/plan');
if (plan.title) { document.title = plan.title; $('title').textContent = plan.title; }
if (plan.lead) $('lead').textContent = plan.lead;
$('connect').onclick = () => connect().catch((e) => { $('who').textContent = 'Wallet error: ' + e.message; });
refresh(); setInterval(refresh, 15000);

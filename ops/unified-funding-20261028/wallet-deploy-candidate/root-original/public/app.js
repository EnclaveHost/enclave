'use strict';
// Review page for the four additive funding deployment transactions.
// Wallet requests happen only inside explicit click handlers. Page load and connect never send anything.
(() => {
  const TOKEN = document.querySelector('meta[name="deploy-token"]').getAttribute('content');
  const WALLET_TIMEOUT_MS = 15 * 60 * 1000;
  const POLL_MS = 15000;
  const POLL_MAX = 60;
  const $ = (id) => document.getElementById(id);
  const wallet = {account: null, chainId: null, listening: false};
  const polls = new Map();
  const hashInputs = new Map();
  let S = null;
  let inflight = false;

  const lc = (s) => String(s == null ? '' : s).toLowerCase();
  const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  const sameAddr = (a, b) => isAddr(a) && isAddr(b) && lc(a) === lc(b);
  const hexQ = (n) => '0x' + BigInt(n).toString(16);
  const units = (wei, decimals, unit) => {
    const v = BigInt(wei), d = 10n ** BigInt(decimals);
    const f = (v % d).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${v / d}${f ? '.' + f : ''} ${unit}`;
  };
  const fmtEth = (wei) => units(wei, 18, 'ETH');
  const fmtGwei = (wei) => units(wei, 9, 'gwei');
  const describe = (e) => `${e && e.code !== undefined ? '[' + e.code + '] ' : ''}${String(e && e.message !== undefined ? e.message : e).slice(0, 200)}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
        else if (k === 'disabled') n.disabled = !!v;
        else n.setAttribute(k, v);
      }
    }
    for (const k of kids) if (k !== null && k !== undefined) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  const log = (msg, cls) => $('log').prepend(el('li', cls ? {class: cls} : null, `${new Date().toISOString()}  ${msg}`));
  const showRefusal = (r, prefix) => log(`${prefix ? prefix + ': ' : ''}REFUSED ${r.code}: ${r.message}`, 'bad');

  async function api(name, body) {
    const init = body === undefined
      ? {method: 'GET', cache: 'no-store', credentials: 'same-origin'}
      : {method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: {'content-type': 'application/json', 'x-deploy-token': TOKEN}, body: JSON.stringify(body)};
    const res = await fetch('api/' + name, init);
    try { return await res.json(); } catch { throw new Error(`server returned non-JSON (HTTP ${res.status})`); }
  }
  async function refresh() { S = await api('state'); render(); }

  const ownerOk = () => !!S && sameAddr(wallet.account, S.owner);
  const chainOk = () => !!S && lc(wallet.chainId) === S.chainHex;
  const canSend = (i) => {
    const t = S.transactions[i];
    return S.signing.enabled && !inflight && !S.busy && !S.halted && ownerOk() && chainOk() && S.nextIndex === i
      && ['none', 'rejected', 'released'].includes(t.journal.state);
  };

  function render() {
    if (!S) return;
    const sig = $('signing');
    sig.replaceChildren();
    if (S.signing.enabled) {
      sig.append(el('div', {class: 'banner-on'}, el('strong', {text: 'Wallet requests enabled by a reviewed authorization artifact. '}),
        `Reviewed by ${S.signing.reviewedBy} at ${S.signing.reviewedAt}; valid until ${S.signing.notAfter}. `
        + `Activation source sha256 (recorded, not verified by this tool): ${S.signing.activationSourceSha256}. This is not production activation approval.`));
    } else {
      sig.append(el('div', {class: 'banner-off'}, el('strong', {text: 'SIGNING_DISABLED. '}), S.signing.reason, ' Review only; no wallet request can be made.'));
    }
    if (S.halted) sig.append(el('p', {class: 'bad', text: 'A transaction is HALTED. Nothing further is offered; root must reconcile.'}));
    if (S.nextIndex === null) sig.append(el('p', {class: 'good', text: 'All four creations are confirmed and runtime-verified.'}));

    $('owner').textContent = S.owner;
    $('account').textContent = wallet.account || 'not connected';
    $('chain').textContent = wallet.chainId || '-';
    const ws = $('walletStatus');
    ws.replaceChildren();
    if (wallet.account) {
      ws.append(el('span', {class: ownerOk() ? 'good' : 'bad', text: ownerOk() ? 'owner matches' : 'NOT the expected owner'}), ' ',
        el('span', {class: chainOk() ? 'good' : 'bad', text: chainOk() ? 'chain 8453' : 'WRONG chain'}));
    }
    $('connect').disabled = inflight;
    renderCost();
    renderTxs();
  }

  function renderCost() {
    const c = $('cost');
    const head = el('tr', null, ...['#', 'Contract', 'Nonce', 'Value', 'Gas cap', 'maxFeePerGas', 'maxPriorityFeePerGas', 'L2 cap (hard)',
      'L1 observed', 'Operator observed', 'Total observed'].map((h) => el('th', {text: h})));
    const rows = S.transactions.map((t) => el('tr', null, ...[t.index + 1, t.name, t.nonce, '0 ETH', t.gas, fmtGwei(t.maxFeePerGas),
      fmtGwei(t.maxPriorityFeePerGas), fmtEth(t.l2CapWei), fmtEth(t.l1ObservedWei), fmtEth(t.operatorObservedWei), fmtEth(t.totalObservedWei)]
      .map((v) => el('td', {text: String(v)}))));
    const total = el('tr', null, el('td', {colspan: '10', text: 'Total observed bound (all four)'}), el('td', {text: fmtEth(S.cost.totalObservedBoundWei)}));
    c.replaceChildren(el('h2', {text: 'Cost observation'}), el('table', null, head, ...rows, total),
      el('p', {class: 'warn', text: S.cost.caveat}),
      el('p', {class: 'note', text: `Every transfer value is zero. Nonces are not reserved and are re-read on both providers before each request. `
        + `${S.preserved.pinnedCodehashes} original contracts are re-checked by code hash before each request and after each receipt.`}));
  }

  function field(label, value) { return el('tr', null, el('th', {text: label}), el('td', null, el('code', {text: String(value)}))); }

  function renderTxs() {
    const box = $('txs');
    box.replaceChildren(el('h2', {text: 'Transactions (sequential)'}));
    S.transactions.forEach((t, i) => {
      const j = t.journal;
      const area = el('textarea', {readonly: 'readonly', spellcheck: 'false'});
      area.value = t.data;
      const hashIn = el('input', {class: 'hash', type: 'text', placeholder: 'optional: transaction hash from wallet activity (0x...)',
        oninput: (ev) => hashInputs.set(i, ev.target.value)});
      hashIn.value = hashInputs.get(i) || '';
      const sendBtn = el('button', {type: 'button', disabled: !canSend(i), onclick: () => sendTx(i)},
        `Refresh checks and request wallet signature for ${t.name}`);
      const recBtn = el('button', {type: 'button', disabled: inflight || ['none', 'confirmed', 'halted'].includes(j.state),
        onclick: () => manualReconcile(i)}, 'Reconcile (re-read both providers)');
      const events = el('ol', null, ...j.events.map((ev) => el('li', null, el('code', {text: JSON.stringify(ev)}))));
      box.append(el('div', {class: 'tx'},
        el('h3', null, `#${i + 1} ${t.name} `, el('span', {class: 'state', text: `[${j.state}]`})),
        el('table', null,
          field('Kind', 'contract creation (no "to")'),
          field('Value', '0 ETH (zero transfer value)'),
          field('From (expected owner)', t.from),
          field('Chain', `${t.chainId} (${S.chainHex})`),
          field('Nonce', `${t.nonce} (not reserved; refreshed before the request)`),
          field('Gas cap', t.gas),
          field('maxFeePerGas / maxPriorityFeePerGas', `${t.maxFeePerGas} wei (${fmtGwei(t.maxFeePerGas)}) / ${t.maxPriorityFeePerGas} wei (${fmtGwei(t.maxPriorityFeePerGas)})`),
          field('Max L2 cost (gas cap x maxFeePerGas)', fmtEth(t.l2CapWei)),
          field('Predicted address', t.predictedAddress),
          field('Expected runtime', `${t.runtimeCodehash} (${t.runtimeBytes} bytes, fork evidence)`),
          field('Initcode', `${t.dataBytes} bytes, keccak ${t.dataHash}`),
          field('Constructor arguments', t.constructorArgs.length ? t.constructorArgs.join(', ') : '(none)'),
          ...(i === 3 ? [field('Implementation created by factory', `${S.implementation.address} runtime ${S.implementation.runtimeCodehash}`)] : []),
          field('Journal hash', j.hash || '-'),
          field('Candidate hashes (untrusted until verified)', j.reportedHashes.join(', ') || '-'),
          field('Outcome', j.outcome ? JSON.stringify(j.outcome) : '-'),
          field('Receipt', j.receipt ? JSON.stringify(j.receipt) : '-')),
        el('details', null, el('summary', {text: `Transaction data (initcode, ${t.dataBytes} bytes)`}), area),
        el('div', null, sendBtn),
        el('div', null, hashIn, recBtn),
        el('details', null, el('summary', {text: 'Journal events (latest)'}), events)));
    });
  }

  function checkParams(p, t) {
    const want = {from: S.owner, data: t.data, value: '0x0', gas: hexQ(t.gas), maxFeePerGas: hexQ(t.maxFeePerGas),
      maxPriorityFeePerGas: hexQ(t.maxPriorityFeePerGas), nonce: hexQ(t.nonce), chainId: S.chainHex, type: '0x2'};
    if (!p || typeof p !== 'object') return 'missing';
    if (Object.keys(p).sort().join(',') !== Object.keys(want).sort().join(',')) return 'fields';
    for (const k of Object.keys(want)) if (lc(p[k]) !== lc(want[k])) return k;
    return null;
  }

  async function connect() {
    const provider = window.ethereum;
    if (!provider || typeof provider.request !== 'function') { log('No injected wallet (window.ethereum) found.', 'bad'); return; }
    try {
      const accts = await provider.request({method: 'eth_requestAccounts'});
      wallet.account = (accts && accts[0]) || null;
      wallet.chainId = await provider.request({method: 'eth_chainId'});
      log(`Connected ${wallet.account} on chain ${wallet.chainId}.`, ownerOk() && chainOk() ? 'good' : 'bad');
    } catch (e) { log('Wallet connect failed: ' + describe(e), 'bad'); }
    if (!wallet.listening && typeof provider.on === 'function') {
      provider.on('accountsChanged', (a) => { wallet.account = (a && a[0]) || null; render(); });
      provider.on('chainChanged', (c) => { wallet.chainId = c; render(); });
      wallet.listening = true;
    }
    render();
  }

  // POST with a short bounded retry only on `busy` (another server action running). Never retries a wallet request.
  async function post(name, body) {
    for (let k = 0; k < 5; k++) {
      const r = await api(name, body);
      if (r.ok || r.refusal.code !== 'busy') return r;
      await sleep(3000);
    }
    return api(name, body);
  }

  async function reconcile(i, hash) {
    const body = {index: i};
    if (hash) body.hash = hash;
    const r = await post('reconcile', body);
    const name = S.transactions[i].name;
    if (!r.ok) { showRefusal(r.refusal, `reconcile ${name}`); return r; }
    log(`${name}: ${r.state}${r.code ? ' (' + r.code + ')' : ''}${r.message ? ' - ' + r.message : ''}`,
      r.state === 'confirmed' ? 'good' : r.state === 'halted' ? 'bad' : null);
    return r;
  }

  function startPolling(i) {
    if (polls.has(i)) return;
    let n = 0;
    const tick = async () => {
      n += 1;
      let r = null;
      try { r = await reconcile(i); } catch (e) { log('reconcile error: ' + describe(e), 'bad'); }
      await refresh().catch(() => {});
      const st = r && r.ok ? r.state : null;
      if (['confirmed', 'halted', 'rejected'].includes(st) || n >= POLL_MAX) {
        polls.delete(i);
        if (st !== 'confirmed' && n >= POLL_MAX) log(`Stopped automatic status checks for ${S.transactions[i].name}; use Reconcile. Nothing was resent.`);
        return;
      }
      polls.set(i, setTimeout(tick, POLL_MS));
    };
    polls.set(i, setTimeout(tick, POLL_MS));
  }

  async function recordHash(i, offerId, hash) {
    const name = S.transactions[i].name;
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      log(`Wallet returned a non-hash value for ${name}; recorded as unknown.`, 'bad');
      const r = await post('report', {index: i, offerId, kind: 'unknown', message: 'wallet returned a non-hash value'});
      if (!r.ok) showRefusal(r.refusal, 'recording unknown outcome');
      startPolling(i);
      return;
    }
    log(`Wallet returned ${hash} for ${name}. Untrusted until both providers verify it. Keep this hash.`);
    let r = await post('report', {index: i, offerId, kind: 'hash', hash});
    // A late hash for an offer that is no longer open is still recorded through reconcile.
    if (!r.ok && ['offer_mismatch', 'no_open_request'].includes(r.refusal.code)) r = await post('reconcile', {index: i, hash});
    if (!r.ok) showRefusal(r.refusal, `recording hash ${hash}; paste it into Reconcile`);
    startPolling(i);
  }

  async function sendTx(i) {
    if (inflight || !S || !canSend(i)) return;
    inflight = true;
    render();
    const t = S.transactions[i];
    try {
      const provider = window.ethereum;
      if (!provider || typeof provider.request !== 'function') { log('No injected wallet (window.ethereum) found.', 'bad'); return; }
      const accts = await provider.request({method: 'eth_accounts'});
      const chainId = await provider.request({method: 'eth_chainId'});
      wallet.account = (accts && accts[0]) || null;
      wallet.chainId = chainId;
      if (!ownerOk()) { log(`Connected account ${wallet.account} is not the expected owner ${S.owner}. Not requesting.`, 'bad'); return; }
      if (!chainOk()) { log(`Wallet is on chain ${chainId}, not 0x2105. Switch it in the wallet. Not requesting.`, 'bad'); return; }
      log(`Refreshing nonce, original bindings, prior runtimes, balance and fee conditions on both providers for ${t.name}...`);
      const prep = await api('prepare', {index: i, account: wallet.account, walletChainId: chainId});
      if (!prep.ok) { showRefusal(prep.refusal, `prepare ${t.name}`); return; }
      const bad = checkParams(prep.params, t);
      if (bad) {
        log(`Prepared request differs from the reviewed transaction (${bad}); not sent.`, 'bad');
        const r = await post('report', {index: i, offerId: prep.offerId, kind: 'not_sent', message: 'page refused prepared params: ' + bad});
        if (!r.ok) showRefusal(r.refusal, 'recording not_sent');
        return;
      }
      log(`Checks passed at block ${prep.preflight.block} (base fee ${fmtGwei(prep.preflight.baseFeePerGas)}). Wallet request opened for ${t.name}: `
        + `contract creation, 0 ETH, nonce ${t.nonce}, gas cap ${t.gas}. Review it in the wallet.`);
      const walletPromise = provider.request({method: 'eth_sendTransaction', params: [prep.params]});
      let timer;
      const outcome = await Promise.race([
        walletPromise.then((hash) => ({hash}), (error) => ({error})),
        new Promise((resolve) => { timer = setTimeout(() => resolve({timeout: true}), WALLET_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      if ('hash' in outcome) {
        await recordHash(i, prep.offerId, outcome.hash);
      } else if (outcome.error && outcome.error.code === 4001) {
        const r = await post('report', {index: i, offerId: prep.offerId, kind: 'rejected', code: 4001});
        if (!r.ok) showRefusal(r.refusal, 'recording rejection');
        else log(`${t.name}: rejected in the wallet. ${r.message || ''}`);
      } else {
        const err = outcome.error;
        const body = {index: i, offerId: prep.offerId, kind: 'unknown', message: outcome.timeout ? 'wallet did not answer within 15 minutes' : describe(err)};
        if (err && Number.isInteger(err.code)) body.code = err.code;
        const r = await post('report', body);
        log(`${t.name}: wallet outcome UNKNOWN (${outcome.timeout ? 'timeout' : describe(err)}). Nothing will be resent. `
          + `Check wallet activity for nonce ${t.nonce}; if it has a hash, paste it into Reconcile.`, 'bad');
        if (!r.ok) showRefusal(r.refusal, 'recording unknown outcome');
        if (outcome.timeout) walletPromise.then((h) => recordHash(i, prep.offerId, h), () => {});
        startPolling(i);
      }
    } catch (e) {
      log(`Error: ${describe(e)}. Server state is preserved; reconcile before any new request.`, 'bad');
    } finally {
      inflight = false;
      await refresh().catch((e) => log('state refresh failed: ' + describe(e), 'bad'));
    }
  }

  async function manualReconcile(i) {
    if (inflight) return;
    const raw = (hashInputs.get(i) || '').trim();
    if (raw && !/^0x[0-9a-fA-F]{64}$/.test(raw)) { log('Hash must be 0x followed by 64 hex characters.', 'bad'); return; }
    inflight = true;
    render();
    try { await reconcile(i, raw || undefined); } catch (e) { log('reconcile error: ' + describe(e), 'bad'); } finally {
      inflight = false;
      await refresh().catch(() => {});
    }
  }

  $('connect').addEventListener('click', connect);
  refresh().catch((e) => log('Cannot load state: ' + describe(e), 'bad'));
})();

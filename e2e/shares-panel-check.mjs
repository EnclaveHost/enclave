// Standalone browser regression check: real panel, calldata encoder and resize
// lifecycle; stub ledger/wallet. Never connects a wallet or sends a transaction.
// Run: node e2e/shares-panel-check.mjs
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { decodeFunctionData } from 'viem';
const root = new URL('../', import.meta.url);
const text = await fs.readFile(new URL('site/components/deployments/deployments.js', root), 'utf8');
const method = text.slice(text.indexOf('  async _upgrade('), text.indexOf('  /* ---- per-row Protect:'));
const bundle = await build({ stdin: { contents: `import * as chain from './site/js/core/chain.js'; import * as resize from './site/js/core/share-resize.js'; window.real = { ...chain, ...resize };`, resolveDir: root.pathname }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
try {
 const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
 await page.route('**/*', route => route.abort());
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.setContent('<main></main>');
 await page.addScriptTag({ content: bundle.outputFiles[0].text });
 await page.evaluate(({ method }) => {
   window.id = '0x' + 'a'.repeat(64);
   window.zero = '0x' + '0'.repeat(64);
   window.makePanel = async (panel, support = false, single = false) => {
     window.model = { owner: '0x123', appRef: 'catalog://app/0', active: true, runner: '0x' + 'b'.repeat(64), leaseUntil: Math.floor(Date.now()/1000)+300, cpuMilli: 10, gpuMilli: 0, balance6: 1000000, rate: 9 };
     window.calls = []; window.support = support;
     document.querySelector('main').innerHTML = '<div class="enc-row"><div class="enc-tabs"><button id="version">Version</button><button id="shares">Shares</button></div><div class="enc-upg" hidden></div><div class="enc-shares" hidden></div></div>';
     const versions = [{ version: '1.0', approval: 1, mins: { gpuPct: 0, cpuPct: 1 } }, ...(single ? [] : [{ version: '1.1', approval: 1, mins: { gpuPct: 0, cpuPct: 2 } }, { version: '1.2', approval: 1, mins: { gpuPct: 0, cpuPct: 1 } }])];
     const deps = {
       ...window.real,
       esc: s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
       depGet: async () => ({ ...window.model }), depSchemaRev: async () => 13,
       loadCatalog: async () => {}, adoptServerSpec: () => {},
       Enclave: { provider: {}, base: 'https://not-real.invalid', getAvailability: async () => ({ shareResize: window.support, rateCap: true }), getEnclaves: async () => [] },
       parseCatalogRef: () => ({ appId: 'app', index: 0 }), catalogRef: (_, i) => 'catalog://app/'+i,
       STORE: { byId: { app: { slug: 'jot', versions } } }, APPROVAL: { approved: 1 },
       depFeeOf: async () => ({ feePerSec6: 0n }), catVersionFee: async () => 0n,
       depPrices6: async () => ({ gpu: 1667n, cpu: 834n }), depMaxGpuMilli: async () => 1000,
       depCapOf: async () => 1000n,
       leaseHostOf: () => ({ name: 'metal-iso0', row: { availability: { gpu: false } }, spec: { nodeRamGb: 64, nodeVcpus: 16 } }),
       hostChargeWaived: () => false, minPctsOf: x => x.mins, specOf: x => x,
       cpuFloorFor: x => x.cpuPct, cardServesApp: () => false, sharesLegalOn: () => true,
       appLabel: () => 'aaaaaaaa', ctlOf: () => 'wallet', fmtDur: s => s+'s',
       paintLine: (el, cls, value) => { const p=document.createElement('p');p.className=cls;p.textContent=value;el.append(p); },
       ensureBaseChain: async () => {}, connectWallet: async () => {}, refreshWallet: () => {},
       DEPLOYMENTS_ADDRESS: '0x'+'1'.repeat(40),
       sendTx: async (_, data) => { window.calls.push(data); if (window.calls.length === 1 && !window.support) { window.model.active=false;window.model.runner=window.zero;window.model.leaseUntil=0; } return '0xabc'; },
       waitReceipt: async () => {}, showToast: () => {},
       fetch: async () => ({}), setTimeout: () => 0,
     };
     const ctx = { _list: [{ id: window.id }], refresh() {} };
     const fn = new Function('deps', 'with(deps) { return ({'+method+'})._upgrade; }')(deps);
     await fn.call(ctx, window.id, document.getElementById(panel), panel);
   };
 }, { method });
 await page.evaluate(() => window.makePanel('shares', false, true));
 assert.equal(await page.locator('.enc-shares .eu-sel').count(), 0);
 assert.equal(await page.locator('.eu-cpu').inputValue(), '1');
 assert.equal(await page.locator('.eu-cpu').isEnabled(), true);
 assert.equal(await page.locator('.eu-go').isDisabled(), true);
 await page.locator('.eu-cpu').fill('3');
 assert.equal(await page.locator('.eu-go').innerText(), 'Resize and restart');
 await page.locator('.eu-go').click();
 await page.waitForFunction(() => window.calls.length === 2);
 const abi = JSON.parse(await fs.readFile(new URL('contracts/EnclaveDeployments.abi.json', root), 'utf8'));
 const calls = await page.evaluate(() => window.calls);
 const suspend = decodeFunctionData({ abi, data: calls[0] });
 assert.equal(suspend.functionName, 'setActive'); assert.equal(suspend.args[1], false);
 const finish = decodeFunctionData({ abi, data: calls[1] });
 assert.equal(finish.functionName, 'multicall');
 const inside = finish.args[0].map(data => decodeFunctionData({ abi, data }));
 assert.deepEqual(inside.map(x => x.functionName), ['setShares','setActive']);
 assert.equal(Number(inside[0].args[2]), 30); assert.equal(inside[1].args[1], true);
 await page.evaluate(() => window.makePanel('version', true));
 assert.equal(await page.locator('.enc-upg .eu-cpu').count(), 0);
 assert.equal(await page.locator('.enc-upg .eu-cap').count(), 0);
 assert.equal(await page.locator('.eu-sel').inputValue(), '2');
 assert.equal(await page.locator('.eu-sel option[value="1"]').isDisabled(), true);
 await page.locator('.eu-go').click();
 await page.waitForFunction(() => window.calls.length === 1);
 assert.equal(decodeFunctionData({ abi, data: (await page.evaluate(() => window.calls))[0] }).functionName, 'setAppRef');
 await page.evaluate(() => window.makePanel('shares', true));
 assert.equal(await page.locator('.eu-cpu').inputValue(), '1');
 await page.locator('.eu-cpu').fill('0'); await page.locator('.eu-go').click();
 assert.equal((await page.evaluate(() => window.calls)).length, 0);
 await page.locator('.eu-cpu').fill('2'); await page.locator('.eu-go').click();
 await page.waitForFunction(() => window.calls.length === 1);
 assert.equal(decodeFunctionData({ abi, data: (await page.evaluate(() => window.calls))[0] }).functionName, 'setShares');
 assert.deepEqual(errors, []);
 console.log('PASS: separate panels, current-version pin, app floors, restart resize, direct resize, exact calldata');
} finally { await browser.close(); }

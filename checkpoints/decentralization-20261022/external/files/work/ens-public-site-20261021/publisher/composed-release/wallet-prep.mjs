// UNSIGNED wallet steps with the EXISTING enclave CLI, then simulated; nothing is signed or sent, no key is read.
// The CLI runs with an EMPTY temporary HOME/XDG_CONFIG_HOME and no ENCLAVE_* env, so it cannot see a key or a session:
//   enclave --json --yes --unsigned --from <owner> config show|set|upgrade ...
// (--yes only answers the CLI's prompt; with --unsigned the CLI prints the transaction and exits.)
// The unsigned setConfig is then eth_call'ed + gas-estimated from the owner on two RPCs at one agreed block, and its
// envelope decoded and diffed against the live one.
//   node wallet-prep.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire('/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/package.json');
const { createPublicClient, http, decodeFunctionData, parseAbi } = require('viem');

const CLI = '/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/cli/enclave.mjs';
const OWNER = '0x0b2d009c0c9Af05b12100D77F3c815fea822eE61';
const DEP = '0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a';
const HOLD = path.resolve('../publisher-config-allblocks.HOLD.json'), CURRENT = path.resolve('../publisher-config-current.json');
const RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const sha = (b) => createHash('sha256').update(b).digest('hex');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-empty-home-'));
const ENV = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), NODE_NO_WARNINGS: '1' };
function cli(args) {
  try { return { rc: 0, out: execFileSync('node', [CLI, '--json', ...args], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }) }; }
  catch (e) { return { rc: e.status, out: String(e.stdout || ''), err: String(e.stderr || '').trim().split('\n').slice(-3).join(' | ') }; }
}
const json = (s) => { try { const t = s.trim(); return JSON.parse(t.slice(t.indexOf('{'))); } catch { return null; } };
const out = { at: new Date().toISOString(), cliHome: { empty: true, entriesAfter: null }, steps: {} };

// live envelope (no key needed)
const show = cli(['--unsigned', '--from', OWNER, 'config', 'show', DEP]); const live = json(show.out);
out.steps.configShow = { rc: show.rc, err: show.err, envelopeSha256: live ? sha(live.envelope) : null, envelopeBytes: live ? Buffer.byteLength(live.envelope) : null,
  liveConfigEqualsCurrentFile: live ? JSON.stringify(live.config) === JSON.stringify(JSON.parse(fs.readFileSync(CURRENT, 'utf8'))) : null,
  versionConfigSha256: live?.versionConfig ? sha(live.versionConfig) : null };

// step 3 (after the upgrade): config set with the HOLD file
const set = cli(['--yes', '--unsigned', '--from', OWNER, 'config', 'set', DEP, '--file', HOLD]); const setTx = json(set.out)?.unsigned;
out.steps.configSet = { cmd: `enclave --json --yes --unsigned --from ${OWNER} config set ${DEP} --file publisher-config-allblocks.HOLD.json`, rc: set.rc, err: set.err, unsigned: setTx || null };
if (setTx) {
  const abi = parseAbi(['function setConfig(bytes32 id, string configCid)']);
  const { args } = decodeFunctionData({ abi, data: setTx.data });
  const nextEnv = JSON.parse(args[1]), curEnv = live?.envelope ? JSON.parse(live.envelope) : {};
  const keys = new Set([...Object.keys(curEnv), ...Object.keys(nextEnv)]);
  const changedTop = [...keys].filter((k) => JSON.stringify(curEnv[k]) !== JSON.stringify(nextEnv[k]));
  const cfgKeys = new Set([...Object.keys(curEnv.config || {}), ...Object.keys(nextEnv.config || {})]);
  const changedCfg = [...cfgKeys].filter((k) => JSON.stringify((curEnv.config || {})[k]) !== JSON.stringify((nextEnv.config || {})[k]));
  const ipniDiff = Object.keys({ ...(curEnv.config?.ipni || {}), ...(nextEnv.config?.ipni || {}) }).filter((k) => JSON.stringify(curEnv.config?.ipni?.[k]) !== JSON.stringify(nextEnv.config?.ipni?.[k]));
  Object.assign(out.steps.configSet, { dataSha256: sha(Buffer.from(setTx.data.slice(2), 'hex')), id: args[0], newEnvelopeSha256: sha(args[1]), newEnvelopeBytes: Buffer.byteLength(args[1]),
    newConfigEqualsHoldFile: JSON.stringify(nextEnv.config) === JSON.stringify(JSON.parse(fs.readFileSync(HOLD, 'utf8'))),
    diffVsLive: { topLevelKeysChanged: changedTop, configKeysChanged: changedCfg, ipniKeysChanged: ipniDiff,
      announceAllBlocks: [curEnv.config?.ipni?.announceAllBlocks ?? null, nextEnv.config?.ipni?.announceAllBlocks ?? null] } });
  // simulate: two RPCs, one agreed block
  const cs = RPCS.map((u) => ({ u, c: createPublicClient({ transport: http(u, { timeout: 20000, retryCount: 1 }) }) }));
  const heads = await Promise.all(cs.map((r) => r.c.getBlockNumber())); const B = (heads[0] < heads[1] ? heads[0] : heads[1]) - 5n;
  const hashes = await Promise.all(cs.map((r) => r.c.getBlock({ blockNumber: B }).then((b) => b.hash)));
  out.steps.configSet.simulation = { block: Number(B), hash: hashes[0], agreed: hashes[0] === hashes[1] };
  for (const r of cs) {
    try { await r.c.call({ account: OWNER, to: setTx.to, data: setTx.data, value: 0n, blockNumber: B });
      out.steps.configSet.simulation[r.u] = { ok: true, gas: String(await r.c.estimateGas({ account: OWNER, to: setTx.to, data: setTx.data, value: 0n })) };
    } catch (e) { out.steps.configSet.simulation[r.u] = { ok: false, revert: String(e.shortMessage || e.message).slice(0, 200) }; }
  }
}

// step 2 (after the publish is mined): the upgrade. Before 1.0.6 exists the CLI must refuse to build it.
const up = cli(['--yes', '--unsigned', '--from', OWNER, 'upgrade', DEP, '1.0.6']);
out.steps.upgradeBeforePublish = { cmd: `enclave --json --yes --unsigned --from ${OWNER} upgrade ${DEP} 1.0.6`, rc: up.rc, err: up.err, unsigned: json(up.out)?.unsigned || null };
// the rollback config tx (current file), generated the same way; not simulated against a post-change state
const rb = cli(['--yes', '--unsigned', '--from', OWNER, 'config', 'set', DEP, '--file', CURRENT]);
out.steps.rollbackConfigSet = { cmd: `enclave --json --yes --unsigned --from ${OWNER} config set ${DEP} --file publisher-config-current.json`, rc: rb.rc, err: rb.err, unsigned: json(rb.out)?.unsigned || null };

out.cliHome.entriesAfter = fs.readdirSync(home, { recursive: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));

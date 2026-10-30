#!/usr/bin/env node
// The credit-vault submission relay, as run by an Enclave host (role: network/host-services/credit-vault-submitter.mjs).
//   node network/credit-vault-submitter.mjs <config.json>
// The configuration is validated by the role (no secret, loopback signer only); the process refuses a DigitalOcean machine,
// verifies the optional reserve record against its pinned sha256, and serves cli/credit-vault.mjs's relay: exact bytes,
// agreed simulation, the operator's external signer pays gas, idempotent by digest. Prints one JSON line when listening.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateSubmitterConfig, digitalOceanRefusal } from './host-services/credit-vault-submitter.mjs';

export async function startSubmitter(rawConfig, { log = (m) => console.error(m), env = process.env, readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const c = validateSubmitterConfig(rawConfig);
  const refusal = digitalOceanRefusal({ readFile, ...(env.CVS_TEST_DMI ? { dmiDir: env.CVS_TEST_DMI, cloudCfg: path.join(env.CVS_TEST_DMI, 'cloud.cfg') } : {}) });
  if (refusal) throw new Error(`credit-vault-submitter: refusing to start: ${refusal}`);
  const CLI = await import('../cli/credit-vault.mjs');
  const CV = await import('../site/js/core/credit-vault-independent.js');
  const { createExternalSigner } = await import('../cli/independent-signer.mjs');
  const pins = CV.validatePins(c.pins || CV.PRODUCTION_PINS);
  if (pins.chainId !== c.chainId) throw new Error('credit-vault-submitter: pins are for another chain');
  if (c.reserveRecord) {
    const digest = 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(c.reserveRecord)).digest('hex');
    if (digest !== c.reserveRecordSha256) throw new Error(`credit-vault-submitter: the reserve record is ${digest}, not the reviewed ${c.reserveRecordSha256}`);
  }
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  const opts = { rpc: c.rpc, quorum: String(c.quorum), confirmations: String(c.confirmations), 'max-block-age': '600' };
  const reader = CLI.readerFor(opts, pins);
  const { QuorumChain } = await import('../cli/independent.mjs');
  const chain = new QuorumChain({ rpcs: c.rpc, quorum: c.quorum, confirmations: c.confirmations, chainId: c.chainId, maxBlockAgeMs: 600000 });
  const account = createExternalSigner({ url: c.signer, from: c.from, chainId: c.chainId, mode: 'sign', journalDir: path.join(c.stateDir, 'signer') });
  const submit = CLI.createRelay({ reader, chain, account, pins, reserveRecord: c.reserveRecord || null, maxFeeGwei: c.maxFeeGwei, log });
  const server = CLI.relayServer(submit, { perMinute: c.perMinute });
  await new Promise((ok, no) => { server.once('error', no); server.listen(c.port, c.bind, ok); });
  const url = `http://${c.bind.includes(':') ? `[${c.bind}]` : c.bind}:${server.address().port}`;
  log(`[credit-vault-submitter] listening on ${url}; gas paid by ${c.from} through the operator's signer; reserve requests ${c.reserveRecord ? 'enabled for ' + c.reserveRecord.reserve : 'off'}`);
  return { url, server, submit, stop: () => new Promise((ok) => server.close(() => ok())) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('usage: credit-vault-submitter.mjs <config.json>'); process.exit(2); }
  startSubmitter(JSON.parse(fs.readFileSync(file, 'utf8'))).then((s) => {
    console.log(JSON.stringify({ submitter: s.url }));
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { s.stop().then(() => process.exit(0)); });
  }, (e) => { console.error(e.message); process.exit(1); });
}

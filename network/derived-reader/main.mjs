#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startDerivedReader } from './provider.mjs';
import { serveDerivedReader } from './api.mjs';

export async function runDerivedReader(config, options = {}) {
  const reader = await startDerivedReader(config, options);
  let api;
  try { api = await serveDerivedReader(reader, { port: config.apiPort, maxWitnessBytes: config.maxWitnessBytes, operationTimeoutMs: config.nativeTimeoutMs }); }
  catch (e) { await reader.close(); throw e; }
  let closing;
  return { reader, port: api.port, close() { return closing ||= (async () => { await api.close(); await reader.close(); })(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || fs.statSync(process.argv[2]).size > 65536) throw Error('usage: node network/derived-reader/main.mjs CONFIG.json (maximum 64 KiB)');
  const runtime = await runDerivedReader(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
  const close = () => { runtime.close().catch(e => { console.error(e.message); process.exitCode = 1; }); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  console.log(JSON.stringify({ format: 'enclave-derived-reader-ready/v1', port: runtime.port,
    readyForWitness: true, hasDerivedAuthority: false, scope: 'local accepted domain only' }));
}

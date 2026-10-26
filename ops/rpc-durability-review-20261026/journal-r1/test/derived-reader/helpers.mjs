// Transport/composition fixtures only: this fake L1 process and native echo
// executable are NEVER evidence of consensus verification or native derivation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { keccak256, toBytes } from 'viem';
import { startL1Runtime } from '../../network/derived-reader/l1-runtime.mjs';
import { headerHash, outputRootV0 } from '../../network/derived-reader/vendor/anchor-bootstrap.mjs';
import { keccak } from '../../network/derived-reader/proof.mjs';
import { sha256File } from '../../network/derived-reader/process.mjs';
const hash = s => keccak256(toBytes(s));
export function header(number, timestamp) {
  const h = { parentHash: hash(`parent${number}`), sha3Uncles: hash('uncles'), miner: `0x${'11'.repeat(20)}`,
    stateRoot: hash(`state${number}`), transactionsRoot: hash('tx'), receiptsRoot: hash('receipts'), logsBloom: `0x${'00'.repeat(256)}`,
    difficulty: '0x0', number: `0x${number.toString(16)}`, gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: `0x${timestamp.toString(16)}`,
    extraData: '0x', mixHash: hash('mix'), nonce: '0x0000000000000000', baseFeePerGas: '0x1', withdrawalsRoot: hash(`message${number}`),
    blobGasUsed: '0x0', excessBlobGas: '0x0', parentBeaconBlockRoot: hash('beacon'), requestsHash: hash('requests') };
  h.hash = headerHash(h, keccak, { requireIsthmus: true }); return h;
}
export function anchorOf(h, l1, tier = 'l1-finalized-asr-anchor') {
  return { tier, base: { number: Number(BigInt(h.number)), hash: h.hash, stateRoot: h.stateRoot, messagePasserStorageRoot: h.withdrawalsRoot,
    timestamp: Number(BigInt(h.timestamp)), outputRoot: outputRootV0({ stateRoot: h.stateRoot, messagePasserStorageRoot: h.withdrawalsRoot, blockHash: h.hash }, keccak) }, l1 };
}
export async function setup(t, { stall = false, readyTimeoutMs = 3000 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-reader-test-'));
  const f = { directory, now: Date.now(), l1: null };
  t.after(async () => { await f.l1?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const seconds = Math.floor(f.now / 1000);
  f.head = { number: 10000, hash: hash('l1'), stateRoot: hash('l1state'), timestamp: seconds - 60 };
  f.l1Header = { ...f.head, number: '0x2710', timestamp: `0x${f.head.timestamp.toString(16)}` };
  const word = n => BigInt(n).toString(16).padStart(64, '0');
  f.schedule = `0x${word(32)}${word(15)}${Array.from({ length: 15 }, (_, i) => word(i < 13 ? 1686789347 : 0)).join('')}`;
  f.version = `0x${word((1n << 96n) | (5n << 64n) | (1n << 32n))}`;
  const values = path.join(directory, 'l1-fixture.json');
  f.save = () => fs.writeFileSync(values, JSON.stringify({ header: f.l1Header, schedule: f.schedule, version: f.version })); f.save();
  const script = path.join(directory, 'l1-fixture.mjs');
  fs.writeFileSync(script, `import http from 'node:http'; import fs from 'node:fs';
const [file,port]=process.argv.slice(2); http.createServer(async(q,s)=>{const a=[];for await(const c of q)a.push(c);
const b=JSON.parse(Buffer.concat(a)),v=JSON.parse(fs.readFileSync(file));
if (${stall}) return;
const result=b.method==='eth_chainId'?'0x1':b.method==='eth_getBlockByNumber'?v.header:b.method==='eth_call'?(b.params[0].data==='0xa2bf68b7'?v.schedule:v.version):null;
s.writeHead(200,{'content-type':'application/json'});s.end(JSON.stringify({jsonrpc:'2.0',id:b.id,result}));}).listen(Number(port),'127.0.0.1');`);
  // Derive selector from the actual source interface; avoid assuming a guessed ABI selector.
  const scheduleSelector = keccak256(toBytes('getSchedule()')).slice(0, 10);
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace('0xa2bf68b7', scheduleSelector));
  const checkpointFile = path.join(directory, 'checkpoint.json');
  const record = JSON.stringify({ format: 'enclave-l1-checkpoint/v1', network: 'mainnet', slot: Math.floor((seconds - 1606824023) / 12) - 64, root: hash('fixture checkpoint') });
  fs.writeFileSync(checkpointFile, record);
  const cp = createHash('sha256').update(record).digest('hex'), binaryHash = await sha256File(process.execPath);
  const runDir = path.join(directory, 'l1'); fs.mkdirSync(runDir);
  f.l1Config = { port, binary: { path: process.execPath, sha256: binaryHash }, checkpointFile,
    consensusUrl: 'http://127.0.0.1:1', executionUrl: 'http://127.0.0.1:2', readyTimeoutMs };
  f.l1Options = {
    runDir, now: () => f.now, acceptedBuilds: { [binaryHash]: 'transport fixture' }, acceptedCheckpoints: { [cp]: 'fixture' },
    buildArgs: ({ port }) => ['--max-old-space-size=64', script, values, String(port)],
  };
  f.l1 = await startL1Runtime(f.l1Config, f.l1Options);
  f.native = path.join(directory, 'echo-native'); fs.writeFileSync(f.native, '#!/bin/sh\nexec /bin/cat "$2"\n', { mode: 0o700 });
  f.agreed = anchorOf(header(100, seconds - 120), f.head); f.candidate = header(101, seconds - 2);
  return f;
}
export function nativeResult(ticket, h) {
  const t = ticket.trusted, base = anchorOf(h, {}).base;
  return { format: 'enclave-base-derivation-result/v2', chainId: 8453, l1Head: t.l1Head, l1HeadNumber: t.l1HeadNumber,
    agreedL2OutputRoot: t.agreedL2OutputRoot, l2PreBlockNumber: ticket.agreedL2BlockNumber,
    l2BlockNumber: t.claimedL2BlockNumber, l2OutputRoot: t.claimedL2OutputRoot, rollupConfigHash: t.expectedRollupConfigHash,
    scheduleId: t.expectedScheduleId, intermediateBlockInterval: t.intermediateBlockInterval,
    intermediateRoots: `0x${t.claimedL2OutputRoot.slice(2).repeat((t.claimedL2BlockNumber - ticket.agreedL2BlockNumber) / t.intermediateBlockInterval)}`, base };
}

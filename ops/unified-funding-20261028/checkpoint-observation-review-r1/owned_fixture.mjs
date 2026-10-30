// SOURCE ONLY. Not run. Synthetic data; no production imports, keys or RPC.
// Future harness launches this as its OWN child under the shared bounded queue.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const [dir, mode] = process.argv.slice(2);
const modes = new Set(['clean', 'swallowed-flush-failure', 'write-after-rename',
  'wrong-target', 'timer-rename-before-signal']);
if (process.env.ENCLAVE_CHECKPOINT_OWNED_FIXTURE !== '1' || !dir || !modes.has(mode))
  throw new Error('owned fixture opt-in, fresh directory and valid mode required');
if (!path.isAbsolute(dir) || fs.readdirSync(dir).length) throw new Error('fresh absolute directory required');
const file = path.join(dir, 'sessions-relayer.json');
const canary = 'SYNTHETIC_BUFFER_CANARY_NOT_A_SECRET_7f86';
const data = {txs: [{nonce: 1, status: 'sending', hashes: [], label: canary}]};
fs.writeFileSync(file, JSON.stringify({txs: []}), {mode: 0o600});
const flush = () => {
  if (mode === 'swallowed-flush-failure') throw new Error('synthetic flush failure');
  fs.writeFileSync(file + '.tmp', JSON.stringify(data), {mode: 0o600});
  fs.renameSync(file + '.tmp', mode === 'wrong-target' ? file + '.wrong' : file);
};
let readySent = false;
const server = http.createServer((req, res) => {
  req.on('end', () => {
    if (!readySent) {
      readySent = true;
      process.stdout.write(JSON.stringify({ready:true, pid:process.pid, mode}) + '\n');
    }
    // Deliberately never answer: synthetic request already delivered to RPC.
  });
  req.resume();
});
server.listen(0, '127.0.0.1', () => {
  const req = http.request({host: '127.0.0.1', port: server.address().port, method: 'POST'});
  req.on('error', () => {});
  req.end(canary); // synthetic pending RPC, corresponding record already in data
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    try { flush(); } catch {}
    if (mode === 'write-after-rename') {
      const late = http.request({host: '127.0.0.1', port: server.address().port, method:'POST'});
      late.on('error', () => {});
      late.end(canary);
      setTimeout(() => process.exit(0), 100);
    } else process.exit(0);
  });
  process.on('SIGUSR2', () => {
    if (mode !== 'timer-rename-before-signal') return;
    flush();
    // Owned harness triggers this only AFTER attach. It is deliberately not
    // shutdown: the earlier rename cannot establish final checkpoint freshness.
    data.txs.push({nonce:2, status:'sending', hashes:[], label:canary});
    process.stdout.write(JSON.stringify({preStopRename:true, pid:process.pid}) + '\n');
  });
});
setTimeout(() => process.exit(3), 20000).unref();

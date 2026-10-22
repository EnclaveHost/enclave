// The NORMAL network-agent reader, as a separate process: WalletAllowFile.refresh() (fs.openSync 'r' + readSync, exactly
// what the privacy agent does every second) in a tight loop for <ms>, to give a replace the most chances to collide.
//   node reader.mjs <wallet-admission module> <channel file> <runner> <ms>
// Prints one JSON line: {reads, fresh, errors: {<message>: n}}. Scratch files only; no network.
import { pathToFileURL } from 'node:url';
const [mod, file, runner, ms] = process.argv.slice(2);
const { WalletAllowFile } = await import(pathToFileURL(mod).href);
const f = new WalletAllowFile({ file, runner });
const end = Date.now() + Number(ms), errors = {};
let reads = 0, fresh = 0;
while (Date.now() < end) {
  const s = f.refresh(); reads++;
  if (s.fresh) fresh++; else { const k = String(s.error); errors[k] = (errors[k] || 0) + 1; }
}
process.stdout.write(JSON.stringify({ reads, fresh, errors }) + '\n');

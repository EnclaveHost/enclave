// The one field this release sets by hand in the NucBox network agent's configuration.
//
//   node set-near-routes.cjs <privacy-config.json> show|on|off
//
// on   puts "nearRoutes": true into the enclaveNetwork section directly after paceMbps, which is where the node's
//      enrollment pass writes it (windows/node/network-enroll.mjs, the `want` object): at any other place the next
//      pass would find the section different from its own, rewrite it and restart the agent once more.
// off  removes the field.
// show reads only.
//
// The file is written the way the node writes it (JSON.stringify(cfg, null, 2) to a temporary file, then a rename)
// and read back. Prints one line that starts SHOW, SAME, SET or STOP, and never a value of the configuration: field
// names only.
'use strict';
const fs = require('fs');
const [file, mode] = process.argv.slice(2);
const out = (s) => { console.log(s); process.exit(0); };
if (!file || !['show', 'on', 'off'].includes(mode)) out('STOP: usage: set-near-routes.cjs <privacy-config.json> show|on|off');
let text, cfg;
try { text = fs.readFileSync(file, 'utf8'); cfg = JSON.parse(text); } catch (e) { out(`STOP: the configuration cannot be read as JSON (${e.name}); nothing changed`); }
const n = cfg && cfg.enclaveNetwork;
if (!n || typeof n !== 'object' || Array.isArray(n)) out('STOP: the configuration has no enclaveNetwork section; nothing changed');
const keys = Object.keys(n), at = keys.indexOf('nearRoutes');
const state = at < 0 ? 'absent' : n.nearRoutes === true ? `true (after ${keys[at - 1] || 'nothing'})` : 'present but not true';
const own = text === JSON.stringify(cfg, null, 2);
if (mode === 'show') out(`SHOW nearRoutes ${state}; paceMbps ${keys.includes('paceMbps') ? 'present' : 'absent'}; file ${own ? 'in the form the node writes' : 'NOT in the form the node writes'}; apps ${Array.isArray(cfg.apps) ? cfg.apps.length : '?'}; enclaveNetwork fields: ${keys.join(',')}`);
if (mode === 'on') {
  if (!keys.includes('paceMbps')) out('STOP: enclaveNetwork has no paceMbps, so the place the node writes nearRoutes at is not the one this tool knows; nothing changed');
  if (n.nearRoutes === true && keys[at - 1] === 'paceMbps') out('SAME nearRoutes is already true');
  const next = {};
  for (const k of keys) { if (k === 'nearRoutes') continue; next[k] = n[k]; if (k === 'paceMbps') next.nearRoutes = true; }
  cfg.enclaveNetwork = next;
} else {
  if (at < 0) out('SAME nearRoutes is already absent');
  delete n.nearRoutes;
}
const tmp = `${file}.tmp-near-${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
} catch (e) { try { fs.unlinkSync(tmp); } catch {} out(`STOP: the configuration could not be written (${e.code || e.name})`); }
const back = JSON.parse(fs.readFileSync(file, 'utf8')).enclaveNetwork, bk = Object.keys(back);
const ok = mode === 'on' ? back.nearRoutes === true && bk[bk.indexOf('nearRoutes') - 1] === 'paceMbps' : !bk.includes('nearRoutes');
out(ok ? `SET ${mode}${own ? '' : ' (the file was not in the form the node writes; it is now)'}` : 'STOP: the configuration was written but does not read back as intended');

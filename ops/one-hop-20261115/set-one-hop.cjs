// The one field this release sets by hand in the NucBox network agent's configuration.
//
//   node set-one-hop.cjs <privacy-config.json> show
//   node set-one-hop.cjs <privacy-config.json> on <deployment id>
//   node set-one-hop.cjs <privacy-config.json> off
//
// on   puts "oneHop": ["<deployment id>"] into the enclaveNetwork section directly after nearRoutes when that field is
//      there, else directly after paceMbps, which is where the node's enrollment pass writes it
//      (windows/node/network-enroll.mjs, the `want` object): at any other place the next pass would find the section
//      different from its own, rewrite it and restart the agent once more. One app, never "all": the operator's
//      permission is for the app named, and a second app is a second deliberate change.
// off  removes the field.
// show reads only.
//
// The operator's field alone changes no circuit: an app gets circuits without a guard only when its owner has also
// signed enclaveNetwork.guard:false.
//
// The file is written the way the node writes it (JSON.stringify(cfg, null, 2) to a temporary file, then a rename)
// and read back. Prints one line that starts SHOW, SAME, SET or STOP. It prints field names, the number of apps the
// field names and the first ten characters of each (deployment ids are public), never another value.
'use strict';
const fs = require('fs');
const [file, mode, id] = process.argv.slice(2);
const out = (s) => { console.log(s); process.exit(0); };
const isId = (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v);
if (!file || !['show', 'on', 'off'].includes(mode) || (mode === 'on') !== !!id) out('STOP: usage: set-one-hop.cjs <privacy-config.json> show | on <deployment id> | off');
if (mode === 'on' && !isId(id)) out('STOP: the deployment id is not 0x and 64 lower-case hex digits; nothing changed');
let text, cfg;
try { text = fs.readFileSync(file, 'utf8'); cfg = JSON.parse(text); } catch (e) { out(`STOP: the configuration cannot be read as JSON (${e.name}); nothing changed`); }
const n = cfg && cfg.enclaveNetwork;
if (!n || typeof n !== 'object' || Array.isArray(n)) out('STOP: the configuration has no enclaveNetwork section; nothing changed');
const keys = Object.keys(n), at = keys.indexOf('oneHop');
// the field after which the node writes oneHop
const anchor = (ks) => (ks.includes('nearRoutes') ? 'nearRoutes' : 'paceMbps');
const names = (v) => (v === 'all' ? '"all"' : Array.isArray(v) && v.length && v.every(isId) ? `${v.length} app(s) ${v.map((x) => x.slice(0, 10)).join(' ')}` : 'present but NOT a value the agent accepts');
const state = at < 0 ? 'absent' : `${names(n.oneHop)} (after ${keys[at - 1] || 'nothing'})`;
const own = text === JSON.stringify(cfg, null, 2);
if (mode === 'show') out(`SHOW oneHop ${state}; nearRoutes ${n.nearRoutes === true ? 'true' : keys.includes('nearRoutes') ? 'present but not true' : 'absent'}; paceMbps ${keys.includes('paceMbps') ? 'present' : 'absent'}; file ${own ? 'in the form the node writes' : 'NOT in the form the node writes'}; apps ${Array.isArray(cfg.apps) ? cfg.apps.length : '?'}; enclaveNetwork fields: ${keys.join(' ')}`);
if (mode === 'on') {
  if (!keys.includes('paceMbps')) out('STOP: enclaveNetwork has no paceMbps, so the place the node writes oneHop at is not the one this tool knows; nothing changed');
  const a = anchor(keys);
  if (Array.isArray(n.oneHop) && n.oneHop.length === 1 && n.oneHop[0] === id && keys[at - 1] === a) out(`SAME oneHop already names ${id.slice(0, 10)}`);
  if (at >= 0) out(`STOP: oneHop is already in the configuration with another value or at another place (${state}); nothing changed. off removes it`);
  const next = {};
  for (const k of keys) { next[k] = n[k]; if (k === a) next.oneHop = [id]; }
  cfg.enclaveNetwork = next;
} else {
  if (at < 0) out('SAME oneHop is already absent');
  delete n.oneHop;
}
const tmp = `${file}.tmp-one-hop-${process.pid}`;
try {
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
} catch (e) { try { fs.unlinkSync(tmp); } catch {} out(`STOP: the configuration could not be written (${e.code || e.name})`); }
const back = JSON.parse(fs.readFileSync(file, 'utf8')).enclaveNetwork, bk = Object.keys(back);
const ok = mode === 'on'
  ? Array.isArray(back.oneHop) && back.oneHop.length === 1 && back.oneHop[0] === id && bk[bk.indexOf('oneHop') - 1] === anchor(bk)
  : !bk.includes('oneHop');
out(ok ? `SET ${mode}${mode === 'on' ? ` ${id.slice(0, 10)} (after ${anchor(bk)})` : ''}${own ? '' : ' (the file was not in the form the node writes; it is now)'}` : 'STOP: the configuration was written but does not read back as intended');

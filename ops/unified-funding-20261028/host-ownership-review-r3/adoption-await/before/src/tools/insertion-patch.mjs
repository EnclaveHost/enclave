// Generic strict insertion patch (r3), the same discipline as generate-lifecycle-host-candidate.mjs: an exact SHA-256
// pinned input, edits { name, before, after, text } whose `before + after` anchor occurs EXACTLY once, text inserted
// between them, insertions only. Anchors may overlap (two insertions on one line); insertion points may not coincide.
// The result is self-proved: removing the insertions restores the input byte for byte. Never writes the input, never
// overwrites an output. Double application is refused by the required `marker` (absent from the input, present in the
// output); every insertion of 16+ characters must also be absent from the input (short ones, e.g. a closing
// parenthesis, cannot be unique and are covered by the marker).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = s => createHash('sha256').update(s).digest('hex');
const count = (s, sub) => { let n = 0; for (let i = s.indexOf(sub); i >= 0; i = s.indexOf(sub, i + 1)) n++; return n; };

/** (input, { expectedSha256, edits, marker, what }) -> { source, sha256, baselineSha256, manifest }. Pure. */
export function applyInsertions(input, { expectedSha256, edits, marker, what }) {
  if (typeof input !== 'string') throw Error(`${what}: source text required`);
  if (typeof marker !== 'string' || marker.length < 8) throw Error(`${what}: a patch marker is required`);
  const got = sha256(input);
  if (got !== expectedSha256) throw Error(`${what} hash ${got} is not the pinned ${expectedSha256}`);
  if (input.includes(marker)) throw Error(`${what} already carries this patch`);
  const names = new Set();
  const placed = edits.map(e => {
    if (!e.name || names.has(e.name)) throw Error(`edit name missing or duplicate: ${e.name}`);
    names.add(e.name);
    if (!e.before || typeof e.after !== 'string' || !e.after || !e.text) throw Error(`edit ${e.name} is incomplete`);
    const anchor = e.before + e.after, n = count(input, anchor);
    if (n !== 1) throw Error(`edit ${e.name}: anchor ${n === 0 ? 'missing' : `duplicated (${n})`}`);
    if (e.text.length >= 16 && count(input, e.text)) throw Error(`edit ${e.name}: insertion already present`);
    return { ...e, at: input.indexOf(anchor) + e.before.length };
  }).sort((a, b) => a.at - b.at);
  for (let i = 1; i < placed.length; i++) if (placed[i].at === placed[i - 1].at) throw Error(`edits ${placed[i - 1].name} and ${placed[i].name} insert at one point`);
  let out = '', cursor = 0;
  const manifest = [];
  for (const e of placed) {
    out += input.slice(cursor, e.at);
    manifest.push({ name: e.name, baselineLine: input.slice(0, e.at).split('\n').length, candidateOffset: out.length, length: e.text.length });
    out += e.text; cursor = e.at;
  }
  out += input.slice(cursor);
  let restored = '', from = 0;
  for (const m of manifest) { restored += out.slice(from, m.candidateOffset); from = m.candidateOffset + m.length; }
  restored += out.slice(from);
  if (restored !== input || sha256(restored) !== expectedSha256) throw Error(`${what}: candidate does not preserve the input`);
  if (!out.includes(marker)) throw Error(`${what}: candidate lacks its marker`);
  return { source: out, sha256: sha256(out), baselineSha256: got, manifest };
}

/** Write a candidate outside the input's directory; never overwrite. -> { output, sha256, baselineSha256, manifest } */
export function writeInsertions(inputFile, outputFile, generate, expectedSha256) {
  if (!path.isAbsolute(inputFile) || !path.isAbsolute(outputFile)) throw Error('absolute input and output paths required');
  const real = fs.realpathSync(inputFile);
  const outDir = fs.realpathSync(path.dirname(outputFile));
  const outReal = path.join(outDir, path.basename(outputFile));
  if (outReal === real || outDir === path.dirname(real)) throw Error('the candidate must be written outside the input directory');
  const r = generate(fs.readFileSync(real, 'utf8'));
  fs.writeFileSync(outReal, r.source, { flag: 'wx', mode: 0o644 });
  if (sha256(fs.readFileSync(real, 'utf8')) !== expectedSha256) throw Error('input changed during generation');
  return { output: outReal, sha256: r.sha256, baselineSha256: r.baselineSha256, manifest: r.manifest };
}

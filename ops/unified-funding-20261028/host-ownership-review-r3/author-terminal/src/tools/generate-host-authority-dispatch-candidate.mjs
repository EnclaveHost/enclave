// host-authority completion r2 + ownership r3 strict hash-pinned ADDITIVE generator (SOURCE ONLY) over root r3's CORRECTED generated dispatch
// (lifecycle-host-dispatch.mjs 9a155041 = root author-snapshot host generator 7073e59c output; explicit-only default, serialized adoption,
// pending/nonfinal refusal, confirmed runtime stop + independent inventory absence, fresh pre/post authority, local-owner epochs). Root's
// generator is never re-run on its own output; this is ONE separate stage over that exact input. Insertions only; restoration self-proof.
// Every insertion is guarded by HR (exact independent-host-registry-r1 binding); old profiles keep their exact behavior.
//
//  - adoption: AFTER root's checks, under the SAME final fresh read and still inside the serialized adoption, the v2 runtime/gate handoff
//    (runtime.adoptHostAuthority). ownership r3: AFTER that await, a NEW independently qualified canonical read (freshDecision) plus local
//    epochs/holds, pending/nonfinal refusal and confirmed absence; the exact named generation/digest and the owner/revision/policy of the
//    pre-quiescence decision must still hold. Any change (owner/revision/policy, Offline, recovery, unknown) REVOKES the runtime/gate handoff
//    (binding removed, newer authority observed) and aborts BEFORE the durable incarnation binding: no stale intermediate grant remains;
//  - forward progress after the confirmed stop: binding with requeue=true denies the app here, so the actual runner fences, confirms stop and
//    records an authorized queued transition (existing revocation path; no ended evidence invented, no financial state cleared). Once the
//    authenticated assignment is no longer running and no old work can exist, requeue clears and the normal fresh queued start proceeds;
//  - durable host-wide Offline: an incarnation floor recorded Offline refuses every serve/start on this host;
//  - v2 only: independent-host-registry-r1 never serves through a runtime that is not the v2 host-authority permit runtime.
//
//   node generate-host-authority-dispatch-candidate.mjs <abs dir holding the exact root r3 dispatch> <abs output dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInsertions, sha256 } from
  '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/host-registry-repair-root-review-r3/src/tools/insertion-patch.mjs';

export const MARKER = 'host-authority completion r2';
export const DISPATCH_SHA256 = '9a155041a4a38402288bd36741fe708480e55d60675a99a731a58d13d6f84778';
const F = 'lifecycle-host-dispatch.mjs';

export const DISPATCH_EDITS = Object.freeze([
  { name: 'state', before: '    return { floor: r?.floor ?? null, genesis: r?.genesis ?? null, bound: r?.bound ?? {} };\n  };\n', after: '  const oldWork = id =>',
    text: '  const freshSnapshots = new Map();   // host-authority completion r2: the authenticated snapshot behind each freshDecision\n' +
      '  const requeuePending = id => { try { return incarnation().bound[id]?.requeue === true; } catch { return true; } };\n' },
  { name: 'fresh-capture', before: '      throw Error(`${what}: no verified snapshot of this route`);\n', after: '    return checkDecision(id, await authority.decision(id, s));',
    text: '    freshSnapshots.set(id, s);   // host-authority completion r2\n' },
  { name: 'bind-param', before: '  function bindIncarnation(id, d, why', after: ') {\n    const x = d.hostIncarnation;', text: ', requeue = false' },
  { name: 'bind-early', before: '    if (incarnation().bound[id]?.digest === x.digest', after: ') return;\n    journal.bindHostIncarnation(',
    text: ' && (incarnation().bound[id]?.requeue === true) === requeue' },
  { name: 'bind-requeue', before: '    journal.bindHostIncarnation(host.hostId, id, { generation: x.generation, digest: x.digest, reason: why, at: now()', after: ' });\n  }\n  function incarnationGate',
    text: ', requeue' },
  { name: 'offline-floor', before: '      if (!st.floor || st.floor.digest !== x.digest || st.floor.generation !== x.generation) return `host incarnation ${x.generation} is not the durable accepted floor`;\n',
    after: '      if (b && b.digest === x.digest) return null;',
    text: '      if (st.floor.offline) return `canonical host recorded Offline at generation ${st.floor.offline.generation}: no serving or start until a newer qualified generation`;   // host-authority completion r2\n' },
  { name: 'requeue-denial', before: '    if (local) return `restricted: ${local}`;\n', after: '    const owner = host.ownerRestriction();',
    text: "    if (HR && requeuePending(id)) return 'explicitly adopted app context: its stopped runtime settles through an authorized queued transition before any fresh start';   // host-authority completion r2\n" },
  { name: 'requeue-clear', before: ' if (HR) ctx.unknown = incarnationGate(id, ctx.decision);', after: ' }\n        catch (e) { ctx.decision = null;',
    text: " if (HR && !ctx.unknown && s.assignment?.state !== 'running' && !oldWork(id) && requeuePending(id)) bindIncarnation(id, ctx.decision, 'requeued after explicit adoption: assignment no longer running', false);" },
  { name: 'serve-v2', before: '      async serve(id, snapshot) { const why = serveRefusal(id);', after: ' if (why) throw Error(`lifecycle serving refused: ${why}`);',
    text: " if (HR && runtime?.hostAuthorityPermit !== true) throw Error('lifecycle serving refused: independent-host-registry-r1 serves only through the v2 host-authority permit runtime');" },
  { name: 'adopt-handoff', before: "        if (!st.floor || st.floor.digest !== digest) throw Error('named incarnation is not the durable current floor');\n",
    after: "        bindIncarnation(id, current, 'explicit owner adoption",
    text: `        // host-authority completion r2: the v2 runtime/gate handoff under THIS adoption's final fresh read, still serialized
        if (runtime?.hostAuthorityPermit === true) {
          await runtime.adoptHostAuthority(id, freshSnapshots.get(id));
          // ownership r3: the await above can span a canonical owner change, Offline or recovery. Re-read independently NOW, before binding.
          let post = null, postWhy = null;
          try { post = await freshDecision(id, 'adoption post-handoff read refused'); } catch (e) { postWhy = msg(e); }
          if (!postWhy) try { stableLocal(); } catch (e) { postWhy = msg(e); }
          if (!postWhy) try { if (await inventory.findByName(id)) postWhy = 'old runtime reappeared during the handoff'; } catch (e) { postWhy = \`inventory unknown: \${msg(e)}\`; }
          if (!postWhy) { const z = post.hostIncarnation;
            postWhy = denial(id, post) ?? (z.status !== 'online' || z.generation !== generation || z.digest !== digest || post.owner !== d.owner ||
              post.revision !== d.revision || post.policyHash !== d.policyHash ? 'canonical host/owner authority changed during the runtime handoff' : null); }
          if (postWhy) {
            try { await runtime.revokeHostAuthority?.(id, freshSnapshots.get(id)); } catch (e) { say(\`\${id.slice(0, 10)} handoff revocation failed (gate stays fenced): \${msg(e)}\`); }
            throw Error(\`adoption aborted after the runtime handoff: \${postWhy}\`);
          }
        }
` },
  { name: 'adopt-requeue', before: "        bindIncarnation(id, current, 'explicit owner adoption after confirmed runtime quiescence'", after: ');\n        say(', text: ', true' },
]);

/** exact root r3 dispatch text -> { source, sha256, baselineSha256, manifest }. Pure; self-proves restoration. */
export function generateHostAuthorityDispatch(input) {
  return applyInsertions(input, { expectedSha256: DISPATCH_SHA256, edits: DISPATCH_EDITS, marker: MARKER, what: F });
}

export function writeHostAuthorityDispatch(inputDir, outputDir) {
  if (!path.isAbsolute(inputDir) || !path.isAbsolute(outputDir)) throw Error('absolute input and output directories required');
  const inReal = fs.realpathSync(inputDir), outReal = fs.realpathSync(outputDir);
  if (inReal === outReal) throw Error('the candidate must be written outside the input directory');
  const r = generateHostAuthorityDispatch(fs.readFileSync(path.join(inReal, F), 'utf8'));
  fs.writeFileSync(path.join(outReal, F), r.source, { flag: 'wx', mode: 0o644 });
  if (sha256(fs.readFileSync(path.join(inReal, F), 'utf8')) !== DISPATCH_SHA256) throw Error('dispatch input changed during generation');
  return { [F]: { sha256: r.sha256, baselineSha256: r.baselineSha256, manifest: r.manifest } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: generate-host-authority-dispatch-candidate.mjs <dir with root r3 dispatch> <output dir>'); process.exit(2); }
  console.log(JSON.stringify(writeHostAuthorityDispatch(input, output), null, 1));
}

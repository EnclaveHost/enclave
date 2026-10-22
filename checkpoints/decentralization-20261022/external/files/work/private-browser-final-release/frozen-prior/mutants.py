#!/usr/bin/env python3
"""Mutation check for the private-browser-access candidate. Each mutant is ONE exact-string replacement (the original
must occur exactly once) in a scratch copy of the touched file inside a scratch tree (mut/tree: the candidate with real
node_modules hard-linked); test/private-app-frontends.test.mjs must then FAIL (killed).
Usage: mutants.py [ID ...]   (inside one shared-queue allocation; appends to mut/results.txt)."""
import os, shutil, subprocess, sys, time

C = os.path.dirname(os.path.abspath(__file__))
TREE, MUT = os.path.join(C, 'tree'), os.path.join(C, 'mut', 'tree')
TEST = 'test/private-app-frontends.test.mjs'
M = [
 ('P1_handoff_query_unchecked', 'supervisor.js', 'if (q !== "d=" + rec.id)', 'if (false && q !== "d=" + rec.id)'),
 ('P2_handoff_scope_dropped', 'supervisor.js', 'body: Buffer.alloc(0), scope: "api.appAccess", fresh: true });', 'body: Buffer.alloc(0), scope: null, fresh: true });'),
 ('P3_handoff_record_rule_skipped', 'supervisor.js', '          why = await sessionApi.refusal(s, rec, { fresh: true });\n', '          why = null;\n'),
 ('P4_handoff_cached_chain', 'supervisor.js', 'body: Buffer.alloc(0), scope: "api.appAccess", fresh: true });\n          why = await sessionApi.refusal(s, rec, { fresh: true });',
                                              'body: Buffer.alloc(0), scope: "api.appAccess", fresh: false });\n          why = await sessionApi.refusal(s, rec, { fresh: false });'),
 ('P5_handoff_path_unbound', 'supervisor.js', 'path: `/x/${rec.id}${req.url}`,', 'path: req.url,'),
 ('P6_bounce_ignores_owner_choice', 'supervisor.js', '  if (owned.length) {\n    const urls', '  if (false) {\n    const urls'),
 ('P7_access_duplicates_accepted', 'supervisor.js', '  if (new Set(f).size !== f.length) throw new Error("access.frontends lists an origin twice");\n', ''),
 ('P8_access_paths_accepted', 'supervisor.js', "  const m = /^(https?):\\/\\/(\\[::1\\]|[^/:?#@[\\]]+)(?::([1-9][0-9]{0,4}))?$/.exec(x);", "  const m = /^(https?):\\/\\/(\\[::1\\]|[^/:?#@[\\]]+)(?::([1-9][0-9]{0,4}))?(?:\\/.*)?$/.exec(x);"),
 ('P9_access_not_applied_live', 'supervisor.js', '  if (o.access) rec.access = o.access; else delete rec.access;\n', ''),
 ('P10_live_edit_skips_live_options', 'supervisor.js', '  const o = parseDepOptions(cur);                  // waf/restart: the verdict already parsed it clean\n  applyLiveOptions(rec, o);\n', '  const o = parseDepOptions(cur);                  // waf/restart: the verdict already parsed it clean\n'),
 ('F1_frontend_policy_skipped', 'site/js/core/app-access.js', '  if (!pol || pol.admit !== true)', '  if (false)'),
 ('F2_frontend_owner_skipped', 'site/js/core/app-access.js', '  if (lease.owner !== who && lease.owner !== vault)', '  if (false)'),
 ('F3_frontend_enclave_names_allowed', 'site/js/core/app-access.js', '  if (ENCLAVE_NAMES.test(u.hostname))', '  if (false)'),
 ('F4_frontend_registry_unchecked', 'site/js/core/app-access.js', '  if (!lr.current || !lr.host)', '  if (!lr.host)'),
 ('F5_frontend_unsigned_check_skipped', 'site/js/core/app-access.js', '  try { await D.checkAuthorization(authorization, { method: "POST", hostPath: target.hostPath, body: empty }); }', '  try { }'),
 ('F6_frontend_merge_drops_namespaces', 'site/js/core/app-access.js', '  if (list.length) e.access = { frontends: list }; else delete e.access;', '  for (const k of Object.keys(e)) delete e[k]; if (list.length) e.access = { frontends: list };'),
]

def fresh_tree():
    if os.path.isdir(MUT): return
    os.makedirs(os.path.dirname(MUT), exist_ok=True)
    # a scratch copy whose node_modules are the candidate's own (hard links: no extra bytes, same files)
    subprocess.run(['cp', '-al', TREE, MUT], check=True)

def main():
    want = set(sys.argv[1:])
    fresh_tree()
    out = open(os.path.join(C, 'mut', 'results.txt'), 'a')
    for mid, rel, old, new in M:
        if want and mid not in want: continue
        dst = os.path.join(MUT, rel)
        os.unlink(dst); shutil.copyfile(os.path.join(TREE, rel), dst)        # break the hard link before writing
        s = open(dst).read()
        if s.count(old) != 1:
            line = f'{mid}: INVALID (original occurs {s.count(old)} times)'
        else:
            open(dst, 'w').write(s.replace(old, new))
            t0 = time.time()
            p = subprocess.run(['taskset', '-c', '0-3', 'node', '--test', '--test-concurrency=1', TEST], cwd=MUT, capture_output=True, text=True)
            log = p.stdout + p.stderr
            open(os.path.join(C, 'mut', mid + '.log'), 'w').write(log)
            fails = [l.split(' - ', 1)[1][:70] for l in log.splitlines() if l.startswith('not ok ')]
            verdict = 'KILLED' if p.returncode != 0 and fails else ('SURVIVED' if p.returncode == 0 else f'ERROR rc={p.returncode}')
            line = f'{mid}: {verdict} ({time.time() - t0:.0f}s) by {" | ".join(fails) or "-"}'
        os.unlink(dst); shutil.copyfile(os.path.join(TREE, rel), dst)        # restore the candidate's bytes
        print(line, flush=True); out.write(line + '\n'); out.flush()

if __name__ == '__main__':
    main()

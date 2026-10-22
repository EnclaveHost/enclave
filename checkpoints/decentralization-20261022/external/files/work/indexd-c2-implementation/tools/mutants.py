#!/usr/bin/env python3
"""G-C2 mutation check. Each mutant is ONE exact-string replacement (the original must occur exactly once) in a
scratch copy of src (mut/src, refreshed from src for every mutant); the named tests must then FAIL (killed).
Usage: mutants.py [ID ...]   (run inside one shared-queue allocation; writes mut/results.txt)."""
import os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, MUT = os.path.join(ROOT, 'src'), os.path.join(ROOT, 'mut', 'src')
RUN = os.path.join(ROOT, 'tools', 'c2-gotest.sh')
PG, APP = './persist/postgres/', './api/app/'

M = [
 ('C1_mode_check_removed', 'persist/postgres/fence.go',
  'if la.casMode && cas == nil {', 'if false && la.casMode && cas == nil {', PG, 'TestC2EnrolledRefusesV3OnEveryRoute|TestC2RaiseModeSticky'),
 ('C2_replay_ignores_digest', 'persist/postgres/fence.go',
  'if subtle.ConstantTimeCompare(la.lastOpDigest, cas.Digest[:]) == 1 {', 'if true {', PG, 'TestC2AlteredReplayRefused'),
 ('C3_replay_ignores_op', 'persist/postgres/fence.go',
  'case head == cas.Sq+1 && la.lastOp != nil && subtle.ConstantTimeCompare(la.lastOp, cas.Op[:]) == 1:',
  'case head == cas.Sq+1 && la.lastOp != nil:', PG, 'TestC2IdenticalReplay|TestC2AlteredReplay|TestC2ConcurrentSameHead|TestC2CASConflict'),
 ('C4_head_ge_instead_of_eq', 'persist/postgres/fence.go',
  'case head == cas.Sq:\n\t\tla.cas = cas', 'case head <= cas.Sq:\n\t\tla.cas = cas', PG, 'TestC2CASConflictHasNoSideEffects'),
 ('C5_raise_keeps_last_op', 'persist/postgres/fence.go',
  'last_op = NULL, last_op_digest = NULL, cas_mode', 'cas_mode', PG, 'TestC2RaiseModeStickyAndClearsLastOp'),
 ('C6_downgrade_allowed', 'persist/postgres/fence.go',
  'if casMode && mode != accounts.ModeCAS {', 'if false && casMode && mode != accounts.ModeCAS {', PG, 'TestC2RaiseModeStickyAndClearsLastOp'),
 ('C7_op_not_recorded', 'persist/postgres/fence.go',
  'UPDATE accounts SET event_seq = event_seq + 1, last_op = $2, last_op_digest = $3 WHERE id = $1 RETURNING event_seq`,\n\t\t\tla.id, la.cas.Op[:], la.cas.Digest[:])',
  'UPDATE accounts SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`,\n\t\t\tla.id)', PG, 'TestC2IdenticalReplayAppliesOnce|TestC2CASApplyAndRecord'),
 ('C8_nonadvancing_precondition_removed', 'persist/postgres/fence.go',
  'if !advancing && cas != nil && cas.HasSq {', 'if false && !advancing && cas != nil && cas.HasSq {', PG, 'TestC2EnrolledRefusesV3OnEveryRoute'),
 ('C9_advancing_without_sq_allowed', 'persist/postgres/fence.go',
  'if cas != nil && !cas.HasSq {\n\t\treturn lockedAccount{}, false, accounts.ErrCASSeqRequired', 'if false && cas != nil && !cas.HasSq {\n\t\treturn lockedAccount{}, false, accounts.ErrCASSeqRequired', PG, 'TestC2EnrolledRefusesV3OnEveryRoute'),
 ('C10_digest_omits_body', 'api/app/auth.go',
  '\th.E.Write(cas.Op[:])\n\th.E.WriteBytes(body)\n\treturn accounts.OpDigest(h.Sum())', '\th.E.Write(cas.Op[:])\n\treturn accounts.OpDigest(h.Sum())', APP, 'TestC2HashVectors|TestC2APIReplayAndConflicts'),
 ('C11_digest_omits_credential', 'api/app/auth.go',
  '\th.E.WriteString(accounts.OpDigestDomain)\n\th.E.WriteString(method)\n\th.E.WriteString(hostname)\n\th.E.WriteString(path)\n\tcred := sf.Bytes()\n\th.E.Write(cred[:])',
  '\th.E.WriteString(accounts.OpDigestDomain)\n\th.E.WriteString(method)\n\th.E.WriteString(hostname)\n\th.E.WriteString(path)', APP, 'TestC2HashVectors'),
 ('C12_v4_hash_omits_sq', 'api/app/auth.go',
  '\th.E.WriteUint64(uint64(validUntil.Unix()))\n\tcred := sf.Bytes()\n\th.E.Write(cred[:])\n\th.E.WriteUint64(cas.Flags())\n\th.E.WriteUint64(cas.Sq)',
  '\th.E.WriteUint64(uint64(validUntil.Unix()))\n\tcred := sf.Bytes()\n\th.E.Write(cred[:])\n\th.E.WriteUint64(cas.Flags())', APP, 'TestC2HashVectors|TestC2APIRequestForm'),
 ('C13_v4_params_unsigned', 'api/app/auth.go',
  'if sf != nil && cas != nil {\n\t\thash = v4RequestHash', 'if false && sf != nil && cas != nil {\n\t\thash = v4RequestHash', APP, 'TestC2APIRequestForm'),
 ('C14_duplicate_op_accepted', 'api/app/auth.go',
  'case len(ops) != 1:', 'case len(ops) == 0:', APP, 'TestC2APIRequestForm'),
 ('C15_conflict_as_409', 'api/app/fence.go',
  'writeJSONStatus(jc, http.StatusPreconditionFailed, r)', 'writeJSONStatus(jc, http.StatusConflict, r)', APP, 'TestC2APIReplayAndConflicts|TestC2APIEnrolAndState'),
 ('C16_sq_noncanonical_accepted', 'accounts/cas.go',
  "if s == \"\" || len(s) > 19 || (len(s) > 1 && s[0] == '0') {", 'if s == "" || len(s) > 19 {', APP, 'TestC2APIRequestForm'),
 ('C17_down_migration_unguarded', '../migration/down-28-to-27.sql',
  "  IF EXISTS (SELECT 1 FROM accounts WHERE cas_mode)\n", "  IF FALSE AND EXISTS (SELECT 1 FROM accounts WHERE cas_mode)\n", PG, 'TestC2DownMigration'),
 ('C19_op_nonce_constant', 'api/app/fence.go',
  'if _, err := rand.Read(nonce[:]); err != nil {', 'if _, err := rand.Read(nonce[:0]); err != nil {', APP, 'TestC2APIClonedInvocations'),
 ('C20_fence_answer_cacheable', 'api/app/fence.go',
  'jc.ResponseWriter.Header().Set("Cache-Control", "no-store")', '', APP, 'TestC2APIClonedInvocations'),
 ('C18_replay_reapplies', 'persist/postgres/fence.go',
  'cas.Result.Seq, cas.Result.Replayed = head, true\n\t\t\treturn la, true, nil', 'la.cas = cas\n\t\t\treturn la, false, nil', PG, 'TestC2IdenticalReplayAppliesOnce|TestC2ConcurrentSameHead'),
]

def main():
    want = set(sys.argv[1:])
    out = open(os.path.join(ROOT, 'mut', 'results.txt'), 'a')
    for mid, rel, old, new, pkg, run in M:
        if want and mid not in want:
            continue
        subprocess.run(['rsync', '-a', '--delete', SRC + '/', MUT + '/'], check=True)
        mig = os.path.join(ROOT, 'mut', 'migration')
        subprocess.run(['rsync', '-a', '--delete', os.path.join(ROOT, 'migration') + '/', mig + '/'], check=True)
        path = os.path.join(MUT, rel) if not rel.startswith('../') else os.path.join(ROOT, 'mut', rel[3:])
        s = open(path).read()
        if s.count(old) != 1:
            line = f'{mid}: INVALID (original occurs {s.count(old)} times)'
        else:
            open(path, 'w').write(s.replace(old, new))
            t0 = time.time()
            p = subprocess.run([RUN, pkg, '-count=1', '-run', run, '-timeout', '600s'], env=dict(os.environ, C2_TREE=MUT),
                               capture_output=True, text=True)
            log = p.stdout + p.stderr
            open(os.path.join(ROOT, 'mut', mid + '.log'), 'w').write(log)
            if 'build failed' in log or '[setup failed]' in log:
                verdict = 'BUILD-FAILED'
            elif p.returncode != 0 and '--- FAIL' in log:
                verdict = 'KILLED'
            elif p.returncode == 0:
                verdict = 'SURVIVED'
            else:
                verdict = f'ERROR rc={p.returncode}'
            fails = sorted({l.split()[2] for l in log.splitlines() if l.startswith('--- FAIL')})
            line = f'{mid}: {verdict} ({time.time() - t0:.0f}s) by {",".join(fails) or "-"}'
        print(line, flush=True)
        out.write(line + '\n')
        out.flush()

if __name__ == '__main__':
    main()

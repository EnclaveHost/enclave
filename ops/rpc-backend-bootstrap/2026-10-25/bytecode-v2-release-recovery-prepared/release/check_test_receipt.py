#!/usr/bin/env python3
"""check_test_receipt.py OUT RC GUARD STAGE: exit 0 only if root's v2 RECOVERY test job (bytecode-v2-recovery/jobs/
root-build-test-recovery.sh) is a COMPLETE pass. Formats as in root's logs (claude-test-queue.py + memory guard):
  - the RECOVERY job ran: the precheck header and the recovery patched-step label are present, and the run is NOT the original
    failed attempt (2249: out sha 2a5aca4e..., rc 143, queue EXIT -15) - an original receipt is never substituted;
  - the final '## ' line is the single '## aggregate rc=0'; no INVALID / failed / abnormal / missing / refused marker;
  - exactly one 'test result: ok. 23 passed; 0 failed'; each of the 23 pinned names 'ok' exactly once;
  - each of the 17 controls 'rc=101 failing: <EXACT pinned set>' (from STAGE/control/disable_check.py via runpy: no bytecode
    written) + 'failed exactly as expected'; pinned names/control order equal the recovery job's own lists;
  - the closure line (pinned lock, problems=0) and 'compiled graph ... inside the verified closure of 648';
  - one '[queue] EXIT 0' as the last queue record; the outer rc file is '0'; the guard log ends '[memory-guard] exit=0'.
Prints one JSON line {ok, failures, patchedTestBinarySha256, ...}; exit 0 only if ok."""
import hashlib, json, re, runpy, sys
TESTS = sorted('''client_cross_check_independently_refuses_harmful_rows client_panics_exactly_where_the_checker_predicts
client_written_rows_are_canonical_and_agree completeness_counts_missing_code_and_ignores_empty digests_change_with_one_row_one_byte_or_one_reference
extra_table_bytes_and_bits_past_bit_len_are_non_canonical_not_failures forged_jump_bits_are_executed_by_the_client
framed_digest_is_stable_and_length_and_count_framed mdbx_scan_end_to_end_reports_failures_missing_code_and_is_read_only
missing_code_bad_row_and_empty_accounts_are_not_ok missing_or_partial_checkpoints_are_not_ok mutation_between_scans_changes_txn_id_entries_and_digests
nonzero_padding_is_executed_by_the_client padding_shorter_than_revm42_is_refused_and_dupn_is_classified
pseudo_random_client_rows_pass_and_every_read_jump_bit_flip_fails raw_tag0_rows_follow_new_raw read_errors_and_absent_databases_are_never_ok
report_ok_requires_every_v2_binding rows_the_client_misreads_silently_are_refused size_key_and_length_guards v2_json_has_exactly_the_a2_schema
v2_scan_leaves_every_byte_of_mdbx_dat_unchanged v2_scan_valid_fixture_is_ok_with_exact_counts_digests_and_checkpoints'''.split())
CONTROLS = ['jumpbit', 'padding', 'client', 'completeness', 'eip7702', 'entries', 'accounts', 'codele', 'withcode', 'txnid', 'checkpoints',
            'datadir', 'rowsdigest', 'refsdigest', 'framing', 'count', 'scanned']
LOCK_SHA = '91a9e7626b5f361faed8f5226268ffae177970575e8ecd243d09cb077bd23bab'
ORIGINAL_FAILED_OUT_SHA = '2a5aca4eb8e366723f7e7f532906b97dff8ef9f217a03df321fe264744cf50ce'   # root-bytecode-v2-native-2249.out (OOM, 143)
RECOVERY_LABEL = '## [1] patched (RECOVERY: product lib.rs/main.rs/Cargo.toml unchanged; fixture-only tests.rs f1bd5c1c): build + run all tests'
PRECHECK_LINES = ('== original v2 stage (read-only) and its failure', '== recovery inputs == original (product unchanged)', '## recovery precheck rc=0')
JOB = 'jobs/root-build-test-recovery.sh'
BAD = ('## INVALID', 'DID NOT FAIL', 'abnormal output', 'test missing or not ok', '## patched FAILED', 'precheck refused', '[REFUSE]')


def check(out_p, rc_p, guard_p, stage):
    fail = []
    raw = open(out_p, 'rb').read()
    out = raw.decode('utf-8', errors='replace'); lines = out.splitlines()
    if hashlib.sha256(raw).hexdigest() == ORIGINAL_FAILED_OUT_SHA:
        fail.append('this is the ORIGINAL failed attempt 2249 (OOM, rc 143): never substituted for the recovery run')
    want = runpy.run_path(f'{stage}/control/disable_check.py', run_name='receipt_check')['CONTROLS']
    if sorted(want) != sorted(CONTROLS) or len(TESTS) != 23:
        fail.append('pinned test/control lists differ from the stage control file')
    job = open(f'{stage}/{JOB}').read()
    m = re.search(r'TESTS="(.*?)"', job, re.S)
    if not m or sorted(m.group(1).replace('\\', ' ').split()) != TESTS:
        fail.append('pinned test names differ from the recovery job TESTS list')
    if ('for c in ' + ' '.join(CONTROLS) + '; do') not in job:
        fail.append('pinned control order differs from the recovery job loop')
    if lines.count(RECOVERY_LABEL) != 1 or any(lines.count(x) != 1 for x in PRECHECK_LINES):
        fail.append('not a passing recovery job output (recovery label / precheck lines missing or repeated)')
    hashes = [l for l in lines if l.startswith('## ')]
    if not hashes or hashes[-1] != '## aggregate rc=0' or sum(l.startswith('## aggregate rc=') for l in lines) != 1:
        fail.append('the final job line is not the single "## aggregate rc=0"')
    for b in BAD:
        if b in out:
            fail.append(f'bad marker present: {b}')
    if sum(1 for l in lines if l.startswith('test result: ')) != 1 or not any(l.startswith('test result: ok. 23 passed; 0 failed;') for l in lines):
        fail.append('the patched run is not exactly one "test result: ok. 23 passed; 0 failed"')
    if any(re.match(r'^test tests::\S+ \.\.\. (?!ok$)', l) for l in lines):
        fail.append('a patched test line is not "ok"')
    for t in TESTS:
        if lines.count(f'test tests::{t} ... ok') != 1:
            fail.append(f'test not ok exactly once: {t}')
    for c in CONTROLS:
        exp = ' '.join(sorted('tests::' + w for w in want[c][2]))
        got = [l for l in lines if l.startswith(f'## control {c} rc=')]
        if got != [f'## control {c} rc=101 failing: {exp}'] or lines.count(f'## control {c} failed exactly as expected') != 1:
            fail.append(f'control {c} did not fail exactly as pinned ({exp})')
    if not any(f'"lockSha256": "{LOCK_SHA}"' in l and l.endswith('problems=0') for l in lines):
        fail.append('closure verification line (pinned lock, problems=0) missing')
    if not any(re.fullmatch(r'## compiled graph: \d+ packages, all inside the verified closure of 648', l) for l in lines):
        fail.append('compiled-graph-inside-closure line missing')
    shas = [x.group(1) for x in (re.fullmatch(r'## patched test binary sha256 ([0-9a-f]{64})', l) for l in lines) if x]
    if len(shas) != 1:
        fail.append('patched test binary sha line missing or repeated')
    q = [l for l in lines if l.startswith('[queue] EXIT')]
    if q != ['[queue] EXIT 0'] or [l for l in lines if l.startswith('[queue] ')][-1:] != ['[queue] EXIT 0']:
        fail.append('the job output does not end its queue record with a single "[queue] EXIT 0" (running, not started, killed or failed)')
    if open(rc_p).read().strip() != '0':
        fail.append('outer rc file is not 0')
    guard = [l for l in open(guard_p, encoding='utf-8', errors='replace').read().splitlines() if l.strip()]
    if not guard or guard[-1].split()[:2] != ['[memory-guard]', 'exit=0']:
        fail.append('memory guard log does not end with "[memory-guard] exit=0"')
    return {'ok': not fail, 'failures': fail, 'patchedTestBinarySha256': shas[0] if len(shas) == 1 else None,
            'outSha256': hashlib.sha256(raw).hexdigest(), 'tests': len(TESTS), 'controls': len(CONTROLS)}


if __name__ == '__main__':
    if len(sys.argv) != 5:
        print(json.dumps({'ok': False, 'failures': ['usage: check_test_receipt.py OUT RC GUARD STAGE']})); sys.exit(2)
    try:
        r = check(*sys.argv[1:5])
    except (OSError, KeyError, ValueError, IndexError, SyntaxError) as e:      # an unreadable receipt is a refusal, never a pass
        r = {'ok': False, 'failures': [f'{type(e).__name__}: {e}']}
    print(json.dumps(r)); sys.exit(0 if r['ok'] else 1)

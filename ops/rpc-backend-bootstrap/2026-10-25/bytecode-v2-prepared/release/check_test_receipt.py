#!/usr/bin/env python3
"""check_test_receipt.py OUT RC GUARD V2_STAGE: exit 0 only if the root v2 test job (bytecode-v2-validation/jobs/root-build-test.sh)
is a COMPLETE pass (formats as in root's logs/root-bytecode-native-2202.*): aggregate rc=0 as the final '## ' line, no INVALID/failed/abnormal line, 'test result: ok. 23 passed; 0 failed',
every one of the 23 pinned test names 'ok', and every one of the 17 pinned controls 'rc=101' with EXACTLY its pinned failing set
(read from the v2 stage's control/disable_check.py WITHOUT importing it: runpy, no bytecode written) + 'failed exactly as expected';
the lock/closure lines of the pinned graph; rc file '0'; guard log ends '[memory-guard] exit=0'; one '[queue] EXIT 0'. Prints one JSON line (the patched test-binary sha)."""
import json, re, runpy, sys
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
BAD = ('## INVALID', 'DID NOT FAIL', 'abnormal output', 'test missing or not ok', '## patched FAILED')


def main(out_p, rc_p, guard_p, s2):
    fail = []
    out = open(out_p, encoding='utf-8', errors='replace').read()
    lines = out.splitlines()
    want = runpy.run_path(f'{s2}/control/disable_check.py', run_name='receipt_check')['CONTROLS']
    if sorted(want) != sorted(CONTROLS) or len(TESTS) != 23:
        fail.append('pinned test/control lists differ from the v2 stage control file')
    job = open(f'{s2}/jobs/root-build-test.sh').read()
    if sorted(re.search(r'TESTS="(.*?)"', job, re.S).group(1).replace('\\', ' ').split()) != TESTS:
        fail.append('pinned test names differ from the v2 job TESTS list')
    if ('for c in ' + ' '.join(CONTROLS) + '; do') not in job:
        fail.append('pinned control order differs from the v2 job loop')
    hashes = [l for l in lines if l.startswith('## ')]
    if not hashes or hashes[-1] != '## aggregate rc=0' or lines.count('## aggregate rc=0') != 1:
        fail.append('the final job line is not the single "## aggregate rc=0"')
    for b in BAD:
        if b in out:
            fail.append(f'bad marker present: {b}')
    if lines.count('test result: ok. 23 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out') != 1 and \
            sum(1 for l in lines if l.startswith('test result: ok. 23 passed; 0 failed')) != 1:
        fail.append('patched run is not exactly one "test result: ok. 23 passed; 0 failed"')
    for t in TESTS:
        if lines.count(f'test tests::{t} ... ok') != 1:
            fail.append(f'test not ok exactly once: {t}')
    for c in CONTROLS:
        exp = ' '.join(sorted('tests::' + w for w in want[c][2]))
        if lines.count(f'## control {c} rc=101 failing: {exp}') != 1 or lines.count(f'## control {c} failed exactly as expected') != 1:
            fail.append(f'control {c} did not fail exactly as pinned ({exp})')
    if not any(f'"lockSha256": "{LOCK_SHA}"' in l and l.endswith('problems=0') for l in lines):
        fail.append('closure verification line (pinned lock, problems=0) missing')
    if not any(re.fullmatch(r'## compiled graph: \d+ packages, all inside the verified closure of 648', l) for l in lines):
        fail.append('compiled-graph-inside-closure line missing')
    m = [re.fullmatch(r'## patched test binary sha256 ([0-9a-f]{64})', l) for l in lines]
    m = [x.group(1) for x in m if x]
    if len(m) != 1:
        fail.append('patched test binary sha line missing')
    if open(rc_p).read().strip() != '0':
        fail.append('rc file is not 0')
    guard = [l for l in open(guard_p, encoding='utf-8', errors='replace').read().splitlines() if l.strip()]
    if not guard or guard[-1].split()[:2] != ['[memory-guard]', 'exit=0']:
        fail.append('memory guard log does not end with "[memory-guard] exit=0" (job not finished or not a pass)')
    if [l for l in lines if l.startswith('[queue] ')][-1:] != ['[queue] EXIT 0'] or sum(l.startswith('[queue] EXIT') for l in lines) != 1:
        fail.append('the job output does not end its queue record with a single "[queue] EXIT 0" (still running, not started or failed)')
    print(json.dumps({'ok': not fail, 'failures': fail, 'patchedTestBinarySha256': m[0] if len(m) == 1 else None, 'tests': len(TESTS), 'controls': len(CONTROLS)}))
    return 0 if not fail else 1


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:5]))

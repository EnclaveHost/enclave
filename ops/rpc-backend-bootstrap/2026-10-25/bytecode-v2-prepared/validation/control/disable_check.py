#!/usr/bin/env python3
"""disable_check.py <name> <lib.rs>: disable EXACTLY ONE safety rule in a (private, build-tree) copy of lib.rs.
Prints the exact set of tests that must then FAIL (assertion failures; a compile error is INVALID, never a kill).
bytecode-v2-validation: the 5 v1 controls (anchors byte-identical to v1; 'completeness' additionally fails the new v2
missing-code test) + 12 controls, one per new v2 rule."""
import sys
T = 'tests::'
OK = 'report_ok_requires_every_v2_binding'
VALID, BYTES, MUT, DIG = ('v2_scan_valid_fixture_is_ok_with_exact_counts_digests_and_checkpoints', 'v2_scan_leaves_every_byte_of_mdbx_dat_unchanged',
                          'mutation_between_scans_changes_txn_id_entries_and_digests', 'digests_change_with_one_row_one_byte_or_one_reference')
MISSING, CPS, FRAMED = ('missing_code_bad_row_and_empty_accounts_are_not_ok', 'missing_or_partial_checkpoints_are_not_ok',
                        'framed_digest_is_stable_and_length_and_count_framed')
E2E = 'mdbx_scan_end_to_end_reports_failures_missing_code_and_is_read_only'
CONTROLS = {
    # ---- v1 (unchanged anchors) ----
    'jumpbit': ('                if stored != want {', '                if false && stored != want {',
                ['forged_jump_bits_are_executed_by_the_client', E2E, 'pseudo_random_client_rows_pass_and_every_read_jump_bit_flip_fails']),
    'padding': ('            if fresh_padded > l {', '            if false && fresh_padded > l {',
                ['padding_shorter_than_revm42_is_refused_and_dupn_is_classified']),
    'client': ('    let c = client_decode(v)?;\n', '    if std::env::var_os("BBC_NEVER_SET").is_none() {\n        return Ok(());\n    }\n    let c = client_decode(v)?;\n',
               ['client_cross_check_independently_refuses_harmful_rows']),
    'completeness': ('        if !has_row(h) {', '        if false && !has_row(h) {',
                     ['completeness_counts_missing_code_and_ignores_empty', E2E, MISSING]),
    'eip7702': ('            if tag == 4 && (!code.is_eip7702() || l != 23) {', '            if false {',
                ['rows_the_client_misreads_silently_are_refused']),
    # ---- v2 rules ----
    'entries': ('        && self.bytecodes_entries == Some(self.rows)\n', '', [OK]),
    'accounts': ('        && self.hashed_accounts_entries == Some(self.accounts_scanned)\n', '', [OK]),
    'codele': ('        && self.with_code <= self.accounts_scanned\n', '', [OK]),
    'withcode': ('        && self.with_code > 0\n', '', [MISSING]),
    'txnid': ('        && self.txn_id.is_some_and(|t| t > 0)\n', '', [OK]),
    'checkpoints': ('        && STAGES.iter().all(|(k, _)| self.checkpoints.get(k).copied().flatten().is_some())\n', '', [CPS, OK]),
    'datadir': ('        && self.datadir.as_deref().is_some_and(|d| !d.is_empty())\n', '', [OK]),
    'rowsdigest': ('        rows_digest.item(&[k.raw_key().as_slice(), v.raw_value()]);\n', '', [VALID, DIG, MUT]),
    'refsdigest': ('                    refs.item(&[addr.as_slice(), h.as_slice()]);\n', '', [VALID, DIG, MUT]),
    'framing': ('            self.h.update((p.len() as u32).to_be_bytes());\n', '', [FRAMED]),
    'count': ('        self.h.update(self.n.to_be_bytes());\n', '', [FRAMED]),
    'scanned': ('                scanned += 1;\n', '', [VALID, BYTES, MUT, MISSING, E2E]),
}
if __name__ == '__main__':
    name, p = sys.argv[1], sys.argv[2]
    a, b, want = CONTROLS[name]
    s = open(p).read()
    if s.count(a) != 1: sys.exit(f'{name}: anchor found {s.count(a)} times')
    if a == b: sys.exit(f'{name}: replacement equals the anchor')
    open(p, 'w').write(s.replace(a, b))
    print(' '.join(sorted(T + w for w in want)))

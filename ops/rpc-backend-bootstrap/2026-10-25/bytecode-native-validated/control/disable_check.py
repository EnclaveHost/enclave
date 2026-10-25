#!/usr/bin/env python3
"""disable_check.py <name> <lib.rs>: disable EXACTLY ONE safety rule in a (private, build-tree) copy of lib.rs.
Prints the exact set of tests that must then FAIL (assertion failures; a compile error is INVALID, never a kill)."""
import sys
T = 'tests::'
CONTROLS = {
    'jumpbit': ('                if stored != want {', '                if false && stored != want {',
                ['forged_jump_bits_are_executed_by_the_client', 'mdbx_scan_end_to_end_reports_failures_missing_code_and_is_read_only',
                 'pseudo_random_client_rows_pass_and_every_read_jump_bit_flip_fails']),
    'padding': ('            if fresh_padded > l {', '            if false && fresh_padded > l {',
                ['padding_shorter_than_revm42_is_refused_and_dupn_is_classified']),
    'client': ('    let c = client_decode(v)?;\n', '    if std::env::var_os("BBC_NEVER_SET").is_none() {\n        return Ok(());\n    }\n    let c = client_decode(v)?;\n',
               ['client_cross_check_independently_refuses_harmful_rows']),
    'completeness': ('        if !has_row(h) {', '        if false && !has_row(h) {',
                     ['completeness_counts_missing_code_and_ignores_empty', 'mdbx_scan_end_to_end_reports_failures_missing_code_and_is_read_only']),
    'eip7702': ('            if tag == 4 && (!code.is_eip7702() || l != 23) {', '            if false {',
                ['rows_the_client_misreads_silently_are_refused']),
}
name, p = sys.argv[1], sys.argv[2]
a, b, want = CONTROLS[name]
s = open(p).read()
if s.count(a) != 1: sys.exit(f'{name}: anchor found {s.count(a)} times')
open(p, 'w').write(s.replace(a, b))
print(' '.join(sorted(T + w for w in want)))

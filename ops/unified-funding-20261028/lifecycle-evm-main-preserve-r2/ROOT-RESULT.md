# Preservation after whitespace check

Previous83fc43545ed14805a98aba154e2f7930 terminal1/Main0 failed the normal staged diff whitespace check before commit/push. Only an extra EOF blank line in test/fixtures/lifecycle-schema3-evm.mjs was removed. Its exact tested bytes remain under tests-r2/differing-tested-source. All other84-pin closure files are unchanged; semantic source is identical to the eight-pass test run. No unchanged suite rerun or hook bypass. Normal hooks/secret scanning and exact origin/main verification retained.

Preservation807a199b32d444cbb1bcbf7add82cdd2 also terminal1/Main0 before commit/push: the intentionally preserved raw tested source retained its EOF whitespace. R3 stores those exact bytes as a JSON UTF8 string plus SHA256, so normal whitespace checks need no exemption. No semantic source change.

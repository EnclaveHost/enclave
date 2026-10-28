# Site wrapper review: not deployable

October 28 2026. This is a source snapshot and failed-review evidence, not an installed candidate. The previously qualified r4 migration core is unchanged. No signing, fund movement, production files or wallet journal changed.

The source-only author completed. Root read the page, state helper, generator, bundle builder and tests. A bounded 512 MiB queue run (450 MiB RSS guard, 27648 MiB host floor, one CPU, no swap) ran 24 checks: 19 passed, 5 failed, 0 skipped. Three root tests demonstrate missing refusal of signing after a prior proof recheck failure, reuse of held signatures after admission, and plan selection without relay binding. Core send admission and proof checks remain in force; these UI failures do not prove a duplicate debit or a production exploit.

Two author test failures are test defects: a comment contains `window.` and a different-owner context correctly selects that owner's plan while the test expects none. Do not describe those as five production defects.

An independent generator check also fails: the generator's own two build-site replacements violate its substring-additivity check. No candidate was generated. Source inspection additionally finds that the action finalizer rerenders and discards the shown quote, the UI displays proposal values while an existing plan may differ, wallet/chain changes during awaited operations are not guarded at each effect, and ordinary build-vendor deletes the separately built funding bundle. These inspection findings need executable workflow/build checks during repair.

The original snapshot and logs are retained; source-only repair is in client-site-repair-r2. No original source APIs, contracts, relay, admission or production site changed. Author claims of exact relay-scoped plans are not established by this snapshot. Null runtime/approval defaults are retained.

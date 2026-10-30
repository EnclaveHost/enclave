# Root 1905: narrow namespace guard test correction

Actual r2 ran12 tests:11PASS/1FAIL. All hazardous-mount and receipt-rejection cases passed. The test2 exact expected record omitted the newly added allNamespaceHazards field. Frozen r3 adds that required empty field to the expected record; all other edits are revision labels. No guard logic, rejection rule, pin, or test count changed. The r2 failure remains retained. Root reviewed the r1-to-r2 guard diff and synthetic test execution before this correction. Actual r3 tests still need execution; no production launch authorized by this note.

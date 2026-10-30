# Independent owner-read CLI integration

Committed and pushed as `9823ad9a5` on `fix/rpc-runtime-final-20261026`.

The independent CLI secrets commands now route to the existing custody-v2 implementation with shared custody handles. Hosted behavior is unchanged. Owner reads require an explicit policy opt-in, correct ownership and valid committee shares; writes retain revision checks. Custody v2 remains refused under the local proof verifier. No production custodian image, committee, policy, or secret was changed.

Actual tests: combined independent CLI 4/4, custody independent CLI 12/12, owner-secret CRUD 4/4. Independent CLI 13/14: its only failure remains the historical schema-4 registry source hash, changed by the earlier history rewrite. The updated secrets-dispatch case passed. The overall runner exited 1 and is not represented as green. No cases were skipped.

Profile-mode review: configureIndependent sets CONTRACT_PINS from trust.pins before resolveAddressBook, so the latter returns without contacting the hosted address-book path. The new independent command handles expose no hosted API.

Live SNP custody qualification, new measured custodian deployment, relay plaintext removal and migration/rollback tests remain separate outstanding work. These local tests do not establish production custody readiness.

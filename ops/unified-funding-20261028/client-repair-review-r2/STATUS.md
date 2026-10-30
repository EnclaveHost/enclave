# Client repair review r2 — not deployable

Exact source snapshot after Claude completed the focused repair. Original staging import paths are deliberately retained; these files are evidence, not a portable or installed client. Stage paths: unified-funding-20261028/client-repair-r2.

Root ran 31 offline checks: all pass, zero skips. The five earlier canonical receipt identity failures are corrected; exact refund/open event checks, maxRateHour6 comparison, atomic public journal admission and normal pending/reload flows were added. Scripted RPC/relays, public test wallet, Node WebCrypto and memory stores; no actual IndexedDB, deployed/native integration or production signature proof.

Root reproduced three additional failures, all retained: reconcile re-adopts an orphaned previously proven replacement; a next gas open can proceed after prior canonical-only receipts disappear; finality accepts a mismatched canonical header number. The candidate remains OFF. Next repair must revalidate ordered proofs before subsequent sends/adoption, validate finality metadata and use pinned chain time for signature expiry rather than local clock alone.

Current model still has one 1-USDC gas grant and cannot cover nine distinct app IDs with the eight-app limit. Explicit 29+0.9+0.1 partition is a preparation candidate, not approved or signable. No old session termination, signature, approval, key export or fund movement. Actual migration, browser persistence/native contract integration, deployed runtime pins and production canary remain required.

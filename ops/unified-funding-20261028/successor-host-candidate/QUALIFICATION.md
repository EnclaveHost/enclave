# Composed successor host qualification

Stage and packaged suites each pass 23 tests, zero failures or skips. Packaged sessions, route and fee-policy modules are byte-identical to the reviewed stage. The RPC responses and fee policy in these tests are scripted; these results do not demonstrate native P256 verification or production operation. The native HTTP integration fixture is being prepared separately.

Root regressions reproduced and fixed conflicting terms on an already reserved intent, ambiguous first-send nonce errors releasing the reservation, and regular intents consuming owner-control journal headroom. An additional concurrent conflicting-terms test passes. See ROOT-REVIEW.md for limitations and retained failure evidence. No production mutation or signing occurred.

# Investigation only

No game-finality authority is implemented or activated. Root has not accepted slower lease startup as a replacement for the existing finalized-claim contract. The suggested pure JS helper is incomplete: it does not recompute header or receipt roots and is not a proof verifier. No consumer may use it as authority.

An isolated follow-up is preparing an explicitly configured Ethereum light-client prerequisite and comparing trust/availability tradeoffs. This does not change the production cutover gates. Existing administrative controls, lease fencing and production apps remain in place.

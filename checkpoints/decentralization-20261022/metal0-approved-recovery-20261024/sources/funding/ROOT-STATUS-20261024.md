# Root continuation after Claude weekly limit

No production delegation or funds changed. Original README describes the earlier fe7e105 unsigned-only preparation; subsequent source is now a proposed sender as described below and is not activated.

Root completed the interrupted sender and tests: fixed viem export, added fresh complete preparation before signing (including live L1/operator fee bounds and unchanged storage), exact receipt-status agreement, signing deadline check, and required both providers to return actual EVM reverts for the plain-transfer premise rather than treating transport errors as a revert.

Current local tests: 12 real Anvil/revm protocol cases; 8 sender cases including A-mined/B-unavailable recovery with identical bytes and no second signing, stale nonce, changed fees, journal failure, provider receipt disagreement and expired approval; 6 pure plan cases. Sources and local throwaway keys only. Observation CLI is read-only and explicitly non-executable; root live observation b99f2c4d passed the configured pins with no findings, fees1069676386805wei, fee cap2000000000000wei, funding5000000000000wei. The keeper remained active throughout.

The new 1200s lease requirement replaces infeasible1800s only for this proposed account maintenance, with explicit root approval binding its profile, 120s max plan age, 120s verification cutoff, and signers stopped until verified restore. Original control activation guards are not lowered.

Remaining before execution: exact operational stop/resume orchestration, authority approval for sponsor funds/delegation maintenance, fresh quiesced prepare and fee bounds. No claim of automatic restoration after conflicting nonces; classified recovery requires root. No constructor, SELFDESTRUCT, generic executor, or manual proof-key helper. Previous rejected approaches remain unused.

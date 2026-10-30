# Wallet-owned deployment migration inventory

Status: read-only inventory and eth_call simulations, no transaction/signature/refund/transfer. Complete enumeration of 99 rows in deployed ledger schema16 at block 53263892 (0x920fb3aa7870a8bc0f7940c93ad6e7afb1923bbbaf78881e6123486df91f0fab). Two providers agreed on every returned value and block; this is not finalized migration evidence. api.enclave.host and base-mainnet.public.blastapi.io responded; publicnode did not. Previous r1 failed because the reader incorrectly called book.deployments(); corrected r2 uses the historical source's addr(bytes32("deployments")). Both attempts are retained.

Five rows are held by the recognized legacy B794 session vault. Its factory runtime hash, isVault, vaultFor and owner bind to wallet 0x0b2d009c0c9Af05b12100D77F3c815fea822eE61; its book resolves the actual ledger. Five other contract owner addresses remain unclassified; this inventory must not infer their controlling wallets from arbitrary getters. It is a complete ledger enumeration, not complete authority classification or catalog inventory.

| Deployment prefix | Active flag | Balance microUSDC | Owner escrow | Held escrow | Old reserve wei | OwnerCall simulation |
| --- | --- | --- | --- | --- | --- | --- |
| 0xcab8fb59 | False | 9500000 | 0 | 0 | 0 | passes |
| 0xa62e13de | False | 0 | 0 | 0 | 0 | passes |
| 0x59f1273d | True | 6415930 | 4850000 | 4910724 | 1052268502151 | refund first |
| 0x87508b95 | False | 0 | 0 | 0 | 0 | passes |
| 0x9a28642b | True | 5190014 | 5055558 | 5055558 | 959970768583 | refund first |

All three passing rows are inactive with leaseUntil0 and zero old/new gas reserve. One retains9.5USDC accounting balance with no held escrow; transfer itself preserves it, and no refund is proposed. New-wallet buckets are zero/disabled for every row. The two blocked rows are EnclaveDNS59f1273d and kvm-box-native9a28642b; both leases are expired at this snapshot. Their active flags do not establish serving. Do not run refund-first, consume credit to clear escrow, or reset reserve budgets. The explicit ownerCall transfer simulations carry no ETH and only read state.

Before submission: fresh deployed implementation/code match, owner/nonce/state verification, beneficial-owner secret policy and session/delegation continuity, exact operation review and poststate verification. Existing operator-scoped/refund liabilities must be retained. A successful simulation alone does not qualify these boundaries.

Live /sessions inspection displays the same five held records and existing wallet delegation as granted, but offers only promote-current, no release button. This is the next concrete frontend gap; core ledgerSend currently tells users to use a release control that is absent. Peer is preparing a narrow source-only release-UI author package; root has not launched it. Browser session keys and wallet signing have not been accessed or exported, no signatures requested, and no state mutation performed. Do not claim the apps migrated.

Both read jobs used shared256hard/220RSS/floor27648/CPU1/noSwap and are terminal. Corrected run peak aggregate170MiB, minimum observed host available31878MiB. No capacity test, native experiment or production backend restart.

Read-only source evidence; not installed verification.

Historical SessionVault _dispatch1013-1074 and _requireHeldEnv1104: wallet-held is PROD2; setAppRef/setConfig require staging and therefore narrow after release. Existing common-action gates are grant action/env, not uniformly app-list constrained; fund adds wallet-held app/fee checks. _live895 checks state1,current epoch,expiry. SDK sessionOf tuple covers full actions/envs/budgets/epoch/expiry/apps.

Host session-api-auth verify308-338 checks requested API action; refusal346-369 checks holder/env/delegation, not apps array. Actual installed consumers and grant census needed. envs3 for one known session is not complete authority evidence. Other wallet-delegated vault principals can gain reach.

Relay custodyRefusal1180-1216: staging has no promoted check; unpromoted PROD does. Wallet rows bypass that predicate. Thus staging is not categorically unsafe; unpromoted PROD needs independent equivalent policy or separately authorized content approval. Secret book zero is not no-secrets proof.

DelegateSet is the only ledger delegation write after zero-initialized construction in pinned rev16d; replay current boolean mapping at slot23. Supported vault open variants emit SessionOpened; sessionOf supplies current state after extend/terminate/revokeAll. New delegates found in the final tail but not historically scanned remain explicitly incomplete. Two-provider matching logs are not a cryptographic proof against common omission.

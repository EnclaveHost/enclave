# Owner-controlled path; no platform approval list

The author's empty ROOT_QUALIFIED_CONTINUITY list must not become a requirement for Enclave approval of independent wallet migration. Its matching fields also do not prove the complete effective policy described in REVIEW.md. Do not publish this candidate as a functional migration implementation.

For an inactive, unleased, escrow-clear STAGING row, the smallest source-supported candidate is an independently checkable census of actual live grants, delegates and installed consumers, optionally followed by the direct owner's per-app custody fence reviewed in REVIEW.md, fresh post-fence state, and the owner-authenticated final transfer with exact receipt/state verification. No trusted per-app exception list is needed. The review must establish the specific authority implication for all relevant principals: a common action allowed after the move was already allowed before, or is explicitly narrowed. Known envs3 is evidence for one session only.

The custody fence is not mandatory merely because a migration exists, and it does not establish atomic preservation of every field. It addresses the source vault's pending session writes while that vault still owns the row. Fresh delegate/owner-operation/consumer coordination and the old-reserve race remain explicit qualifications. Do not insert an extra transaction without a concrete need and exact review.

If a complete census shows previously excluded prod-only sessions or other wallet-delegated principals would gain authority, resolve that through the owner's actual policy controls. Do not bypass it by an operator-authored allowlist. Changing shared grants/delegation can affect other apps, so it is not an automatic per-app fix.

For unpromoted PROD, preservation requires proof that another installed predicate continues the equivalent content denial. Explicit owner review/authorization of the current content could instead constitute a new policy decision, but must not be disguised as unchanged policy or inferred from a raw transfer passing simulation. No promotion or other policy change is performed or authorized by this review.

Root separately identified an implementation bug in the frozen controller: after awaiting journal CAS to dispatching, it can POST without a new liveness assertion. Account/dispose changes during persistence can therefore cross the final send boundary. This is a root source finding awaiting its bounded reproduction, not a test result from this chat. Preserve the original source and failed evidence; do not deploy around it.

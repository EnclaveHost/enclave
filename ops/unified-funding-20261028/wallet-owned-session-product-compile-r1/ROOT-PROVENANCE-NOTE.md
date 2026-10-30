# Root source review: distinguish import from creation

The exact deployed rev16d source (SHA256 `2771a5248ed7a68f5521b08dbde466603b02c29ccd961d55fd9eceabe1d11cd1`) emits the same `Created` event for ordinary `create` (line 747, caller owns newly generated ID at line 644) and `importDeployments` (line 1515, imported owner is re-emitted). A Created event naming the current wallet does not by itself prove original direct-wallet creation or absence of session content policy.

The next policy discovery repair must authenticate the birth transaction/call path and receipt membership, distinguish import provenance, and resolve supported legacy ancestry explicitly. Missing factory configuration or an unexplained import cannot mean legacy-unbound. This is source evidence and a regression requirement, not an executed test or an observed production defect. Original source and prior failures are unchanged.

The unchanged SessionVaultLib only resolves the deployments and appCatalog addresses from its book (lines 149 and 155). Binding those two routes through an immutable owner-chosen profile can remove the external mutable-book veto without rewriting the legacy library. The profile and implementation identities must still be verified. Existing broad legacy ledger delegation must not be represented as narrowed by the new executor, and must not be silently revoked.

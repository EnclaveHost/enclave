// ROOT-CONTROLLED ACTIVATION GATE. Initially LOCKED: serve.mjs refuses to start. Only after the user approves the
// 0.0013 ETH + fees budget does root set locked:false and the sha256 of the exact approved
// outputs/app-lease-gas-review/complete-bootstrap-funding-proposal.json, which serve.mjs must ALSO be given on its
// command line (--approved-proposal sha256:<hex>). No code path chooses a different proposal or amount.
export const APPROVAL_GATE = Object.freeze({ locked: true, approvedProposalSha256: null, approvedBy: null, approvedAt: null });

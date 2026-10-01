// The wallet signs the exact ledger, deployment and preference being saved.
export const placementMessage = (ledger, id, hostId, expiry, nonce) =>
  `Enclave placement\nLedger: ${ledger}\nDeployment: ${id}\nPreferred host: ${hostId || 'Auto'}\nExpires: ${expiry}\nNonce: ${nonce}`;

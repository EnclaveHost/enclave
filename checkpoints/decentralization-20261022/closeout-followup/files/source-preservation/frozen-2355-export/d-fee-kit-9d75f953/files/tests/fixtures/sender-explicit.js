// FIXTURE ONLY: H's PROPOSED explicit-fee sendOperatorTx (boot-normal-fee working tree, 2026-10-23T23:2xZ), NOT an approved
// commit. The live preflight never uses this file: it slices the approved commit's own sender, sha256-pinned in build.json.
function sendOperatorTx(address, abi, functionName, args) {
  const p = _txChain.then(async () => {
    const { account, wallet } = claimSigner();
    const to = getAddress(address);
    const { maxFeePerGas, maxPriorityFeePerGas } = await chainClient.estimateFeesPerGas();
    const gas = await chainClient.estimateContractGas({ address: to, abi, functionName, args, account, maxFeePerGas, maxPriorityFeePerGas });
    return wallet.writeContract({ address: to, abi, functionName, args, gas, maxFeePerGas, maxPriorityFeePerGas });
  });
  const rcptP = p.then((hash) => awaitReceipt(hash));
  _txChain = rcptP.then(() => {}, () => {});   // keep the queue alive across failures
  p.receipt = rcptP;   // callers that need the outcome share the queue's own
  return p;            // receipt wait instead of polling for it a second time
}

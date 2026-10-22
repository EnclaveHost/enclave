Root-owned contract-creation handoff preparation; NOT activated.

The existing independent signer explicitly refuses contract creation. This separate preparation
module does not remove that guard. It creates an exact request only after fresh two-provider
simulation and checks a returned creation transaction/receipt/runtime. A final handoff still
requires fresh pending-nonce agreement, current contract bindings, two independent receipt/code
reads and reserve owner/ledger/registry/oracle/limits/executor reads at the same agreed block.
Creation must not be presented as funding: value is zero and the predicted address is not a
deposit destination. First verify the actual reserve, then prepare executor creation and binding.

No HTTP service, browser wallet request, private key read, transaction submission or funding
has been performed by these files. Root's source and test work here must finish before use.

DEPLOYED AND VERIFIED: 0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7 on Base. See deployment-receipt.json. nucbox-k11-4 operator nomination and owner acceptance confirmed; see ../windows-host-enrollment/. Host runtime enforcement is not yet active.

Historical preparation notes follow.

Host wallet authority — prepared, not deployed

transaction.json contains an unsigned Base contract-deployment transaction for EnclaveHostOwnership, compiled from source commit 0bd0ef552bfce640be05b4ab7477b3f0b412bdac. Two agreeing recent RPC observations confirmed the registry binding and its bytecode hash. Gas estimation succeeded (495392).

The contract has no global veto administrator. An active registered host operator nominates its owning wallet, which accepts. Later transfers require the current and next wallet; acceptance clears the prior owner's policy. Payout addresses confer no authority.

This transaction alone does not activate enforcement. Host-runtime integration is prepared in host-runtime-release. Activation, explicit enrollment of each participating host, wallet policy publication, a compatible measured custody release, and independent custody operators remain required. Existing custody must remain on its compatible runtime until its bundles and committee migrate.

Before signing, verify the hardware-wallet address, revalidate registry address and code, refresh gas and nonce, and review the complete transaction. Nothing in this release has been signed or broadcast.

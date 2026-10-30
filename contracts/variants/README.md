# Optional contract variants

`EnclaveSecretVaultV2PinnedAuthorities.sol` is the pinned-authority custody vault (main blob 2806854b, sha256 fc43ab52…),
deployed once on Base at 0x56b81b3970a8ac2c52f9874Bd2758eDE30758228 by `scripts/independent-authorities.mjs`. It froze the
ledger/registry/session-factory bindings at construction, classifies the Enclave seat by accepted host-wallet ownership,
and adds founderless independent genesis. It holds no committees or policies and is not the production custody vault.
Its source keeps the historical unit name `EnclaveSecretVaultV2.sol` when compiled, so the recorded profile build
(`contracts/deployments/independent-authorities-base.json`) and its runtime verification are unchanged.

`contracts/EnclaveSecretVaultV2.sol` is the original book-bound vault (blob 7a385bbc), the source of the production vault
0xE48699B8401564aaCe7A814AE4569b67a3F7eEF5, whose runtime it matches byte for byte.

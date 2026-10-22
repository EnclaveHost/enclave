Prepared adapter migration release — not yet deployed

Source: https://github.com/EnclaveHost/enclave-apps/pull/3
Commit: c778da5
Production deployment: 0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33
Owner: 0x0b2d009c0c9Af05b12100D77F3c815fea822eE61

The WASM is uploaded to the actual adapter and has been fetched back with its SHA-256 checked. Its CID also matches local Kubo's calculation. See artifact.json for exact hashes.

transactions.json contains two unsigned Base transactions:
1. Publish s3-ipfs-adapter:1.0.16, preserving generic catalog defaults.
2. After verifying publication and approval, atomically update only the production adapter's appRef and deployment config. The config sets walletAudience to this deployment's own ID; placement, network options and existing secret references are retained.

Both calls passed simulation. Recheck the current version index, owner, address book and transaction nonce before signing. No token approval or asset transfer is requested; only network transaction fees apply. The hardware wallet holds the signing authority. Neither transaction has been signed or broadcast.

This release adds direct EOA upload authorization. Legacy HMAC clients remain compatible. It does not complete contract-wallet/session migration, independent custody, Sia indexd/PostgreSQL migration, DNS/ENS, host control or certificate issuance. Nan must remain running until those paths and a real outage test pass.

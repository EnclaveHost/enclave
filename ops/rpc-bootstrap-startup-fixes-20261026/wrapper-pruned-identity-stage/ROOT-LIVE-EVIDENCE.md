# Root live observation — 2026-10-26, about 08:24 UTC

Read-only SSH to enclave-rpc, no configuration/process changes.

`sudo -n /usr/bin/python3 -I /opt/enclave-rpc/chain_service.py l1-ready` fails at genesis request with `AssertionError: local RPC failed`.
Local endpoint `http://127.0.0.1:18645`:
- eth_chainId: 0x1
- eth_syncing: false
- eth_getBlockByNumber(0x0,false): error4444, `pruned history unavailable: requested 0, earliest available 26100000`
- eth_getHeaderByNumber(0x0): same exact error
- eth_getBlockByHash(mainnet-genesis,false): same exact error
- finalized number0x190eed8 hash0xa01dc17b9eba99828e595909c017d0da30c8ef5b7ba27299c6b5b9049c198db3 timestamp0x6adf0957
- latest number0x190ef27 hash0x536cd9fbd5b8b1292aadcb6d92862771cac1ce9ad2d353371b6e0f282415d0f0 timestamp0x6adf0d0b

Both installed wrapper and r12-final wrapper still ask for genesis unconditionally. Readiness sampler already has a compensated operational identity path; startup wrapper does not. This is a newly confirmed activation blocker, not evidence of successful production readiness. Fix staged separately; must compose before final wrapper/source pins and test actual l1-ready in guest without activating Base.

Portable network qualification checker

This package contains the standalone checker, its four public directory origins and the Windows service launcher. No signing key is included. The trusted checker address is 0x57144c9008cff0b3ed94f6e40964a321fbee848a; this is the existing checker identity, not a new independent vote.

Target: the existing Windows nucbox-k11-4 host, separate from the four network providers. Files live under C:\ProgramData\Enclave\network-checker, restricted to SYSTEM and Administrators. The scheduled task is \Enclave\NetworkChecker, runs as SYSTEM at startup, and restarts the launcher after failure. The launcher uses the installed Node and WireGuard executables. Exact hashes are in manifest.json. The key was transferred over SSH stdin without a local plaintext file or command-line key material.

Migration rule: only one checker instance may probe using this identity at a time. Providers replace an earlier probe from the same checker. Running Nan and the candidate in parallel can therefore interrupt each other's integrity transfer. One unpublished Windows round had a Singapore transfer timeout; the unchanged repeat passed all nine checks on all four providers. The handoff now stops the source before starting the replacement, after confirming more than seven minutes of healthy signed-verdict coverage remains.

Activation evidence belongs in checker-migration.json. Completion requires a full replacement round issued after Nan's checker stopped, with matching signatures visible on all four directories and the adapter healthy. If that gate fails, stop and disable the target task before restarting Nan's checker. Do not weaken the nine checks, shorten the integrity payload, or extend verdict expiry to make the move pass.

Source rollback remains enclave-network-checker.service on Nan with its original files and key. Retain it until the migration is stable. The destination's ongoing logs and live-verdicts.json are private operational files. The runtime publishes only signed public provider verdicts to the four IP origins; it does not publish to Nan. Paid-provider attestation still uses the configured public Base RPC and legacy on-chain address-book binding.

This migration removes the checker process from Nan. It does not create independent checker governance, redistribute custody, migrate Sia metadata, delegate DNS, or prove a full Nan outage. All existing checker trust choices are unchanged.

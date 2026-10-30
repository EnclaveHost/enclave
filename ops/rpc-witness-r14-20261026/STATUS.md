# Qualified private witness composition; not installed

Candidate r14-witness SHA256SUMS1ba2d51a47d0576cada1e0e24b885234e39c6c53f4e6af5e8c9e5ee5e921793b passed its actual full affected qualification. The receipt SHA256 is cd64992fb70c2ee48a00852f1e0930f93cb4c3a449e7de7213189f8f4175eb3e. Its installer labels retain r13 for compatibility; the digest binds the receipt to this candidate. Changed executable files were re-tested, while unchanged suites have explicit pinned reuse evidence.

The bridge admits at most two connections before reading, streams bounded replies without whole-response copies, enforces absolute deadlines, and rejects malformed framing. Its twelve tests include a20MB response with measured allocation below4MiB and slow/oversized/refused requests. The limits are not measured mainnet witness requirements. Public HTTP modules remain unchanged; debug methods are only available through private IPC and private loopback bridge ports.

The exact witness-r2 archive preserves every frozen qualification input, including an incidental generated Python bytecode file in that stage's SHA256SUMS. Readable source is also included; no bytecode is shipped by the production manifest. The archive avoids silently losing a frozen input through the repository's bytecode ignore rule.

The fixture recipe is PREPARED and not live-tested. Root review requires stronger actual systemd property assertions, MemorySwapMax, cleanup verification and host orchestration; a separate revision is in progress. No real node IPC, new live sandbox, production restart, SNP measurement or positive mainnet witness is established by these tests. L1 IPC activation will need a coordinated EL restart after prerequisites. Existing applications and administrator controls remain unchanged.

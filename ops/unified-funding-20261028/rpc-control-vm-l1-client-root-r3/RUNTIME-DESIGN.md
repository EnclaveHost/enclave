# Draft native client trial interface — preparation only

ControlVM caps: shared EL/CL slice2304MiB, attachment/controller128MiB, independent watchdog/cleanup128MiB. Warden exporter+tunnel separately512MiB/floor27648. Preserve all seven existing service caps; reserve pending growth plus remaining admitted trial growth and1536MiB residual continuously. No arbitrary EL-versus-CL split. Root watchdog sits outside client OOM slice.

Private persistent COW only; parent OFD/identity/header checks and original300GB NVMe free floor. Actual metadata read was incomplete only due staticinventory1024 cap, not database/filesystem absence. Use exact observedTOML and no repeat static listing. Preflight within readonly mount captures numeric ownership for data/db/MDBX/cl/chain_db/tmp dirs and target passwd/group mappings. Only dedicated matching rpc identities or unused UID/GID may run; unrelated sameUID collision refuses, no root fallback/recursive chown. Root controls block attach/config/account setup; separate unprivileged EL/CL units retain NoNewPrivileges/ProtectSystem=strict/ProtectHome/PrivateTmp and RW only their own data/tmp subtree.

Client startup uses exact individually transferred/hash-sealed Reth/Lighthouse and reviewed wrapper private-path adapter. Root-generated JWT is private and never emitted. Preserve actual pruning/static config; only23 stage allowlist assignments change in privateCOW. Isolated root runtime state is0700; root-owned public binaries/config are readable to service identities; JWT0640 only dedicated supplementary group. Existing producer/consumer config untouched.

Independent root watchdog exists before NBD/client activation and handles guard failure/controller loss/client OOM/finite deadline. Stop latch prevents further starts; mutation lock covers stop check+newclient launch. Cleanup sends SIGINT and verifies both exact client unit invocations dead before unmount/detach, then exporter/OFD release. Failure to stop/clean is retained and never production success. First bounded trial captures startup/RPC/peak-memory/catch-up samples and graceful stop; full freshness, finality, blob/history coverage remain later production gates. No Base activation or consumer switch.


R3 amendment: see ROOT-REVIEW.md; exact retained r2 accounts are reused, not created. Fresh mount /srv/enclave-l1-pair-r3.

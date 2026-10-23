# Research notes (read-only agents, 2026-10-23)
## Production migration state (agent C)
- Live primary: Hyper-V VM enclave-storage on minipc; indexd release current 2c0e5b06 (c2-enclave) schema 28; controller 1543577f; casEnrolledAccounts 0, fencedAccounts 0; /fence unauth 401.
- Counts (v26 preflight/backup 603f3b39): accounts 1, contracts 78, objects 1491, slabs 562. No post-v28 count recorded.
- Ingress: Caddy 9443/9080 -> 127.0.0.1:9982; reverse ssh tunnels to 4 DO hosts; sia.enclave.host resolves only to DO.
- Client: sia-s3 0.1.8 (catalog index 7) unfenced, indexer https://sia.enclave.host; deployment 0xef514ed3 leaseExpiredAtRead true (storage-public-state-20261022.json).
- Procedure: work/storage-c2-implementation/sia-s3/REPLICATION.md (57b4fb5d): app key registered on every indexer first (:55); W-1 rule (:211); commit (:182); 1->3 (:407-412); retiring (:415); never revert (:423); stop old first (:425).
- Sequence: storage-activation-next/ACTIONS.json T1 (stop 0.1.8, deploy C2 00e9cde0 N=1/W=1 -> epoch1 enrollment), T2 (1->3 N=3 W=2), T3 adapter endpoint only if changes, T4 retire minipc after stable epoch2 + two converged repairs; noTwoPrimaries.
- Detailed T1: storage-existing-lease16-interop-20261022.json .activation.sequence; authorizedForWorker false.
- Tools: control-package/storage-closeout/activation/{host-preflight.sh 16e9e707, gate-preflight.mjs 6792c5a5, descriptor.mjs cb3611a5, render-config.mjs a6b62d50}; RECIPE.md; rc3 dc2d018f/e903e94c; host-software tar 83c95b4b; controller 1543577f (no enroll/membership cmd); rollback-c2 refuses if enrolled; B2 runner 62f43690; vm-state.sh 5ac71122.
- Blockers: G5 restore-to-VM untested; G7 rollback backups unverified; U1 (mock only? - check vs interop U1 CLOSED); no non-DO advertiseURL; metal0+minipc same site (<3 failure domains); rc3 needed.
- Signatures: descriptor by metal0 operator 0xC9D0..E6aB (EIP-191); Sia funding per replica NOT authorized (~14 GB/replica); C2 catalog version by slug owner 0x0b2d..; redeploy/secrets by deployment owner; app-key registration per replica operator.
## Host role / package lineage (agent A)
- Role 20abb681 + tests 341e6363 / e4795da6 identical in storage-host-role/tree, checkpoint main-repo 8ac1aa51, my candidate 0757085e; absent in origin/main 7752a423; untracked in work/enclave.
- Role is a KEYED separate supervisor (systemd enclave-storage-indexer-host@<r>), not in ROLES.
- Packages: rc1 7874cc1f (e6e812fd); rc2 3b78d4f1 pin 8cbb22de (e6e812fd); rc3 dc2d018f pin e903e94c (2c0e5b06, db v28) at claude-resumed-20261022/storage-rollout-inventory/out/b1/{a,b}; rc3 test 9d194cb6 untracked in tree.
- OPEN: ROOT-LIFECYCLE-REVIEW doc/code mismatch (role :288 "waits for decision" vs :376 not awaited); INVENTORY.json:156-163 missing inputs (live 0.1.8 catalog, memMb, copy-mode-guard decision, N>=3 domains, non-DO ingress, funding, front binding deployment, B7 host identity slash-strip); stale rc2 pins in PLACEMENT.md and storage-closeout RECIPE §2; sia-s3 config template 8dc19bf9 superseded by 6e31a0bc.
- Descriptor: enclave-service-descriptor/v1 {operator, kind storage, role storage-indexer, hostId, replica, package pin, applicationAPI advertiseURL, indexd {sha256, capabilities}}; EIP-191 by registry operator; admission(): manifest, descriptor sig, policy on, gate, registry row via gate RPC quorum.
- Host id = keccak(slash-stripped endpoint) (B7 open; my compose/host-services keeps exact bytes in hostServicesPreflight - mismatch to reconcile!).
## Client / front (agent B)
- live 0.1.8 d1ddecfe (catalog idx 7); candidate 00e9cde0929dc7b8726ca4b7b9c9afb51ec4bf6d952039c907c032256ec79afc (source AFTER c218c9fd); never aa15a054.
- vs 2c0e5b06 (harness-block cac66513): i6 42/42 (lease17 fixture), l1 lease16 32/1 (hex pad), replay 34/34 (not rerun).
- Front binding: relay/lease-generation.mjs + isolation/m2 Go; committed 6f2c7da46 (work/native-front-abort, child of main 7752a423), NOT on origin main, NO measured image/deployment.
- Interface: writerAuthority "$ENCLAVE_WRITER_AUTHORITY" (lease16 JSON), instanceIsolation "$ENCLAVE_INSTANCE_ISOLATION"; 20-25 min NOT READY after fresh claim.
- Enrollment sticky (indexd-c2-implementation-interface.txt :15-23, :92-94, :112). Stop 0.1.8 BEFORE first fenced boot (RESULT.json:464). After enrollment no online downgrade; rollback = restore pre-enrollment backup (lose later writes).
- Candidate catalog config R/storage-public-read/candidate-catalog-config.json 7b9e7e75: writeQuorum 2 hardcoded -> T1 N=1 refuses (config.rs:259-264)?? VERIFY.
- memMb undecided (live 2048); copy-mode-guard decision open; adapter S3_ENDPOINT unknown (owner secret).
- Live ids: sia-s3 deployment 0xef514ed3...b238 owner 0x0b2d...eE61 appRef catalog://0x093fa917..75c6/7 runner nucbox; adapter deployment 0x7ae476a3...ce33.

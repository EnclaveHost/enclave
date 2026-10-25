# RPC backend bootstrap — October 25, 2026

**Bootstrap is deployed; the public RPC replacement is not active yet.** No production consumer was switched. The existing Metal0 control, guestd, and custody services were preserved. This directory records the actual deployment adapter and its review/fixes; it is not a claim of a complete decentralized RPC fleet.

## Installed infrastructure

A dedicated ordinary KVM VM on the desktop runs public-chain services. It has 64 GiB preallocated RAM, 8 vCPU and a 66 GiB host cgroup ceiling. The launcher reserves a further 16 GiB of host available memory before starting. No confidential application state is in this VM. It is one operator/one site and remains an availability dependency.

The initial qcow2 images are on `/mnt/usb/enclave-rpc-production`: OS 32 GiB, Ethereum 4,000,000,000,000 bytes virtual, Base 3,100,000,000,000 bytes virtual. Guest data filesystems are ext4. **On October 25 the user authorized the fastest NVMe for chain storage and removed the 250 GB limit.** Phase 1 moves the OS and Ethereum images to the Crucial T710 at `/vm/enclave-volumes/rpc-production`, retaining the HDD originals. At 16:59 UTC the VM is cleanly stopped, the OS copy is hash-verified and qcow2-checked, and the 495.6 GB Ethereum copy is in progress. Base remains on HDD until sufficient NVMe capacity is available. The 300 GB free-space reserve is an operational safeguard, not a new user allocation limit. See [the executed copy helper and evidence](nvme-copy/README.md). No new storage configuration has been activated yet.

Host unit: `systemctl --user status enclave-rpc-production-vm`. SSH config: `~/.local/state/enclave-rpc-production/ssh_config`, target `enclave-rpc`. SSH is key-only and the host key was pinned from the local serial console. Keys/JWTs, disk images, downloaded binaries, and SSZ files are deliberately absent from source control.

Guest clients: Base v1.5.1, reth v2.8.0, Lighthouse v8.3.2; exact SHA-256 pins are in `stage_backend.py`. Services run as distinct `rpcbase`, `rpcl1el`, `rpcl1cl` users. Only the two Ethereum users can read the locally generated engine JWT. Writable filesystem access is restricted to each client's data/temp directories; mount roots and anchor files are root-owned. Snapshot completion syncs data before a root-owned marker, then syncs the marker.

The host exposes only loopback ports: SSH 22850, Base RPC 28545, Ethereum execution 28645, Ethereum consensus 25052. These ports are accessible to host-local processes; this is not a multi-user authorization boundary. No public HTTP listener is advertised. Ethereum transaction gossip is disabled. The installed Base config explicitly enables submission-only forwarding to https://mainnet-sequencer.base.org, from the official Base/node mainnet configuration, and disables transaction-pool backup. Base is not running yet: this is configured, not proven broadcast. A returned hash is not inclusion; consumers must verify the receipt. This retains sequencer dependence and does not implement forced inclusion.

## Current synchronization state and gates

- Ethereum bounded snapshot: `https://snapshots-r2.reth.rs/reth-1-archive-stable-26263563-1792861874/manifest.json`, last 140,000 blocks of transactions, receipts and state history; download about 180 GB decimal. The download resumes and retries under systemd.
- Lighthouse initialized successfully at checkpoint epoch 484635 / slot 15508320, root `0xf87d1dd651c939788e9a0186cbdd15cad7b9ce893a640374725146e15e464cca`. Four source operators agreed. Lighthouse validated the checkpoint and connected to P2P peers. It is awaiting the execution snapshot; this is **not synced readiness**. A subsequent clean stop/start resumed the existing `beacon/chain_db`.
- The initially selected Base snapshot `1792886410`, block 53048526, originally needed about 785 GB decimal download and 1.18 TB extracted. The current profile retains 140,000 blocks of transactions, receipts and state history (about 828 GB download and 1.274 TB extracted); transaction lookup retention is explicitly set to the same distance on both chains. This avoids minimal pruning making recent transaction receipts unresolvable, but it is not archival history. Its download was paused after review found its historical blob requirements predate our consensus checkpoint. Pinned-source review then established that a fresh semi-supernode can backfill columns within the data-availability window. The download is now queued behind Ethereum snapshot completion (Requires/After ordering), preserving partial files. This P2P backfill is not yet proven on the live node; do not equate a moving unsafe head with readiness.
- Base activation is explicitly blocked by `baseBootstrap.coverageVerified != true`. Before changing that field, establish the snapshot's required L1 origin/receipts and actual blob coverage, record evidence, and populate `l1Block` and a real blob-bearing `blobSlot` covering the origin. A healthy recent blob alone does not establish coverage of the derivation range.
- L1 readiness requires matching mainnet genesis/spec, current head/finality, non-optimistic paired execution/consensus, sufficient custody groups and actual reconstructed blobs. Base must subsequently advance **safe and finalized** heads; a current `latest` alone is insufficient.

One-time checkpoint/snapshot downloads use external bootstrap sources. Steady-state chain data must come from the paired P2P clients. No public execution RPC is configured in these client commands. They do not remove dependence on Base's sequencer or Ethereum networking/finality.

## Next activation work

1. Finish Ethereum snapshot extraction, inspect generated prune configuration, start EL and verify EL/CL synchronization plus blobs. Verify retention and receipts at the eventual Base origin.
2. Resolve the Base snapshot/available-blob range mismatch. Prefer a compatible snapshot once the pair is collecting the required data; evaluate any alternative using pinned-client evidence. Do not enable experimental unbounded history or silently use a public RPC fallback.
3. Complete the verified NVMe migration, resume Ethereum catch-up, and finish Base download/sync. Measure steady-state behavior on the actual backing storage. Keep origin/config/manifest receipts; the former cache-only NVMe restriction no longer applies.
4. Retain the composed consumer E2E evidence and independently verified measured image for cutover. Original commit `ec56a70f143cf1bb6bbdd52228401bcf24eca05b` combines verifier support with live registration/fee/custody fixes. An initial four lease-verifier tests passed; seven consumer cases initially skipped without Foundry. After building artifacts, the first real consumer run failed on an obsolete registration expectation and dependent outage cases. A test-only correction now verifies the adopted registry row, proof key and receipt on chain; all seven consumer scenarios passed with external networking disabled. Runtime source was unchanged. The four lease-verifier cases passed in the separate earlier run. These are synthetic-chain tests, not live Base/SNP proof.
5. Configure an authenticated HTTPS proof-serving route and an explicit working transaction path, validate receipt/nonce recovery, and migrate production consumers one at a time with rollback. Do not count one backend at multiple URLs as a quorum.
6. Prove public-provider denial does not stop required features. Preserve all smart-contract administrator controls. Historical logs/receipts outside the chosen retention horizon and log completeness require explicit validation; this is not an archival-RPC claim.

The download and chain units are installed on the new VM. Ethereum snapshot/CL/EL-path units are enabled. The Base snapshot unit is enabled but its start job waits for the Ethereum snapshot service; the Base client path unit remains disabled pending coverage verification. The host VM unit is currently stopped for the NVMe migration and is not enabled for unattended host startup; safe host reboot ordering and sufficient RAM must be resolved before treating this as an unattended production service.

## Recovery and rollback

No live consumer configuration changed, so current rollback requires no wallet signature and no app migration. To stop a chain client, first stop its corresponding `.path` unit or it can be restarted automatically while its marker exists:

```sh
sudo systemctl stop enclave-base-holder.path enclave-l1-el.path
sudo systemctl stop enclave-base-holder.service enclave-l1-cl.service enclave-l1-el.service
sudo systemctl stop enclave-rpc-base-snapshot.service enclave-rpc-l1-snapshot.service
```

**Shutdown defect found October 25:** the installed v1 launcher's QMP wait fails after a socket timeout, causing systemd to terminate QEMU early. Do not rely on host `systemctl stop` for a clean stop until the tested fix is installed. Instead stop the guest clients/path units first, then request `sync; systemctl poweroff --no-block` inside the guest and verify clean unmounts plus host MainPID 0. That recovery procedure was completed before copying these images. **Stop it cleanly before rebooting the desktop**: the enclosing user manager has a shorter default shutdown timeout. Do not kill QEMU, remove images, reformat disks, use snapshot `--force`, or remove partial files as routine recovery. On download failure, inspect its journal and restart the corresponding snapshot service; resumable chunks are verified/reused. After any unclean stop, inspect filesystem/client integrity before trusting completion markers.

A future consumer cutover must keep its previous measured image/config and additive relay allowlist until smoke tests pass. Reverting consumers to public providers would restore the old dependency; it must not be reported as successful replacement. Blockchain writes cannot be undone by changing a config.

## Reproduction and validation

`provision_vm.py` is the desktop-specific provisioning source, not a generic fleet installer. Migration changes under review are not necessarily the installed version; the installed manifest pins its launcher hash. Its `prepare` refuses existing paths; do not rerun it against this deployment. It expects the original `work/` input layout and pinned Ubuntu image. The installed launch copy/manifest remain under the POSIX state directory. `stage_backend.py --binary-dir DIR --out NEW_DIR` accepts a directory containing the three pinned client files. `stage_node_units.py --sequencer-forwarding --anchor evidence/anchor.json --observations evidence/l1-finality-observations.json --out NEW_DIR` renders public config and units. Use a newly confirmed checkpoint for a fresh bootstrap, not this historical one. Install scripts deliberately refuse an existing config: a partial install must be inspected and completed explicitly; do not delete keys to retry.

Fourteen adapter regression tests passed, including wrong/read-only volumes, stale/optimistic state, missing blobs, expired fresh checkpoint refusal, existing-database recovery and Base coverage refusal. These are mocked unit tests plus the separately observed live CL restart; they do not establish Base production readiness. Run via the workspace memory guard while respecting its host reserve. The included initial review is historical: account isolation, durable markers, retrying downloads, narrower writable paths, startup ordering, reduced client caps, prune checks and readiness gates were subsequently addressed. Blob-range availability and end-to-end production cutover remain open. The follow-up source review in evidence/claude-blob-options.md corrects the initial review's absolute claim that older columns cannot be recovered: fresh semi-supernode P2P backfill supports them inside the availability window, but live proof is still required.

The measured control image at runtime commit `ec56a70f143cf1bb6bbdd52228401bcf24eca05b` was built and independently checked. Measurement: `c24429415c85fca9d55cd9ba9b6f2337579d59c6ea2f2bd66656302ac0f96afd0193534f1ac38c3882b32acf9c0744f7`. Initramfs SHA-256: `7848676bf806ee03ca27634ac48481d6d48d6c6d002642c87278c4d5e3ada34c`. It is staged at `/home/steven/enclave-prod/dist-rpc-ec56a70f1` and has not replaced the live control image. Test commit `9fa02e1bc` differs only in the consumer E2E file, with runtime bytes unchanged. Subsequent changes to the consumer branch were tests only.

Host shutdown prerequisite: the enclosing `user@1000.service` currently allows only two minutes. The prepared `90-enclave-rpc-shutdown.conf` raises it to 45 minutes; installation under `/etc/systemd/system/user@1000.service.d/` and `sudo systemctl daemon-reload` require local sudo authentication (noninteractive sudo refused). It has not been installed. Do not restart the user manager. Until this is resolved, stop the RPC VM cleanly before rebooting the desktop.

Official submission endpoint reference: https://github.com/base/node/blob/main/.env.mainnet (checked October 25). This endpoint is never used for reads, proofs or fee estimates by this adapter.

## Live consumer inventory — October 25, 12:10 UTC

The active Metal0 network agent (release808f691d0) has no hostServices configuration yet. Its registry identity is `0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be`, derived from its registered endpoint. The active control image is `dist-leasegas-deabf8f90` with no chainVerifier member. HTTPS proof serving and the staged verifier image have not been activated.

Metal0 currently sends app-funded leases to `https://134.209.248.172`, whose eu-central lease relay is running. The proposed host-local port8549 relay does not exist on Metal0. Minipc's earlier local-relay migration is a separate installation. Replacing public RPC reads in the control guest alone therefore cannot complete the lease path: the actual relay's authority and broadcast path, and its intended host placement, must also migrate. No relay key or service was changed during this inventory. Public whitelisted receipts are in `evidence/live-metal0-*.json`.

## Bootstrap update — October 25, 16:01 UTC

Ethereum's snapshot completed at15:21 and its client is executing the remaining blocks. Lighthouse reached the current head but remains execution-optimistic. Base's ordered download is running (about4.1% at15:59). Neither chain has passed production readiness; no consumer was switched.

Corrected a live startup defect: specifying only the transaction-lookup prune flag caused both pinned clients to overwrite the entire snapshot retention profile. The launcher now passes all validated settings. The exact damaged Ethereum profile was repaired, with its original bytes retained, and the first controlled restart preserved all settings and file ownership. The native process reported a shutdown timeout warning before exiting successfully; startup reconciled its interrupted indexing range and resumed execution. See prune-recovery/logs/prune-live-recovery-1556.json and prune-recovery/REVIEW.md. A second live restart awaits catch-up; the two-client offline restart tests passed.

The source-only L1 authority experiments are explicitly not production authority. Their root review records the unapproved trust changes, missing binary provenance and successful-sync gates. Detailed work continuation is in evidence/continuation-1601.md.

## NVMe migration checkpoint — October 25, 16:59 UTC

The HDD sustained only about 30–35 random reads/s during execution, with roughly five minutes per block despite ample guest RAM. The copy is offline after clean recovery; its OS SHA-256 is `9a71081601d2a9820e422d6347736c93b98526d74a715a4a48074bdb79f33b2f`. Ethereum copy completion, target verification, launcher/guard installation, restart, and synchronization remain pending. A copied snapshot or current unsafe head is not a completed RPC replacement. Existing apps, administrator controls, and the 16 GiB host memory floor are preserved.

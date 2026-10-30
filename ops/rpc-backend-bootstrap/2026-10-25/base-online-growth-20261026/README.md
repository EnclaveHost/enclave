# Base disk capacity growth, 2026-10-26

The running RPC VM's Base qcow2 on the USB RAID grew online from 3.1 TB to 4 TB. The whole-device ext4 filesystem grew successfully to 3,997,580,632,064 bytes, with about 3.31 TB available. Its serial, UUID and file inode were preserved. VM PID 3695222, capacity guard PID 3695221 and downloader PID 4061 stayed unchanged; downloader restarts remained zero. No application or VM was stopped. This prevents a tight extraction/history headroom case; it does not improve network download speed.

The live boot manifest, cloud-init seed inputs/ISO, guest disk identity configuration and both systemd unit manifest pins were reconciled. The full provisioner's read-only verify command passed. Units were daemon-reloaded but neither VM nor guard was restarted. The running guard keeps its old manifest in memory, with exactly the same NVMe capacity policy; the new pins apply on the next normal coordinated boot. Do not restart the guard alone: the VM binds to it.

The metadata script's first postcondition mistakenly queried enclave-rpc-production.service instead of the actual enclave-rpc-production-vm.service. The correct names were subsequently read from the manifest and both original PIDs verified active. No resize or metadata mutation was repeated. The script here uses the corrected names.

Pre-change metadata and seed ISO are retained locally at ~/.local/state/enclave-rpc-production/backup-base-growth-20261026T0536. Do not restore the old 3.1 TB manifest over a 4 TB disk; that would fail the startup identity checks. Do not shrink the filesystem/image to roll back this capacity increase. Existing disk recovery copies remain untouched.

The scripts are one-time guarded operations with exact old-state assertions, not automatically rerunnable maintenance. Public configuration and bounded receipts are saved here; SSH private keys and disk/ISO binaries are excluded.

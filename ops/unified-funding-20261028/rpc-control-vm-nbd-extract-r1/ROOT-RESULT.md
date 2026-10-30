# Private NBD client ready; no disk attached

Exactly one root-admitted attempt133b81fa7a4c4faebbeb0e8c29ee1435 completed0/Main0. All9contentpins unchanged and no scope processes remain. Remote receipt PRIVATE_TOOL_READY_NOT_ATTACHED/no errors, no timeout/truncation/cleanup errors. Inner40MiB/outer108MiB/minhost30303.

Fresh private directory /home/controladmin/rpc-nbd-tools-20261030-r1 contains the43644byte signed-repository archive, selected56376byte binary and receipt. Ubuntu2018 archive signature F6ECB3762474EDA9D21B7022871920D1991BC93C verified; signed index and exact archive hashes verified. Binary SHA2560a256b67962d1ffc1ab8bacecd4319b8e459a0535467abb66f83329ce5221167. Actual loader--list resolved13 library records with installed package/version/file consistency plus SHA256. Actual -h output onstderr reports3.26.1 and Unix mode-u, timeout-t, nofork-n, nonetlink-L, disconnect-d. No system package/maintainer script/module/attach/mount/client/service/allocation change.

After normal success, peer raised a source-review edge case: on pre-existing same-UID destination with no receipt, error cleanup could write RECEIPT into it although mkdir refused. Root had already executed the fresh successful-mkdir path before HOLD arrived. No executed source/pin changed; preedit guard refused. Preserve finding for a future separate version; do not rerun this completed invocation. This issue does not describe the observed fresh successful path.

Next native fixture remains unadmitted: disposable image only, private authenticated StreamLocal transport, finite helpers/guard, exact single-writer/UUID, durable reopen and controlled disconnect/cleanup evidence. Use actual tool/library hashes and help; do not claim production RPC readiness from dependency extraction.

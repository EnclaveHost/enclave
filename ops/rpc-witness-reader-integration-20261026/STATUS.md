# Witness sandbox and reader composition: qualified integration inputs

The disposable witness fixture passed on the running RPC VM. Its real systemd sandbox, method allowlist, socket mode refusal, recovery after mode restoration, and cleanup passed. Production PIDs, service states and configuration identity remained unchanged. This used a fixture socket, not a real execution-node socket or chain witness. Ten offline fixture tests also passed.

The composed runtime tree is 1df125598825fb5278fe6af96a50a69b46679a1c, built from candidate 64156dcd91ff1e769e74f9c26a846be19254c716 plus exactly 27 additions from c66b087acca2bed00e0232f97f990a201852faea. The saved patch reproduced the composed tree. All 20 reader/bridge tests passed with zero failures, skips, cancellation or todo. Import closure and module loading passed. Tests use transport fixtures; they do not prove positive native derivation or SNP qualification. Production defaults were not changed.

The composition intentionally excludes unrelated lifecycle changes. The v3 authenticated event-history journal and lease writer still need integration, followed by actual Base proof, accepted SNP image, mined transactions, public-RPC blackout and cold recovery checks. No production cutover is claimed. Administrator controls remain preserved.

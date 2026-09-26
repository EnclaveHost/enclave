Box-only evidence copied to ws by enclave-d1 for DEPLOYMENT.md (enclave-87's DONE audit, 2026-09-26). The reads were read-only (scp from the box).
Copied 2026-09-26T07:38:18Z (read with date -u; copy-time.txt holds start and end).
- node.log = box C:\Users\claude\vbs-like\hvnode\logs\node.log as of the copy (1485 lines). The live file keeps growing, so this sha is for this copy only.
- ui-out.txt = box C:\Users\Public\enclave-tray\ui-out.txt (E8's restoring run; tray log lines for both sets).
Line ranges (sed -n 'a,bp' of the copy, byte-identical):
- node.log.L59-84.E5.txt (E5): `ledger: taking 0x31136008` at 00:58:28, 00:58:57, 00:59:27, 00:59:57 and 01:00:27; `claimed 0x31136008 (tx 0x0340540e…)` at 01:00:29; then `isolation: hasSecrets … not known` every 30 s from 01:00:31.
- node.log.L1-50.E6.txt (E6): 013deb51's first minutes. It holds the ONLY two `card price now` lines in the whole copy, at 00:55:04 (line 14, tx 0xe4368ba9…) and 00:55:33 (line 39, tx 0x79ebd389…).
- node.log.grep-price-and-starts.E6.txt (E6): `grep -n` over the whole copy for every node start, listing and card-price line. Node starts after the fix: 01:28, 01:31, 01:33, 02:04, 02:51, 03:34, 04:58 and 06:03. Each listed `price 12/sec cpu` and sent no card price.
- node.log.L578-800.E16.txt (E16): 0x2947's delegation took effect at 04:23:08 (the owners changed, re-attach). Then `ledger: taking 0xca141665` came every 30 s from 04:23:10 (line 586) to 04:58:10 (line 774), 71 lines. It starved ID2 0x958ae6e9, created 04:23:44-04:24:05Z (test2/step2-deploy.txt). Then 317b3152's first pass: `not taking 0xca141665` 04:58:50 (792), `considering 0x958ae6e9` 04:58:51 (794), `claimed 0x958ae6e9 (tx 0x490bdf4e…)` 04:58:53 (796).

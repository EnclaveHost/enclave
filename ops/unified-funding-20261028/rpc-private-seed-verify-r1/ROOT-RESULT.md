# Private RPC seed integration and actual guest schema qualification

Source was corrected after a real installed-schema rejection. Empty
ssh_genkeytypes violates minItems; the supplied ssh_keys branch bypasses automatic
key generation, confirmed by reading the actual installed module. The corrected
source omits the invalid setting and retains the same owner credential identity.
No key rotation, replacement, public private-key output or failed-artifact deletion.

Original private artifact build8735e10a5e074dcbaa74ae188369f9b1 was terminal1,
4.302s, seed created but schemaExit1. Original stdout was not retained by the
legacy local wrapper on nonzero; authoritative private PUBLIC-RESULT.json was
recovered by separate read-only inspection. No invented compiler/runtime error.
Schema diagnosis d5beed3da776470c8eaafd36474d122a returned only error paths/types,
never user-data or secret values. Failed candidate remains on Control.

Corrected actual build0c9c687fb15a4bf387675750b237b20e terminal0/3.083s:
13,185,024-byte private ISO,36files, SHA256
91726e56471a3acc47989de62e20af38ee44e7420094b2b60f90a895d2c5a696.
Control output: /home/controladmin/rpc-private-seed-repaired-99bc1230aedd431389d9ef8c15601e64/output.
Credential bundle remains in the original protected root; do not publish/copy into
Git the bundle, ISO, user-data, extracted data or raw schema diagnostics.
The corrected renderer did not generate any replacement key.

Independent verifyf3f71f74318f41c18647a0fe28138e38 terminal0: whole ISO hash/size,
all36file records, private modes, every client/SSH key pairing and no issuer/server
keys in guest material; exact runtime source pins; unchanged source root.ext4
metadata. Actual prepared-guest schema read with pinned debugfs in read-only
catastrophic mode: e9bff937d90de84570eda8728f8a127b59a6d5f4ef84b6c358230dc137b33f49,
zero schema errors. Installed cloud-init CLI26.1-0ubuntu1~24.04.1 also passed.
Source regression80e9ad74966b42819be394c878e50435:15PASS/.883s/7pinsunchanged.

Remote artifact work was independently bounded by120s user-controladmin units,
128MiB/noSwap/CPU1/private network; fresh same-boot7.275GBavailable and99.723GBdisk,
continuous2GiB+128MiB memory/16GiB disk guards. No global package/service/VM changes.
All local256/220/floor27648 bounded jobs are terminal. No completed helper replay.

Attachment scripts and static units are now in this candidate. No live attachment
contract, server-ready receipt, cloud-init first boot, kernel mount, chain client,
RPC readiness, export or Windows allocator cut has been executed. Source and
artifact qualification are not the measured20GiB fit or full decentralization.
Storage-host Warden admission remains short2040MiB under the retained floor and
running-guest growth obligations. The pending user question about closing an unused
Warden application remains unanswered; no unrelated workload was stopped.

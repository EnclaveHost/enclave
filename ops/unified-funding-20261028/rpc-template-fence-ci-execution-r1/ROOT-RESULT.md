# First template fence qualification: FAILED, preserved

CI41167423437 at c4b51473bb1fcb3b852fe31b7743cd884f88967e compiled1597ms and reached3PASS: durable deny/readback, content read+copy refusal after handle closure, and fresh compiled child denial. Harness original9s watchdog exited124 at9224ms while the newly spawned PowerShell probe was outstanding. Both exact compiler/harness processes terminal; harness private job kills its bounded child. No proof of which PowerShell stage blocked, no attribution to memory/OOM, no claim of PowerShell success. All13compiledsourcepins and binary independently recomputed. Original artifact retained; never rerun completed CI.

Next changed fixture adds bounded stage markers and earlier child cleanup budget within unchanged original9s harness deadline so failure can identify startup versus hash/copy and report exact local death. Production class unchanged; no limit extension/cap raise or native target action.

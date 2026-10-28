# Current runtime corrections

The earlier AUDIT.md is an exploratory report and contains stale assumptions.
Live guestd arguments identify Qwen release `5cab66e478a78adf69c5bb6f058117fcd91cddfb72ca3f6c5d47c109cc47ba17`, backend SHA256 `74e834bfbca0ff06ed98ef5af658cb9f0520b8557222b75a1933c3426b953c9e`, init `dffd093b8458e109c64756c26fe5efd8b8226da712fb03a81f28d50aaa27cb0b`. The installed isolation contract uses a 51200 MiB Qwen minimum. Current requested guest allocation remains 64281 MiB plus 768 MiB overhead.

Its release manifest enables compact weights, original-source reclaim, encrypted pad spill, native CPU pools and RAM admission. Preserved Qwen boot serial records a 58086 MiB dynamic budget and 512 GiB spill device. These are configuration observations, not new live RAM benchmarks.

Candidate source is sdshield aa3b780ae. Current Qwen source appears associated with padgov4c716378a; exact binary reproducibility not established. A narrow patch port must retain its spare-CPU spill governor and qualify current Qwen behavior. Candidate source must not replace production wholesale.

Historical reports of 52.57 GiB resident memory and earlier 4.5% decode regression describe old qualified releases, not this candidate. New savings and throughput remain unmeasured.

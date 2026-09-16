The retained 27B Q8 run sent **8.601 MB per generated token** from the phone to the worker and received **17.732 MB per token** back. These are differences between the actual prefill and final inference counters over 16 generated tokens, using MTP k=3 with 9 of 14 drafts accepted.

At the same traffic and acceptance per token, 20 tok/s would require:

| Direction | Inference payload rate |
|---|---:|
| Phone to worker | 172.022 MB/s |
| Worker to phone | 354.650 MB/s |

These rates exclude pad replenishment, protocol operations other than FIELD_GEMM, packet overhead and local compute. They are required rates under this recipe, not measured speed or a prediction that the route can achieve 20 tok/s. The two directions should be assessed separately; adding them and comparing to a single-direction link rating can misstate a duplex link's limit.

The pad shipment format separately carries three bytes per output-mask value plus a 16-byte authentication tag per group cell. Random input masks are regenerated from the shared secret seed. A pad stockpile removes that shipment traffic from a short decode window; it does not remove the long-term replenishment requirement. Exact steady pad traffic also depends on which groups and indices are consumed and how shipments are batched, so the aggregate pad-use count is insufficient to calculate it by itself.

This is a 16-token, ctx1024 sample. Different text, speculative acceptance and batch shape can change bytes per generated token. The next actual 27B run will retain an independent host frame trace to reconcile these counters.

Evidence: [counter calculation](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/27b-transport-budget.json). Units above are decimal MB.

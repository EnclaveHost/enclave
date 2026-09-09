`ANCHOR_HEAD_OWN_POOL=1` gives the MTP head its own persistent pool even when
`ANCHOR_DRAFT_AHEAD=0`. `ANCHOR_HEAD_THREADS` controls its size, and the existing
CPU polling override applies. The flag defaults to zero and accepts only 0 or 1.
Missing pool APIs or allocation failure abort the requested configuration.

This allows an isolated test of disabling background draft-ahead work while
retaining the two-thread head pool used with draft-ahead enabled. Ordinary MTP
drafting, target verification, acceptance, and head observation are unchanged.
Without this option, disabling draft-ahead also attaches the head to the target
pool, which can change the effective head thread count.

Four profiled 27B Q8/MTP5 trials used zero background chains. Source execution
still schedules four six-step background chains for that prompt. Removing those
24 head steps should reduce offloads and traffic, but throughput and output
equivalence require a complete inference comparison. This is not evidence that
draft-ahead is unhelpful for other prompts or models.

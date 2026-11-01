# Provider event reader API correction

Hosted run 41269703308 on 904840c78a134704bfe69b6e87a024fdb455d504 failed the first compilation: CS1061, EventLogException has no ErrorCode property. No fixture or event reader executed. Original logs and pins retained.

Use public Exception.HResult and name the serialized field ErrorHResult explicitly. No time, process, memory, output, channel or operation scope changes. Fixed source requires fresh hosted qualification before target staging.

Correction to r1 review: the private 128 MiB Windows self job enforces commit and CPU limits; it does NOT disable Windows paging. Linux orchestration separately uses MemorySwapMax=0. Bootstrap allocations remain outside the post-assignment hard bound.

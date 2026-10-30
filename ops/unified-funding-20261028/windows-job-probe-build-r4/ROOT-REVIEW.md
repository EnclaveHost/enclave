# Local Windows job receipt probe build — not Windows qualification

The revised proposal records numeric limits, raw failure errors, process identity/creation, accounting and allocation recovery without attributing every error to Job enforcement. Its qualification flags remain false. Root reviewed the seven pinned proposal files; none were changed.

The first bounded local crosscompile failed to link because compiler-generated structure initialization required memset. The failure is retained. A separate local no-CRT volatile byte-loop implementation supplies only that compiler support symbol; the proposed probe source is byte-identical. The second build succeeded: AMD64 PE, 9216 bytes, SHA256 6c8d02e90b5596122095021d9a51f6b77d11487f1610e2f32eca84010a0f660b. Imports are kernel32 only. Neither binary was executed or transferred to Windows.

Both local units are terminal/MainPID0. Bounds: 256 MiB hard memory, 220 MiB tree RSS guard, 27648 MiB available floor, one CPU, no swap, 90-second outer lifetime. The short builds completed below the guard sampling interval: reported 0/n/a is not a zero-resource claim. Existing clang-cl/lld/Wine public headers/import library were used; no tools were installed, and no Wine execution occurred. Input pins do not constitute a complete reproducible transitive header closure; linker timestamp is not normalized.

No Windows Job, inheritance, owner-death, EXLOCK or deployment qualification follows from the build. Actual future execution needs fresh pending/admission accounting, exact disposable staging/cleanup, readback and independent assessment. An unknown error remains unknown. The separate owner-death observer needs its own accounted budget. No production/service/app/financial mutation occurred.

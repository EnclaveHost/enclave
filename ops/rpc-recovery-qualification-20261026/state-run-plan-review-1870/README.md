# State-runner integration planning — no implementation or runtime qualification

This source-only planning work identifies reuse of the existing read-only multipart exposure and memory guards. The initial plan has defects documented in the root review; the independent review further qualifies the intended implementation. Neither a plan nor a review is a runtime acceptance receipt.

Required boundaries include a fixed, verified production validator command; actual build and fixture provenance; conservative state-result classification; final evidence and cleanup that can invalidate a seemingly usable outcome; and bounded read-only extraction from the preserved compact backup. The root review's refinement distinguishes synthetic empty-plain-table expectations from production v2 state invariants.

All 265 recovery parts, structural database checks, compiled state tests, actual state validation and independent canonical authentication remain necessary before recovery acceptance. USB writes, paused downloads and the RPC VM remain paused. No original, part or compact-backup contents were read for this planning work.

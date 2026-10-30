# Root clarification of review1580

Read actual frozen r10 subtree.py require_writer_check (lines1017-1030). It enforces complete, no hits/hitsTotal, no source/retire aliases, freshness/prefix and source target present. It DOES NOT enforce destAliases or fsWatchers. The independent review1580 cutover verdict says it does; that sentence is inaccurate. The r10 author's report correctly says these are informational for cutover and blocked by reclaim.

Root can impose the stronger manual gate before offering any cutover: inspect complete fresh root scan and require no destAliases/fsWatchers as well. This preserves source/retire copies; no source change is needed merely to implement that stricter procedure. Reclaim r4 must enforce both in code and remain separately tested/reviewed. Never label a reviewer claim as actual code evidence.

The apps-stopped-attestation argument is an operator statement only (>=8 nonblank characters), not an automated freeze. It must name actual held/stopped users or documented unused cold trees based on evidence, and must never falsely claim all apps stopped. Existing production apps must stay running unless separately coordinated. No scan or cutover has occurred.

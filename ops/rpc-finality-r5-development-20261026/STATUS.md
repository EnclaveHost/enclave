# Development checkpoint: not qualified or deployed

The r5 operational finality source is preserved here to prevent work loss. It has NOT passed qualification and is NOT activated. The r4 independent review identifies security and lifecycle gaps; r6 work is addressing those against the actual r5 implementation. Administrator controls remain intact.

Actual r5 results so far: tool 28/30 (two failure-order/fixture assertions); integration failed setup due to a missing /opt/enclave-rpc/manifest.json fixture; sampler 90/91 with one missing coverage/origin_extract.py dependency; reanchor recovery 38/38 passed. The runner incorrectly expected24 tests in that suite; inherited test cases account for the difference. Raw results are retained, and the overall job is not passed. r3-regression and wrapper suites were still running when this checkpoint was saved. Do not treat absent results as successes.

The sources also lack complete validated unattended recovery/activation wiring; the report explicitly identifies unfinished steps. No claim is made that describing a recovery procedure implements it. Prepared flags remain false. The stage contains absolute paths to the original qualification workspace and depends on previously preserved pinned modules; it is not a standalone deployable bundle.

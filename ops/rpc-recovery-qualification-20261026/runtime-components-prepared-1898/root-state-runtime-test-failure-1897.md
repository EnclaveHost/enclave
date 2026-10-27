# State runtime r1 actual test result: 13 pass, one source assertion false positive

Actual spv-r1-tests ran14 and exited1; receipt/run state-production-validation-stage/r1/runs/tests-20261027T110224Z-3118590. test_13 asserts the substring `fixture` is absent from the entire job after removing `memory-fixture-stage`. The guard message `a memory-fixture stage mount exists` triggers it. This does not establish a fixture-execution path. Keep the failing result, do not claim suite PASS.

Next revision should assert the actual invocation/argv does not admit fixture flags or override commands, with positive and negative examples, rather than blanket prose substring matching. Preserve the legitimate live-memory-fixture guard and its message. Integrate this correction with the pending real capture/extraction provenance wiring and review, not a frozen-stage mutation.

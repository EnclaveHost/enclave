# Tested procedure; native receipt v2 and live scan remain pending

Actual isolated baseline passed40+2+1 Python tests and8 Node tests, zero skipped. All33 inherited negative controls were killed by assertion failures. The seven new bytecode binding tests cover malformed counts, missing code, wrong/untrusted executable, ordering, empty or incomplete receipts and stale database/journal bindings. New v2-specific mutation controls have not run.

The source pin BYTECODE_CHECKER_V2_SHA256 remains None. Consequently these results cannot close the bytecode gap or authorize production activation. Native receipt-v2 work, its tested release pin and the real stopped-database scan are still required. The native-v2 implementation proposal may use a different explicitly documented digest algorithm from this prepared document; bind the final format to the reviewed executable pin.

# HOLD: recovery state integration review

The acceptance r1 pure predicates passed 38 unit tests, but independent review found missing database/argv binding and native evidence normalization gaps. Do not integrate r1 final-state acceptance as a production runner without corrections.

The capture r1 implementation is archived for preservation, NOT approved for execution. Its documented B1/B2 workaround runs outside the required read-only home/tmp namespace and permits root-side evidence writes. Root rejected that workaround; prepared capture unit tests have not run. The corrective tasks retain the existing frozen artifacts and require explicit NVMe work/output directories and the reviewed namespace confinement.

No compiled fixture, production state or canonical acceptance is claimed. Original USB writes, downloads and RPC VM remain paused. Namespace qualification for r11 ended with signal status143 before admission (no receipt); it is not a pass. The forthcoming r12 requires its own qualification; do not duplicate the obsolete queued test.

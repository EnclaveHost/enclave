# Recovery fixture correction

r2 actualrun072918 failed because it called the read-only exact command `stage unwind --help` mutating. The product correctly refused state_below_anchor before any DB mutation. r3 permits only that exact tuple with purpose help, positively asserts it occurred, and still rejects every A.MUTATING purpose and every other unwind command. Production bytes unchanged. Prepared; root run required.

First rootrun073020 failed parsing due to wrong inserted indentation; no test ran. Corrected before final freeze; originalmanifest and rawfailure retained under logs.

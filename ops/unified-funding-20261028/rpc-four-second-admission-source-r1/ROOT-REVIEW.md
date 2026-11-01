# Root review

User explicitly requested: “Change the guard to 4 seconds and keep going.” This supersedes historical instructions prohibiting extension of this aggregate two-second check. Scope is only WindowsStartAdmission aggregate freshness. Other deadlines and narrower resident freshness remain unchanged.

Reviewed exact diff: named constant4000, diagnostic four seconds, three existing boundary/invalid-clock/diagnostic tests updated. 3249ms historical failure duration and exact4000ms accepted;4001ms refused. Nonnegative origin and monotonic ordering precede subtraction, preserving overflow safety. Capacity/pending, current observation reads, authority, original deadlines and provider settlement unchanged. No listener reuse or unrelated optimization included. Source fixtures are not target qualification.

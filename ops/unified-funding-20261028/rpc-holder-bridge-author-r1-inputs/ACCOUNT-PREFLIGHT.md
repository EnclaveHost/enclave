# Root's current-account preflight plan — NOT RUN

Root reviews the final PREPARED digest and supplied scripts first. root-preflight.py requires that exact digest as its sole argument, exactCPU1, all prepared/source/seed hashes unchanged, no prior attempt/started/output/approval in this NEW package, and the pinned nonsymlink executable. It refuses if any same-user instance of the exact reviewed Claude executable is present (including unreadable CWD), to avoid knowingly overlapping the previous refresh conflict. It does not stop another process.

It then makes ONE bounded `claude auth status` call and retains only loggedIn/email/subscriptionType, requiring steven.r.batchelor@gmail.com and max. No credential file, token or environment dump is read. This authenticates account selection only, not API refresh success. A rejected/error result is terminal; no retries/login/logout/account switch. Root owns any subsequent recovery decision.

Proposed independent preflight envelope: shared queue,256MiBhard/220RSS/27648availablefloor/CPU1/noSwap,90souter/20sauth. Root must review actual helper dependencies/current capacity and pin the actual invocation before executing. There is no automatic preflight command execution in preparation. If root chooses to admit the author, it writes root-author-approval.json binding PREPARED SHA and launchAuthorized=true; the unchanged author runner performs a second independent bounded account check before source work. Do not copy a prior account-verification as a fresh result.

No credential repair, API health prompt or new author is authorized by the existence of this plan. If API refresh fails after preflight again, preserve evidence and stop that invocation; do not delete its exclusive attempt marker to rerun.

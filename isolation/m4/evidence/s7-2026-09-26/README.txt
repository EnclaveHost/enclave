S7: guestd's -isolation tree switch to the HARDENED release f7888d86 (image b63c2def: dominit holds yama ptrace_scope 2,
user.max_user_namespaces 0, kernel.io_uring_disabled 2 and drops the app's privileges, on top of 52156652's console guard;
enclave-53's build). Derived from the RUN S5 set (diff-from-s5-*.diff); bf GO on v1-v3 (bf's post-switch guard: the switch
records its epoch, fl-check HOLDs a guest created after it on any other release, the rollback clears it; bf's fix: the
epoch write fails into the rollback). Sources lib-e5 (the canaries' current keys), lib7 LAST.
RUN: e3's rs-7 admitted f7888d86 beside 52156652 (03:11:04Z, predictions = enclave-63's independent pins); s7-install
(03:11:32Z, inert, verified + reproduced); adoption preflight 3/3 (03:11:41Z); s7t-apply-20260926T031227Z rc 0: guestd
restart 03:12:39Z, -isolation iso-4cdd5169 -> iso-b63c2def, the 3 canaries re-adopted on 52156652; gate 6 rounds over 617 s.

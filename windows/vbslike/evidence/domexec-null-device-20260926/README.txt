domexec's null device (isolation/front-console-guard 683798d0f): an independent reproduction by enclave-b4, 2026-09-26.
Run on warden-host at 2026-09-26T03:01:40Z, UNPRIVILEGED: nothing here is a box or production result.

How: domexec built static (gcc -static -O2) from 683798d0f (the fix) and from 4cdd51692 (the control). Each ran as PID 1
of a new pid/mount/net namespace in an unprivileged user namespace with a subuid map, so setgroups/setgid/setuid really
happen:
  unshare --map-root-user --map-auto -mpfn -- sh -c "exec chroot <root> /plat/domexec 7 1000 app 64 3<>/dev/null"
<root> held only plat/ (domexec, and fdlist.c built static as both /plat/front and /plat/rt/ld-linux-x86-64.so.2),
run/ (1777), tmp/ and proc/, and NO /dev: the shape of an m3 domain's chroot. The control gets no fd 3 (4cdd5169 opened
/dev/null itself). fdlist records its own descriptor table to /run/fds-<role>-<pid>.txt, then prints a marker on its
stdout and stderr.

Results:
  console-fix-683798d0f.txt       the runtime ran; its markers are ABSENT from the console (its stdout/stderr are the
                                  null device); the front's markers are present (the front keeps the console by design)
  fix-fds-runtime-2.txt           the runtime's fds: exactly 0, 1, 2 = /dev/null (rdev 1:3); no fd 3; uid 1000
  fix-fds-front-3.txt             the front's fds: 0-2 only (fd 0 is this shell's stdin; 1 and 2 the console); no fd 3
  console-control-4cdd5169.txt    "DOM7 ERROR runtime exited status=126": d1's canary failure of 252602c8, reproduced
  control-fds-front-3.txt         the control's front table (the runtime never ran)
  dumpprobe.c                     the probe for 139c3fdd4 (the front non-dumpable): run the same way, a non-dumpable front
                                  still read its own and the runtime's maps, and a same-uid runtime was refused the
                                  front's maps, fd links and pidfd_getfd; with a dumpable front (control) it read them
Scratch paths are shown as <scratch>.

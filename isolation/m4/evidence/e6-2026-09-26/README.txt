e6: the 3 canaries relaunched from their 52156652 release guests onto the HARDENED f7888d86 (derived from e5 v4;
diff-from-e5-*.diff; bf GO, bf recomputed the pins from its own worktree). Proof 2 = the pinned independent value
(expected-measurement.sh --pin f7888d86) = the relay's prediction; NEW proof 7: the serial's hardening holds
(yama ptrace_scope -> 2, user.max_user_namespaces -> 0, kernel.io_uring_disabled -> 2) and no "DOM ERROR refusing to start";
proof 6 (hookbin's HEAD) as a regression check of the console guard.
  0ddbd824 restart 03:24:07Z -> gdf9a0c247 a0101960... ACCEPTED 03:42:51Z
  395bed3e restart 03:43:25Z -> gda1fa6b24 4bfae407... ACCEPTED 04:01:48Z
  4e62e60d restart 04:02:18Z -> gdcc11046d 4bfae407... ACCEPTED 04:19:51Z
Proof 7 in each: "yama ptrace_scope=1 -> 2; user.max_user_namespaces=342x -> 0; kernel.io_uring_disabled=0 -> 2".
Certificate issuance needed 2-4 node retry passes (~7-8 min), slower than e5's 1-2.

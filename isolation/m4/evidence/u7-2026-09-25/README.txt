U7 (relay eligible routing) rollout: enclave-63 executes 5d's U7-ROLLOUT-PREFLIGHT.md rev 5 section 7 (d1-reviewed) with
e3's converged commit 2144fcb3 (relay/u7-converged; single parent main aeb345e6; relay/ = fc90d6b5; d1 APPROVED). Codex:
Steven's standing restoration authorization, after the concrete preflight and review. Nothing has run yet.
  u7-1-env.sh      nan-relay: ELIGIBILITY_API on tcp6-relay/udp-relay/dns (inert), chmod 600 on the four data-plane env
                   files (REQUIRED: dns.env holds DNS_TXT_KEY); backups; no restart
  u7-2-push.sh     the fast-forward push (main must be aeb345e6; relay/ = fc90d6b5; only relay/ + test/; 5d's relay.js/fleet.mjs
                   hashes); Deploy must be detect+relay only, relay=true only, nan-relay only
  u7-3-smoke.sh    nan / nan-relay smoke (the journal eligibility lines, NOT "unset"; the canaries 200 via nan-relay with no
                   U7 refusal line; /x/ 421 and 404; availability; no repeating "U7: closed"; via us-west still 200; the
                   relay slice's accept.sh)
  u7-4-uswest.sh   us-west by hand (the `us-west` alias): *.pre-u7 backups, fleet.mjs FIRST then relay.js (temp + mv),
                   hashes, restart enclave-tcp-relay ONLY, 2 min without restarts, the eligibility line, ~49,998
                   listeners, the canaries 200 via DNS, no refusal line
  u7-rollback-uswest.sh (FIRST), u7-rollback-code.sh (git revert on main)
NOT shown live: U7's refusal of an INELIGIBLE lease holder (no such lease exists); it rests on the U7 suites (194/194) on
the converged commit.

RESULT, 2026-09-25 (times read from the clock):
  21:59:02-10Z step 1: nan-relay ELIGIBILITY_API on tcp6-relay/udp-relay/dns (inert), the four data-plane env files 600 root
              (dns.env's DNS_TXT_KEY had been world-readable; only root has a shell or keys on nan-relay); nothing restarted.
  22:02:38Z   step 2: fast-forward main aeb345e6 -> 2144fcb3; Deploy 36194730594: jobs detect+relay only, relay=true only,
              data plane nan-relay only (not us-west).
  22:06:18Z   step 3 run 1 FAILED on a SCRIPT bug (Codex found it): `grep -c ... || echo 0` printed "0" twice, a false "U7:
              closed repeatedly"; every other check passed, and ADMIT=79c5ecf2 accept.sh passed. The narrow fix (fetch the
              journal first, count locally, only grep's no-match exit excused; d1 OK) - nothing rolled back or waived.
  22:10:31Z   step 3 run 2 PASSED: nan / nan-relay on U7 (the eligibility line in tcp/tcp6/udp/dns, NOT unset; no U7 refusal
              line; the canaries 200 via nan-relay; /x/ 421 x3 + a no-lease 404; availability; us-west 200 on old code;
              accept.sh; public_ok).
  22:10:44-22:12:55Z step 4 us-west by hand: *.pre-u7 backups; fleet.mjs then relay.js (temp + mv); hashes e0cb218f /
              384a1ef1; enclave-tcp-relay restarted ONLY; up 2 min without restarts; the eligibility line; 50003
              listeners; the canaries 200 via DNS; no U7 refusal line.
  U7 is LIVE on nan, nan-relay and us-west. Rollback kept: u7-rollback-uswest.sh (FIRST), u7-rollback-code.sh.
  NOT shown live: the refusal of an INELIGIBLE lease holder (no such lease exists); it rests on the U7 suites (194/194)
  on the converged commit.

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

# Storage restore timeout correction

The original in-container `timeout -s KILL` could kill itself along with pg_restore. PostgreSQL running as container PID 1 reaped the orphaned killed process as an untracked crashed child and restarted all server sessions. The correction uses GNU `timeout --foreground` and refuses unsupported timeout implementations before creating a scratch database.

The same small source correction was applied to the production and fixture controllers. Five real-PostgreSQL diagnostic cases established the cause and session-survival behavior. The corrected fixture controller then passed eight migration stages and nine recovery checks; cleanup was confirmed. See VERIFICATION.json for exact pins, checks and limits.

No production migration occurred. Live rollout still requires bounded dump/SQL operations, fresh readiness and backup, and the reviewed recovery procedure. This package preserves the tested correction without claiming that unfinished production bounds or distributed storage rollout have passed.

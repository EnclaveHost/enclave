# Owner move recovery: tested source

Root job root-lease-deep-r2-0131 passed: 20 real-module checks, 3 candidate management regressions, 3 baseline management regressions. Zero skips, failures, cancellations or todo. Offline recording fixtures; no production move performed.

The CLI sends one release request and confirms current lease absence through two increasing validated snapshots. It rejects malformed state, polls an unknown outcome for 90 seconds, and distinguishes unknown ledger state from a held lease. A host report is not labelled locally verified. These observations are not finality or reorg proof. A full quorum outage still prevents progress safely.

Applied exact tested bytes to consumer branch in 920a5911d. Follow-up restores the CLI executable mode accidentally changed by copying staged source; no code changes in the permission correction. Existing deployments, admin controls, same-operator refusal and host transaction logic remain unchanged. Runtime source push is not a production cutover.

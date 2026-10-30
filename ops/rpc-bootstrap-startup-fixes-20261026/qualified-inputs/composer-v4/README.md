# r13-compose/v4 (50cf; PREPARED composer; status = the ACTUAL receipt in ../../../logs/claude-r13-composer-v4.md; no r13 created)
= v3 (frozen; root run 0837: 18 ran, 1 ERROR in the cross-overlay FIXTURE) + alias_nodes() factored out so compose() and the regression
use the SAME alias code, the fixture applying the wrapper through the production overlay path, and a new negative test (omitted alias /
wrong count / double alias refuse). No other behavior change; same INPUT-CONTRACT formats. 19 tests. v1/v2/v3 kept frozen.

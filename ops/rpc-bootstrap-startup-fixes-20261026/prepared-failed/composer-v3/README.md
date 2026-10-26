# r13-compose/v3 (50cf; PREPARED composer; UNTESTED until root's focused-test receipt is rc 0; no r13 created)
Supersedes v2 (frozen, historical) and v1 (frozen, historical). compose_r13.py v3 = r12-final + wrapper overlay + wiring overlay + cold readers
(last), with the pin-graph engine. v3 changes: EXTERNAL root-authored qualification (no self-hash cycle), the wrapper-pruned-identity overlay
(required for a non-dry compose), current-exact-base overlay stacking, and cross-overlay base pins mapped and re-pinned.
INPUT-CONTRACT.md = schemas, rules and canonical root commands. tests/test_compose_engine.py = 18 offline tests (NOT yet run: the queue
attempt in logs/ returned 98 NOT STARTED, held by another job). Report: ../../../logs/claude-r13-composer-v3.md

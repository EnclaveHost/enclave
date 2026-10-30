# Browser migration review checkpoint

NOT deployable. This directory preserves the exact source snapshot tested on October 28 at 17:09 UTC, plus root failure evidence. Original eight scripted tests passed; independent root receipt tests passed one and failed five, with no skips. The review also identifies missing resumable execution, incomplete field verification and UI owner-control coupling. Repairs are being authored separately; none is implied here.

Import paths and prepare.py refer to the original isolated staging layout; they are retained verbatim for source provenance, not a portable package or an installation command. Do not execute prepare.py from this directory. Source snapshot hashes are in SNAPSHOT.json. No production relay/client modification, session termination, signing or fund movement occurred.

The original contract refunds the terminated session to its owner wallet. The earlier withdrawal-based migration proposal was incorrect. A candidate replacement legacy29 + gas1 sequence reuses that refund, pending full review and explicit new owner signatures. No candidate grant has been offered for signing. Four additive deployment-only transactions have a separate reviewed wallet handoff; they do not authorize migration.

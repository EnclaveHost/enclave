# Actual readonly L1 identity observation

Invocation6a5530b0d7664aa4a57874440d1ce9cf terminal0; all content/external pins unchanged, recorded inner scope and every owned exporter/tunnel PID gone. No live PID identity was captured before completion; none fabricated. Independent remote cleanup/module unload passed, original untouched, private COW retained.

Actual EL data/db/static/tmp ownership UID997/GID987; CL cl/beacon/chain_db/tmp-cl UID995/GID986. Both0750 directories, TOML0640, MDBX0644. Anchor root0:0/0755. Guest /etc/passwd has no accounts for997/995/50001/50002; /etc/group has none for987/986/50001/50002. Bounded160-process public UID census found no matching UID process. No accounts/groups were created or modified.

These observations allow preparation of dedicated unprivileged accounts preserving existing filesystem ownership. Fresh preflight must reject name/UID/GID/process collisions before creation. Candidate shared JWT group50002 was unused; actual future use needs same fresh checks and private root-owned0640 secret. No recursive chown, root client fallback, world-readable secrets, or claim of native client/parser/memory qualification.

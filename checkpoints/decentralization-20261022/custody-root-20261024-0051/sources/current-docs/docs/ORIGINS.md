# Origins of docs/security/ in this repository

The first commit holds the two files exactly as they are on the pushed checkpoint branch
`checkpoint/decentralization-20261022` at **dfb4b55e627ebd95b647abebf09627296f099862**:

| file | blob at dfb4b55e | blob at main 68b82926 |
|---|---|---|
| `docs/security/secret-custody-v2.md` | `393f9d31070e3b5f44580689c4a95bff91a3a4d5` | `6e933b8e6ba7244520a59f2b965fa166b1073b52` |
| `docs/security/secret-custody-v2-spec.md` | `fee422be923dace1e3acfb39bc10cc71db0ea369` | `ae96f2a4ff676d73ed09add0574752415801a6f4` |

- The checkpoint versions are main's plus a9f8ba52c, aa836ea3b and 4bd0e31c0. These are source proposals for a NEW vault, not the
  deployed one.
- They are identical to the custody-v2-dashboard base ff13ebe08.
- The second commit applies, unchanged, the already-reviewed doc commits 2d3839c54 and 9d97b4b00 of
  `custody-v2-dashboard-20261023/repo`, preserved in checkpoint dfb4b55e (frozen-2100 dashboard3). It gives
  `secret-custody-v2.md` blob `de1dce4b8c4252a3999bcf20f733bf674c3e3b97`.
- Later commits are this repository's reconciliation, and `patches/` holds them as `git format-patch` output.

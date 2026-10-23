# Rebuilding the frozen-0745 commits

| side | base | how to obtain the base |
|---|---|---|
| d-linux-carrier-fad657bc | fec43a6a | frozen-0630-export/d-linux-fec43a6a (on 493ee9ee, an ancestor of the pushed `candidate/decentralized-control-20261022`) |
| s-holder-final-47c2f71f | f6de2364 | frozen-0630-export/s-holder-f6de2364 (root commit series) |
| root-wallet-fix-320d7e9f, root-cache-budget-08fffd5a | none (root commits) | `git am` into an empty repository |

`../verify-frozen-0745-export.py` applies every series offline and writes `REPRODUCE-CHECK.txt`. In d-linux-carrier, commits
4-17 are `cherry-pick -x` of root's admin-CLI 0eac0d60b/dfe020abf, A dfe020abf..71448f63, B 62feb3aa/8d110101 and ROOT fd6a1762
(their messages carry the original ids). ROOT dc767fc3 (doc-only, on 47c2f71f) is content-only:
`../frozen-0745-dc767fc3-doc-correction.txt`.

# LAB streaming cancellation on the Pixel 10, after the page fix (2026-09-24 01:37-01:41)

This re-runs the one failed check of results/pvm-cpu-streaming. There, the page cancelled at 4 tokens but consumed a
5th, which arrived in the same authenticated chunk. The fix is in web/pvm-client.js: no line is consumed after the page
cancels. Build rt14 is unchanged; only the page's code changed. `ONLY=cancel cpu/app-stream-run.sh` ->
`check-app-stream.py --cancel`: **PASS**, 13 checks (check.txt).

| cancel at | page consumed | chunks opened | the VM | the next stream (8 tokens) |
|---|---|---|---|---|
| 1 of 200 tokens | 1 token, `cancelled` | 1 | `cancelled after 2 chunks` | first token at 1247 ms, complete |
| 4 of 200 | 4 | 3 | `cancelled after 4 chunks` | 1189 ms, complete |
| 10 of 200 | 10 | 6 | `cancelled after 7 chunks` | 1111 ms, complete |

A decode that kept going after a cancel would have held the VM, which serves one connection at a time, for about
15-20 s. Each next stream got its first token in about 1.2 s, so the guest's decode had stopped: its blocking write
failed when the page went away. No request or token appears in the Android capture (pvm-rt's notes decoded), the hub or
the site. Logs were normalized after capture (trailing spaces only).

# EL r8 journal byte decoding — source preparation only

Derived from root-qualified `rpc-control-vm-l1-client-root-r7-repaired-r2`. This separate candidate has nonce `13adb8b1-d469-4e0d-923b-0582681c9d37` and r8 service, slice, socket, upload, mount, runtime, output and admission namespaces. Existing r7 and Nan n8 are untouched. No candidate execution, tests, syntax checking, assembly, author-model calls, image access, remote calls, native launch or finance occurred in this preparation lane. Root owns review, execution, source integration and production activation.

## Confirmed failure and narrow correction

Root read `3ea2d696a0f04cbfa987e9dcf8f4f1fa` completed successfully. Its `rpc-el-r7-journal-bytes-read-r1/RESULT.json` contains 33 records, 27 with the exact client invocation and 26 byte-array MESSAGE fields. Strict UTF-8 decoding recovers fixed labels that the prior string-only parser skipped. The r7 trial stopped at its 600-second semantic limit despite ongoing I/O and actual recovery messages. This was not evidence of a stalled database or a missing invocation ID. The root read's 17 fixed-label matches include diagnostic labels outside the runtime recovery allowlist; they are not 17 new runtime semantic identities.

`recovery-progress.py` now accepts a flat MESSAGE list only when its length is at most 8192 and every element has exact Python type int in 0..255. It decodes the resulting bytes with strict UTF-8. Malformed types, nested/multiple-value arrays, bools, out-of-range values and invalid UTF-8 earn no progress credit. Existing string handling, ANSI stripping, fixed labels, numeric fields and stage extraction then apply. The exact `_SYSTEMD_INVOCATION_ID` query and assertion are unchanged. No identity fallback, `--all`, lossy decoding, broader message retention or expanded capture is introduced.

The behavior follows journalctl JSON encoding: nonprintable fields (including ANSI ESC) are byte arrays; duplicate fields may also be arrays, and oversized fields may be null. References: https://www.freedesktop.org/software/systemd/man/latest/journalctl.html and systemd v255 `src/shared/logs-show.c` `update_json_data()` at https://raw.githubusercontent.com/systemd/systemd/v255/src/shared/logs-show.c .

## Exact evidence and proposed regressions

`fixtures/ROOT-OBSERVED-BYTE-FIXTURES.json` is copied byte-for-byte from the root-provided fixture: storage-history healing and MerkleUnwind with trusted journal metadata. Root reconstructed these from retained same-invocation cat output and matched their SHA256 to the independently decoded native records. `fixtures/observed-journal-bytes.json` additionally includes exact hash-matched storage/account phase and batch records (five total). `fixtures/PROVENANCE.json` pins all inputs. No observed text was invented or silently edited to r8; fixture r7 identities are historical evidence, not new admission metadata.

The source defines 15 new regression methods alongside 44 inherited methods. They cover actual byte-array markers and plain-text equivalence, exact hashes, wrong/missing invocation, malformed scalar/list values, invalid UTF-8, byte-length boundary, multibyte text, unknown text, replay without timer reset, exact sampler query/caps and truncated capture refusal. These are unexecuted definitions, not passing results. Root also retains inherited check-runtime RPC and own-process checks.

## Storage, resources and timing unchanged

The new writable child is `/vm/enclave-volumes/rpc-control-l1-client-r8/overlay.qcow2`, backed only by the existing frozen r6, then the immutable original. The retained r7 child is not used. Preserve both backing identity checks, QEMU-compatible read-only denial locks, full frozen-r6 hashes before and after, exact three-layer validation and independent cleanup. No clean database or skipped recovery claim is made.

EL 2304 MiB, attach 128 MiB, guardian 128 MiB, zero swap; original OS/service growth accounting and worker profile remain. Preserve private-child 7 GiB stop/8 GiB hard limit, /vm 300 GB free floor and evidence caps. Same binary, pruning/history/proof/cache flags, existing users/groups, proposed TOML and account provenance. Namespace-only wrapper changes do not change its client behavior.

No-work 300 seconds, new-semantic 600 seconds, observation 900 seconds and outer 1800 seconds remain. Every 2-second sample, at most 451 rows/1 MiB history; every 10-second diagnostic, at most 91; journal 256 rows/131072 bytes/4 seconds; semantic identity set at most 512. Nominal sequential envelope remains 90+1365+145+30+30+20+10+5=1695 seconds. STOP-reason race correction from repaired-r2 is retained.

## Root execution sequence

Root reviews/tests source, runs pure assembler and runtime checks, commits/pushes immutable source/runtime, then performs a new independent resource/timer observation. The candidate contains no copied runtime, successful results, root authority or fresh-observation receipt. It preserves the separate `fresh-read.py` workflow. Root exclusively writes the new runtime admission with scope `actual-l1-el-only-bounded-client-r8`, actual runtime pins SHA, current approval time, reviewedHorizonSeconds=1800 and SHA of exact fresh observation. Observe the inherited boot, <=90-second observation age and full resource commitments. Do not reuse r7 authority. Root determines sequential scheduling with the active Nan n8 trial.

A successful EL RPC response would still be startup evidence only. Paired EL/CL synchronization, blob availability, Base coverage and production cutover remain separate required gates. No automatic retry or promotion is authorized by this artifact.

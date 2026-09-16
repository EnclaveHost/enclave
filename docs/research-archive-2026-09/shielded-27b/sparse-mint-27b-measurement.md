# Actual 27B CPU pad-generation comparison — 8 September 2026

The standalone sparse format generated the requested pads in **4.52 seconds median**, versus **5.54 seconds** for the existing rectangular format: **18.4% less elapsed time** in this three-pair comparison. Both used 16 CPU threads and the existing balanced scheduler after one shared model registration.

| Measurement | Sparse v3 | Rectangular v2 |
|---|---:|---:|
| Median elapsed generation time | 4.522 s | 5.543 s |
| Median aggregate CPU time | 55.607 s | 78.228 s |
| Shipment file size | 1,041,281,024 bytes | 1,415,801,344 bytes |
| Generated cells | 20,992 | 29,344 |

This uses the actual Qwen3.8 27B Q8 weights and all 262 registered groups / 409 members, including MTP. The demand is deliberately synthetic: every third canonical group requests 112 rows, and the others request 64. The resulting **26.5% file reduction** follows that demand; it is not a measured MTP schedule or a forecast of typical savings.

All 20,992 requested cells—346,972,160 field values—were decrypted, authenticated and compared against independently opened v2 cells in the first pair. Every value matched. The model, calibration and executable identity checks passed; recorded asset statistics stayed unchanged during the run. Model registration took 20.00 seconds, excluded from generation timing. The three pairs alternated format order; the result remains a small local comparison, not a precise long-term performance estimate.

This API is not yet connected to the phone consumer or live dealer. The test measures CPU pad generation, not inference or tokens per second. Reordered registration and failures are covered by separate sanitizer fixtures; this actual-model comparison used the same registration order for both formats.

[Structured measurements and evidence hashes](/home/steven/Documents/Codex/2026-09-07/i-w/outputs/sparse-mint-27b-evidence.json).

A subsequent implementation sizes working buffers for each CPU lane’s assigned groups. The actual 27B comparison passed again with a **128 MiB aggregate mint-scratch cap**, preserving the same file sizes and equality of all 20,992 requested cells. This cap excludes bounded public metadata and the already loaded model. That later run overlapped another CPU build, so its timings are **not accepted for performance claims**. The table above remains the earlier separate comparison.

# Root review of evidence scanner findings

The 20:23 UTC staged evidence scan reported four `generic-api-key` matches, all the `encKey` field of the same disposable custodian's **public** X25519 encryption key. The value is served by `/v2/custody/info` and bound into the verified AMD report. It is not a private key or bearer credential. The four occurrences are the fresh/reopen machine records in `result.json` and the two verifier verdicts. Keeping those public records supports the same-key recovery claim.

Root inspected all four reported locations and their source. No scanner configuration or allowlist was changed. Raw quotes, guest console logs, private configuration, sealed bytes and signing keys are excluded. The cryptographic-private-key scan is a separate check. This review does not waive findings in any other file.

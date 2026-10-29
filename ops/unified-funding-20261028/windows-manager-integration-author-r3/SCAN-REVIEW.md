# Confirmed secret-scan false positive

The pre-push provider-token scanner reported one twilio-api-key match in ROOT-REVIEW.md at commit53e70f549f88cf3656ebeae11019bd9a69538ede. It matched the last two letters of the word TASK concatenated with the following SHA256 checksum. Root independently computed that checksum from the reviewed public task text; it equals the TASK.txt value in PREPARED.json. It is not a credential. Both crypto-key scanners passed. The current prose separates the label and checksum; prior evidence history is retained.

The repository's .githooks/pre-push explicitly permits a confirmed false-positive push using --no-verify with the reason recorded in a commit. This is that record; the scanner configuration and detection rules remain unchanged. The full outgoing range is scanned before using that documented exception, and any other finding must be resolved separately.

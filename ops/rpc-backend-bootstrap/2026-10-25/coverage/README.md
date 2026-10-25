# Historical coverage validation candidate

Source and recorded offline tests for the deployment-specific gate. Start with RESULT.md. The job scripts retain the original workstation paths and pinned cached toolchain locations; adapt those paths explicitly when reproducing elsewhere. No binary is committed. The pinned kzgcheck binary was built offline and requires GLIBC2.34 or later; the actual guest execution remains to be verified.

24 tests passed, with genuine KZG/transaction/receipt-root fixtures. The real pinned Base inspection command worked against a read-only genesis database and correctly refused its empty deposit body. Neither real snapshot extraction nor historical mainnet coverage has passed yet. This helper never writes coverageVerified or activates a client. Root review remains mandatory before applying its proposed fields; the unsafe-tip alternative is not eligible for automatic activation.

The root-owned operator procedure fixes the staging report's output-permissions mistake: rpcbase writes its result into a dedicated owned output directory, then root copies the result for review. Scratch is outside the read-only snapshot. Run live validation within explicit memory/CPU limits and retain the verdict, client and snapshot pins before activation.

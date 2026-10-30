# Gas-execution recovery review — October 28, 20:53 UTC

Root review supersedes AUTHOR-REPORT and preliminary findings. No production install, signing, broadcast or movement of the existing30USDC.

## Result

**25 offline checks PASS, zero skips**, followed by **one actual native HTTP fault test PASS, zero skips**. The native test runs both dropped-response-body and HTTP502-after-processing cases through real HTTP, nativeP256, one real TxQueue and owned Anvil8453. Each case proves exactlyone actual mock-USDC debit and read-only chain reconciliation without a new POST/signature. A request that never reaches the relay stays UNKNOWN and blocks further spending. Native storage is MemoryV2Store, not browser IndexedDB. MockUSDC/DEX/fixedfee/publicfixture keys are not production policy or wallet qualification.

The original three r4 regressions are preserved: lost body and502 mislabeled refused; no exact durable call. The successor persists public bound intent before dispatch, uses CAS, classifies ambiguous outcomes conservatively, and checks exact target/call/nonce/receipt/logs/finality through unchanged proof code. Six original portable dependency files are unchanged; preparation rewrites only six import specifiers with a reverse-equality check. Current actual-page Chromium qualification elsewhere uses the OLD r4 core; **the successor page remains to be integrated and browser-qualified**.

## Root findings and narrow fixes

Frozen independent snapshot initially ran21 checks:19PASS/2FAIL/0skip. One demonstrated defect: intent_conflict was in the definitive-refusal allowlist, despite the actual relay saying an earlier reservation for different signed terms exists and requires reconciliation. Root removed that one code; the new test now keeps UNKNOWN and its hold. Original module preserved under root-original, failed snapshot and logs retained.

The other initial test failed in EXISTING validateGasRecord(record_id), before a second confirmation: a duplicate id for the same key cannot be stored. It did NOT demonstrate a bypass or duplicate debit. Root corrected that test to assert the existing rejection and retained hold; no record/key validation or record filtering changed. Earlier commentary/preliminary inspection was corrected explicitly. Do not report it as a confirmed product bug.

Root also fixed the native generator's false-positive match against the existing no-code-size-override refusal guard. The exact guard must remain once, all other bytes remain scanned, reversible edits remain required. Test cleanup is registered before startServer, so startup failure still cleans the owned child. No native limit/security bypass.

## Builds and evidence

Portable preparation PASS and actual vendor bundle PASS356046B SHA5b0ee6c8b0f2c819c1d4de78553ec5226afa6502d385c26ebe2b3052e0d81c60. Manifest6316bb23f0a1255a2151107ccf75f36c3c8b4945cc79d8c716793d6f9d2d31ac. Derived fault server SHA d1378f691666c85f0cabca4f4b2bb6bd0fed98c88e78808d68c4f150570164cd passed syntax and native execution. The unchanged builder checks original exports; adding explicit recovery exports to the actual integration builder remains in the follow-up.

Offline tests used256MiB/220RSS/floor27648MiB/oneCPU/noSwap, outer peak179MiB. Native768MiB/700RSS/floor27648MiB/oneCPU/noSwap, outer peak361MiB. Owned server/Anvil cleaned; no active test job remains. Existing production services untouched.

Native and staged tests depend on pinned sibling fixture paths, not standalone from this evidence package. prepared/sdk/funding is the portable client source (viem dependency still required). Compiled vendor bundle omitted; build manifest included. Original artifacts and test failure bytes retained. The page patch remains instructions only; no production activation or new grant is available from this package.

## Important limits

Unknown/nohash with no chain evidence remains blocked; reverted signatures remain blocked; indirect transactions cannot be fully bound; bounded discovery examines at most600 blocks/16 candidates. Relay allowlisted pre-admission refusal assertions remain a trust assumption. Successful non-final observations block another payment until explicit reconciliation proves finality; Base latency/UX is not measured here. Finalized proof trust/caching policy and full production activation still need review; local Anvil epoch1 is a fixture, not Base finality qualification. Owner/end/open paths remain their earlier implementations; no broad classification changes were made.

Fresh readonly observation: all3 providers agreed block53215616, oldsession live30USDC/spent0, ownernonce1175, first library no code. This does NOT prove rejection of the UNKNOWN MetaMask request. Journal seq5 remains pending/nohash, helper expired; do not resend/reset. No prior confirmed funding may be repeated.

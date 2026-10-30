# Root review — wallet migration reader r4

Production census failed because Azul returned no transaction by hash for the ledger creation, while its canonical receipt and indexed block transaction were available. API/Blast direct-hash witnesses and Azul indexed witnesses agreed on the transaction and exact creation input.

One product file changes the reader to recover a missing hash lookup through the SAME provider receipt and block-hash/index lookup. Receipt, block, index, transaction hash/height and canonical block anchor must match. Transport errors, mismatches and reorgs fail closed. Provider quorum, custody policy, owner operation journal and signing rules are unchanged.

Original positive regression failed as expected and is retained. Repaired suite: 76 PASS, 0 FAIL, no skipped/cancelled tests (original 60 plus 16 regressions). Unit b64684552d504254ae9a55cc248ae4fb is terminal/Main0; temporary test directories gone. Actual shipped sessions SDK with repaired reader independently read the same ledger creation from API and Azul; no signature or transaction was sent. Initial small-lane admission was rejected without starting work and retained.

Site build invocation 6bc4696990db4ef083816cad963a4d26 completed under 512 MiB hard / 450 MiB RSS / 27648 MiB available floor / CPU1 / no swap / shared queue and network namespace. New CID bafybeigpmrrdbibmlqiljg5v6a5bnstuv36ovixm7vbuxsala2hhhu2mea, 1490 files: all 1409 non-boot base files preserved, only boot replaced, 80 new files. CAR roundtrip passed. Existing qr.js module-format warning retained. Failed capture used a stale base CID and stopped read-only; corrected capture verified all 1410 current files on all four edges. No production activation yet.

This fixes reader availability, not the remaining old runner lease/release/reserve migration gap. DNS and KVM refunds must not repeat; a62 release must not replay. Future wallet-create r2 delivery is preserved separately as UNVALIDATED.

## Production activation

Invocation350a05fde057405f8f267669423700d0 is terminal success/Main0. All four apex edge roots now serve the new CID. 87 normal TLS HTTPS file hash checks per edge,348 total PASS. No backend restart, signing, refund or funding. Do not rerun completed activation helpers. Browser verification follows separately.


## October30 05:02UTC: fresh875 review qualified and external signature requested ONCE

Actual browser2/tab723101089 productionreader-r4 completed census; creationwitness failure fixed. Initial875snapshotstale afterlonghistoryread; root clicked ONLY875 Checkagain ONCE, fresh eligibility53273526/hash17923cc93286d7d48d94f59ec5409dcb36b591bf7712f4ede8b8a4d75f2dd97d. Review shows complete1delegation/24sessions(1live), fixedB794->0b2wallet,zeroUSDCretained,sameID/version/config/ports,no newdelegation. Root openedreviewthenSignreleaseONCE underhumanpriorinitiate-signaturesinstruction. UI now Check your wallet (one Release signature,then one relay submission). No actualwalletapproval/signature/tx/ownerchange yetobserved. Finalexternalwalletapproval musthuman. Neverrepeat/reload/clearjournal whilepending. Samecurrenttab+KVMstoppedtab723101090 markedhandoff.

Publicreview/statusDOM wallet-875-sign-request-20261030.txt retained. Screenshotreturnedblank; retainedasfailedcapture, NOTproof and notshownasapprovalimage. A62actualfinalityconfirmedindependentlypreviousrecord; no replay. Cab8unsigned; DNS/KVM bothrefunded/inactive butleases/escrow/reserves stillblocktransfer. No newfunding. Allreader/failure/finalitysource+evidence through4c37b05f7fdfa7a7e23752a07abf2859fea9feb6 PUSHED/exactremote/S previouslyclean; thisbrowserpreservationfollows. Noactiveauthor/test/build/remotejob.

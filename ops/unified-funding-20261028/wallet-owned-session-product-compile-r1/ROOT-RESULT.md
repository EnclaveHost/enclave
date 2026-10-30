# Root result: product compile and size pass, untested

The one isolated invocation `64bbbe283bea4e2899b84f711063840b` completed with compiler exit 0 in 2.416 seconds. All 17 input pins remain unchanged. The unit is inactive, MainPID=0 and no stage process remains. Inner guard peak 109 MiB, minimum available 31712 MiB; the same 512 MiB hard / 450 MiB RSS / 27648 MiB floor / CPU1 / no-swap limits held.

| Contract | Runtime bytes | Initcode including constructor |
|---|---:|---:|
| WalletSessionVault | 22039 | 22701 |
| WalletSessionVaultFactory | 2622 | 25809 |
| SessionVaultLib | 10681 | 10713 |

All requested runtimes fit 24576 bytes and initcodes fit 49152 bytes. Library references remain unresolved and recorded; no production address was substituted. Three compiler warnings (future keyword, declaration shadowing and contract comparison deprecation) are preserved in RESULT.json. No tests or deployment occurred. Native compiler output is not proof of equivalence to deployed Emscripten artifacts.

The failed broad Foundry attempt remains preserved. Existing Node result remains 7 passes / 3 root failures. Omitted-factory policy bypass, chain-cache identity, owner-controlled policy binding, final secret-release checks, and actual SDK/open/host construction still require repair and tests. This compile does not migrate old funded backing or change any app owner. Browser reviews remain handed to the human; no signature or financial operation was attempted.

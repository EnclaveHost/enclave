# Smaller product-only compilation preparation

PREPARED ONLY. No compiler, author, test, network/RPC, signature, finance or production operation has been executed. This is a separately reviewed smaller input, not an automatic retry or cap increase. The failed Foundry stage and all its evidence remain untouched.

## Why this is smaller

Only three complete byte-identical frozen files are supplied as standard-JSON content: contracts/WalletSessionVault.sol, contracts/WalletSessionPolicy.sol and contracts/SessionVault.sol (104410 bytes total). The last file is the unchanged source-verified legacy v2 library/interfaces source. No interface or library extraction, stripping, flattening, rewrite or replacement occurred. Imports resolve using original contracts/... unit paths.

outputSelection requests bytecode/ABI/metadata/links/immutable locations only for new WalletSessionVault, new WalletSessionVaultFactory and required existing SessionVaultLib. WalletSessionPolicy gets ABI only because its internal functions are inlined. Old vault/factory codegen, all ledger versions, Foundry, forge-std and tests are omitted. The entire legacy source still participates in parsing/type checking; requested output selection limits generation work but is not a measured memory guarantee.

## Settings and safety boundaries

Pinned native solc0.8.35 `--standard-json`, optimizer enabled/runs1, viaIR, explicit Osaka, explicit IPFS metadata hash. These retain the prior harness settings; deployed-source map records optimizer1/viaIR and Emscripten0.8.35 but leaves evmVersion unset. Native/Emscripten/full runtime/CBOR equivalence is not claimed. Source names and unresolved library links remain visible in result; no fake production address or runtime replacement is supplied.

Compile stdout/stderr stream directly into files; no subprocess capture buffer. Only complete JSON diagnostics and selected outputs are parsed afterward. Runtime limit24576 and initcode49152 are checked including factory5*32/executor6*32 constructor words; library has no constructor words. Link placeholders have the same byte length as linked addresses; unresolved links are recorded. The factory embeds the implementation creation code. Size pass is not permission to deploy or evidence that calls/policy work.

Same limits:512MiB hard,450MiB RSS,availablefloor27648MiB,CPU1,noSwap,shared queue. Isolated network namespace with minimal environment; no Forge, FFI, RPC, private keys, imports-by-URL, compiler download, code-size override or tests. Compiler600sec;outer900sec includes queue/admission. No automated retry or cap raise. Root must compare recorded host network namespace before launch; runner verifies a different namespace after reviewed unshare wrapper. PID1 namespace is unreadable to this user, so it is not used as a false gate.

Root must review PREPARED/task/source/runner/pins and create root-compile-approval.json with launchAuthorized=true and exact preparedSha256. This file is absent. One exclusive attempt.json prevents accidental rerun. Source, compiler, guards and old failure evidence hashes are checked; content in compiler-input must equal copied source with no URL fields. Temporary directory private; compile cwd empty. Owned compiler process group is killed on timeout/exit; root must still confirm unit/cgroup terminal before more work. On memory stop RESULT may remain STARTED or absent; neither is success.

The prior failure was invocationc8ae998b3b28482aa5cfcbc0196cb241: outer526MiB RSS stop at512cap, only "Compiling33files"; no size result, no tests. No inference about compilation correctness follows. Test/consumer/SDK/policy discovery and funded-app migration blockers remain separate and unresolved.

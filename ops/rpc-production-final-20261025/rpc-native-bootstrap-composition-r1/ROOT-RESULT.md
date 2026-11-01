# R1 four native composition cases passed; observer-loss case failed

Hosted run41318351499 terminal failure, exactsourcec48a3277a390530c0e3d28d2bc83d39aa7ec8e3f.
All four compilesPASS: production1933ms,fixture230ms,actor140ms,controller216ms.
ActualSYSTEMnativebridge normal PASS (5externalpreheldhandles, acquisitionrequested
andexactdeath);wrong-source/wrong-key PASS beforeintent/nativechannels/Node/TPM
creation; malformedpipe PASS with5preheldprocesses. Actualcontroller resultelapsed
2051/1381/1239/1421ms. These are fixture hardware/Node, not TPM/VM/realNode proof.
Observer-loss controller exited1 after1337ms. Its653B output was not preserved:
PowerShell artifact filename expression joined suffixes incorrectly; success-only
case-results also omitted failed result. Exact process-results and failedjoblog
retained. Do not infer the missing error or call observer-loss PASS. BlockedTPM
andblockedmonitor cases were NOT executed.

Source review independently found a concrete race in fixture.blocked publication:
file became visible before flush/close, while controller opens it with a sharing
mode incompatible with the active writer. This is a plausible cause, NOT proven
from the missing output. Correction changes only dummy fixture markers to
pending+fsync+close+atomicrename; production runtime and controller unchanged.
Artifact collection corrected with parenthesized filenames and failedresult capture.
R2 will use same independentlyrehashed production/controller binaries, compileonly
changedfixture/actor, runONLY observer-loss plus2previouslyunexecuted blockedcases.
No cap/floor/window relaxation or unchanged successful/nativecase replay.

All4artifact binaries independentlyrehashed againstmanifest;all8compiledsourcepins
match reviewed closure. Binary sizes and hashes are recorded from the actual artifacts. OriginalproductionSHA ddadd678d65dff7c7f779831d212f2b10d341f181bd1dc748956932b4782f4cb.
ControllerSHA edb2493f82d4f31294189b720e8cbdd9a268cf31d87a4fec8b141b0ed1408241.
Binaries local/CIonly,notGit; no private keys or targetmutation. Original8091 and
Windows5a ambiguity untouched. RPC OFFLINE/goal ACTIVE, fullnativehardware/owner/
guest/export/currentownership/admission/acceptedimage/roots/sync/finality unproven.
